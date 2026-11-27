import { normalizeSize, readImageAsDataUrl } from "../util/common.js";
import { fetchImageToBuffer } from "./http.js";
import { apiRequest, deadline, imageResult, jsonPost, keyStatus, pollDelay, providerError, requireKey, requireMaskImage } from "./image-api.js";

const id = "replicate";
const env = "REPLICATE_API_TOKEN";
const defaultModel = "black-forest-labs/flux-schnell";

export const replicateProvider = {
  id,
  label: "Replicate",
  kind: "api-key",
  note: "Hosted predictions; configure input field names for models that edit or inpaint.",
  supportsImages: true,
  supportsMask: true,
  async probe(cfg) {
    return keyStatus(cfg, id, env);
  },
  async generate({ prompt, size, images = [], mask, cwd, model: requestedModel, onProgress }, cfg) {
    requireMaskImage(mask, images);
    const key = requireKey(cfg, id, env);
    const model = requestedModel || cfg?.model || defaultModel;
    const match = /^([\w.-]+\/[\w.-]+)(?::([a-f0-9]{64}))?$/.exec(model);
    if (!match) throw providerError("BAD_MODEL", "Replicate model must be owner/name or owner/name:<version hash>");
    const [, name, version] = match;
    const baseUrl = (cfg?.baseUrl || "https://api.replicate.com/v1").replace(/\/+$/, "");
    const headers = { Authorization: `Bearer ${key}` };
    const input = { ...cfg?.inputs, prompt };
    const dimensions = normalizeSize(size);
    if (dimensions?.width && dimensions.height) {
      if (name === defaultModel && !version) {
        const ratios = ["1:1", "16:9", "21:9", "3:2", "2:3", "4:5", "5:4", "3:4", "4:3", "9:16", "9:21"];
        const distance = (ratio) => {
          const [w, h] = ratio.split(":").map(Number);
          return Math.abs(Math.log((dimensions.width / dimensions.height) / (w / h)));
        };
        input.aspect_ratio = ratios.reduce((best, ratio) => distance(ratio) < distance(best) ? ratio : best);
      } else {
        if (cfg?.widthInput) Object.defineProperty(input, cfg.widthInput, { value: dimensions.width, enumerable: true, configurable: true });
        if (cfg?.heightInput) Object.defineProperty(input, cfg.heightInput, { value: dimensions.height, enumerable: true, configurable: true });
      }
    }
    if (images.length) {
      if (!cfg?.imageInput) throw providerError("UNSUPPORTED", "Replicate references require providers.replicate.imageInput and an editing model");
      if (images.length > 1 && !cfg.imageInputArray) throw providerError("UNSUPPORTED", "Enable providers.replicate.imageInputArray for a model accepting multiple references");
      const references = images.map((path) => readImageAsDataUrl(path, cwd));
      Object.defineProperty(input, cfg.imageInput, { value: cfg.imageInputArray ? references : references[0], enumerable: true, configurable: true });
    }
    if (mask) {
      if (!cfg?.maskInput || cfg.maskInput === cfg.imageInput) {
        throw providerError("UNSUPPORTED", "Replicate inpainting requires a distinct providers.replicate.maskInput and an inpainting model");
      }
      Object.defineProperty(input, cfg.maskInput, { value: readImageAsDataUrl(mask, cwd), enumerable: true, configurable: true });
    }
    const remaining = deadline(cfg, 300000);
    const endpoint = version ? "/predictions" : `/models/${name.split("/").map(encodeURIComponent).join("/")}/predictions`;
    onProgress?.(`starting Replicate prediction (${model})...`, 20);
    let prediction = await apiRequest(id, baseUrl + endpoint,
      jsonPost({ ...(version && { version }), input }, { ...headers, Prefer: "wait=10" }), remaining());
    while (prediction.status === "starting" || prediction.status === "processing") {
      const predictionId = prediction.id;
      if (typeof predictionId !== "string" || !/^[\w-]+$/.test(predictionId)) throw providerError("BAD_RESPONSE", "Replicate returned an invalid prediction ID");
      await pollDelay(remaining, cfg);
      prediction = await apiRequest(id, `${baseUrl}/predictions/${predictionId}`, { headers }, remaining());
    }
    if (prediction.status !== "succeeded") throw providerError("FAILED", `Replicate prediction did not succeed (${["failed", "canceled"].includes(prediction.status) ? prediction.status : "unknown status"})`);
    const output = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    if (typeof output !== "string" || !/^https?:\/\//i.test(output)) throw providerError("BAD_IMAGE_PAYLOAD", "Replicate output did not contain an image URL");
    const buffer = await fetchImageToBuffer(output, undefined, { allowedOrigins: [new URL(baseUrl).origin], remaining });
    return imageResult(id, model, buffer, { images, mask });
  },
};
