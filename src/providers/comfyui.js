import { randomInt, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getUserConfigPath } from "../config.js";
import { normalizeSize } from "../util/common.js";
import { safeParseMessage } from "../util/redact.js";
import { apiRequest, deadline, imageResult, jsonPost, multipartImage, pollDelay, providerError, requireMaskImage } from "./image-api.js";

const id = "comfyui";
const defaultModel = "flux1-schnell.safetensors";
const node = (class_type, inputs) => ({ class_type, inputs });

function fluxWorkflow({ prompt, model, seed, width, height }, cfg) {
  return {
    1: node("UNETLoader", { unet_name: model, weight_dtype: "default" }),
    2: node("DualCLIPLoader", { clip_name1: cfg?.clip || "clip_l.safetensors", clip_name2: cfg?.t5 || "t5xxl_fp8_e4m3fn.safetensors", type: "flux" }),
    3: node("VAELoader", { vae_name: cfg?.vae || "ae.safetensors" }),
    4: node("CLIPTextEncode", { text: prompt, clip: ["2", 0] }),
    5: node("EmptySD3LatentImage", { width, height, batch_size: 1 }),
    6: node("KSampler", { model: ["1", 0], positive: ["4", 0], negative: ["4", 0], latent_image: ["5", 0], seed, steps: 4, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 }),
    7: node("VAEDecode", { samples: ["6", 0], vae: ["3", 0] }),
    8: node("SaveImage", { images: ["7", 0], filename_prefix: "brushrouter" }),
  };
}

function loadWorkflow(path) {
  const file = resolve(dirname(resolve(getUserConfigPath())), path);
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw providerError("BAD_WORKFLOW", "ComfyUI workflow must be a regular JSON file up to 2 MB");
  let graph;
  try {
    graph = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw providerError("BAD_WORKFLOW", `cannot read ComfyUI workflow: ${safeParseMessage(error)}`);
  }
  if (!graph || Array.isArray(graph) || typeof graph !== "object" || !Object.values(graph).length ||
      !Object.values(graph).every((entry) => entry && typeof entry.class_type === "string" && entry.inputs && typeof entry.inputs === "object")) {
    throw providerError("BAD_WORKFLOW", "ComfyUI workflow must be exported in API format (node IDs mapped to class_type and inputs)");
  }
  return graph;
}

const tokens = /\{(prompt|seed|size|width|height|model|image(?:[1-9]\d*)?|mask)\}/g;

function fillWorkflow(value, params, seen) {
  if (Array.isArray(value)) return value.map((entry) => fillWorkflow(entry, params, seen));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fillWorkflow(entry, params, seen)]));
  }
  if (typeof value !== "string") return value;
  const filled = value.replace(tokens, (token, name) => {
    if (!Object.hasOwn(params, name)) throw providerError("BAD_WORKFLOW", `ComfyUI workflow needs a value for ${token}`);
    seen.add(name);
    return params[name];
  });
  return /^\{(?:seed|width|height)\}$/.test(value) ? params[value.slice(1, -1)] : filled;
}

function endpoint(cfg) {
  return (cfg?.baseUrl || "http://127.0.0.1:8188").replace(/\/+$/, "");
}

