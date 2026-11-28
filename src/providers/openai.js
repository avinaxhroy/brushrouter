import { DEFAULT_OPENAI_IMAGE_MODEL } from "../config.js";
import { normalizeSize } from "../util/common.js";
import { apiRequest, imageResult, jsonPost, keyStatus, multipartImage, providerError, requireKey, requireMaskImage } from "./image-api.js";

const id = "openai";
const env = "OPENAI_API_KEY";

function openAIImageSize(size, model) {
  const dimensions = normalizeSize(size);
  if (!dimensions) return size;
  const { width, height, raw } = dimensions;
  if (!Number.isFinite(width) || !Number.isFinite(height) || !width || !height) {
    throw providerError("BAD_SIZE", "OpenAI Images requires positive width and height");
  }
  const distance = (w, h) => Math.hypot(Math.log(w / width), Math.log(h / height));
  if (/^gpt-image-2(?:$|[-.])/.test(model)) {
    let nearest = raw;
    let best = Infinity;
    for (let w = 16; w <= 3840; w += 16) {
      const minH = 16 * Math.ceil(Math.max(w / 3, 655360 / w) / 16);
      const maxH = 16 * Math.floor(Math.min(w * 3, 3840, 8294400 / w) / 16);
      if (minH > maxH) continue;
      const floor = Math.floor(height / 16) * 16;
      for (const h of [floor, floor + 16]) {
        const validH = Math.max(minH, Math.min(h, maxH));
        const score = distance(w, validH);
        if (score < best) {
          nearest = `${w}x${validH}`;
          best = score;
        }
      }
    }
    return nearest;
  }
  if (/^gpt-image-1(?:$|[-.])/.test(model) || model === "chatgpt-image-latest") {
    const sizes = [[1024, 1024], [1536, 1024], [1024, 1536]];
    const [w, h] = sizes.reduce((a, b) => distance(...a) <= distance(...b) ? a : b);
    return `${w}x${h}`;
  }
  return raw;
}

export const openAIProvider = {
  id,
  label: "OpenAI Images API",
  kind: "api-key",
  note: "Metered OpenAI Images API; separate from the ChatGPT subscription.",
  supportsImages: true,
  supportsMask: true,
  async probe(cfg) {
    return keyStatus(cfg, id, env);
  },
  async generate({ prompt, size, quality, background, images = [], mask, cwd, model: requestedModel, onProgress }, cfg) {
    requireMaskImage(mask, images);
    const key = requireKey(cfg, id, env);
    const model = requestedModel || cfg?.model || DEFAULT_OPENAI_IMAGE_MODEL;
    const baseUrl = (cfg?.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    const headers = { Authorization: `Bearer ${key}` };
    const isGPTImage = model.startsWith("gpt-image-") || model === "chatgpt-image-latest";
    if (!isGPTImage && background === "transparent") throw providerError("UNSUPPORTED", `${model} does not support transparent backgrounds`);
    if (!isGPTImage && images.length > 1) throw providerError("UNSUPPORTED", `${model} does not support multiple reference images`);
    const fields = { model, prompt, size: openAIImageSize(size || cfg?.size, model), quality: quality || cfg?.quality, ...(isGPTImage && { background }) };
    if (!isGPTImage) fields.response_format = "b64_json";
    const defined = Object.entries(fields).filter(([, value]) => value != null);
    let request;
    if (images.length) {
      const form = new FormData();
      for (const [name, value] of defined) form.append(name, value);
      for (const [index, path] of images.entries()) {
        const { blob, extension } = multipartImage(path, cwd);
        form.append(isGPTImage ? "image[]" : "image", blob, `reference-${index + 1}.${extension}`);
      }
      if (mask) {
        const { blob, mime } = multipartImage(mask, cwd);
        if (mime !== "image/png") throw providerError("INVALID_MASK", "OpenAI Images requires a PNG mask");
        form.append("mask", blob, "mask.png");
      }
      request = { method: "POST", headers, body: form };
    } else {
      request = jsonPost(Object.fromEntries(defined), headers);
    }
    onProgress?.(`generating via OpenAI Images (${model})...`, 25);
    const data = await apiRequest(id, `${baseUrl}/images/${images.length ? "edits" : "generations"}`, request, Number(cfg?.timeoutMs) || 180000);
    const encoded = data?.data?.[0]?.b64_json;
    return imageResult(id, model, typeof encoded === "string" && Buffer.from(encoded, "base64"), { images, mask });
  },
};
