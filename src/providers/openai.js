import { normalizeSize } from "../util/common.js";
import { apiRequest, imageResult, jsonPost, keyStatus, multipartImage, providerError, requireKey, requireMaskImage } from "./image-api.js";

const id = "openai";
const env = "OPENAI_API_KEY";

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
    const model = requestedModel || cfg?.model || "gpt-image-1";
    const baseUrl = (cfg?.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    const headers = { Authorization: `Bearer ${key}` };
    const isGPTImage = model.startsWith("gpt-image-") || model === "chatgpt-image-latest";
    if (!isGPTImage && background === "transparent") throw providerError("UNSUPPORTED", `${model} does not support transparent backgrounds`);
    if (!isGPTImage && images.length > 1) throw providerError("UNSUPPORTED", `${model} does not support multiple reference images`);
    const fields = { model, prompt, size: normalizeSize(size)?.raw || size || cfg?.size, quality: quality || cfg?.quality, ...(isGPTImage && { background }) };
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