export const comfyUIProvider = {
  id,
  label: "Local Flux / ComfyUI",
  kind: "local",
  note: "Uses a running ComfyUI server and its local model files.",
  supportsImages: true,
  supportsMask: true,
  async probe(cfg) {
    try {
      await apiRequest(id, `${endpoint(cfg)}/system_stats`, {}, Math.min(Number(cfg?.timeoutMs) || 2500, 2500));
      return { available: true, auth: "not-required", detail: "ComfyUI is reachable" };
    } catch (err) {
      return { available: false, auth: "unreachable", detail: `ComfyUI is not reachable: ${err.message}` };
    }
  },
  async generate({ prompt, size, seed: requestedSeed, images = [], mask, cwd, model: requestedModel, onProgress }, cfg) {
    requireMaskImage(mask, images);
    if (requestedSeed != null && (!Number.isSafeInteger(requestedSeed) || requestedSeed < 0)) {
      throw providerError("BAD_SEED", "ComfyUI seed must be a non-negative safe integer");
    }
    const base = endpoint(cfg);
    const remaining = deadline(cfg, 300000);
    const model = requestedModel || cfg?.model || defaultModel;
    const dimensions = normalizeSize(size);
    const width = dimensions?.width || 1024;
    const height = dimensions?.height || 1024;
    const params = { prompt, model, width, height, size: `${width}x${height}`, seed: requestedSeed ?? randomInt(2 ** 32) };
    let graph;
    let usedModel = model;
    let usedSeed = params.seed;
    if (cfg?.workflow) {
      const template = loadWorkflow(cfg.workflow);
      const placeholders = { ...params, ...Object.fromEntries(images.map((_, i) => [`image${i + 1}`, ""])), ...(images.length && { image: "" }), ...(mask && { mask: "" }) };
      const seen = new Set();
      fillWorkflow(template, placeholders, seen);
      if (!seen.has("model")) {
        if (requestedModel) throw providerError("BAD_WORKFLOW", "ComfyUI workflow needs a {model} placeholder to override its model");
        usedModel = undefined;
      }
      if (!seen.has("seed")) {
        if (requestedSeed != null) throw providerError("BAD_WORKFLOW", "ComfyUI workflow needs a {seed} placeholder to override its seed");
        usedSeed = undefined;
      }
      if (!seen.has("prompt") || (mask && !seen.has("mask")) || images.some((_, i) => !seen.has(`image${i + 1}`) && !(i === 0 && seen.has("image")))) {
        throw providerError("BAD_WORKFLOW", "ComfyUI workflow must consume {prompt}, every supplied reference ({image}, {image2}, …), and {mask} when supplied");
      }
      const uploads = images.map((path) => multipartImage(path, cwd));
      const maskUpload = mask && multipartImage(mask, cwd);
      async function upload({ blob, extension }) {
        const form = new FormData();
        form.append("image", blob, `brushrouter-${randomUUID()}.${extension}`);
        form.append("type", "input");
        const response = await apiRequest(id, `${base}/upload/image`, { method: "POST", body: form }, remaining());
        if (!response?.name || typeof response.name !== "string") throw providerError("BAD_RESPONSE", "ComfyUI upload returned no filename");
        return response.subfolder ? `${response.subfolder}/${response.name}` : response.name;
      }
      for (const [i, file] of uploads.entries()) params[`image${i + 1}`] = await upload(file);
      if (uploads.length) params.image = params.image1;
      if (maskUpload) params.mask = await upload(maskUpload);
      graph = fillWorkflow(template, params, new Set());
    } else {
      if (images.length) throw providerError("UNSUPPORTED", "ComfyUI editing requires providers.comfyui.workflow with reference and mask placeholders");
      graph = fluxWorkflow(params, cfg);
    }
    onProgress?.("queuing ComfyUI workflow...", 20);
    const queued = await apiRequest(id, `${base}/prompt`, jsonPost({ prompt: graph }), remaining());
    const job = queued?.prompt_id;
    if (typeof job !== "string" || !/^[\w-]+$/.test(job)) throw providerError("BAD_RESPONSE", "ComfyUI returned no valid prompt ID");
    while (true) {
      const history = await apiRequest(id, `${base}/history/${job}`, {}, remaining());
      const record = history?.[job];
      if (record?.status?.status_str === "error") throw providerError("FAILED", "ComfyUI workflow execution failed; see the ComfyUI server log");
      const output = Object.values(record?.outputs || {}).flatMap((entry) => entry.images || [])
        .find((image) => typeof image?.filename === "string" && image.type === "output");
      if (output) {
        const query = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder || "", type: "output" });
        const buffer = await apiRequest(id, `${base}/view?${query}`, {}, remaining(), { raw: true });
        const result = imageResult(id, usedModel, buffer, { images, mask });
        if (usedSeed !== undefined) result.meta.seed = usedSeed;
        return result;
      }
      if (record?.status?.completed) throw providerError("BAD_IMAGE_PAYLOAD", "ComfyUI workflow completed without an output image; add a SaveImage node");
      await pollDelay(remaining, cfg);
    }
  },
};
