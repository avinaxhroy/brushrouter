import { normalizeSize, readImageFile } from "../util/common.js";
import { apiRequest, imageResult, jsonPost, keyStatus, providerError, requireKey } from "./image-api.js";

const id = "gemini-api";
const env = "GEMINI_API_KEY";
const ratios = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

function closestRatio(size) {
  const dimensions = normalizeSize(size);
  if (!dimensions?.width || !dimensions.height) return undefined;
  const distance = (ratio) => {
    const [w, h] = ratio.split(":").map(Number);
    return Math.abs(Math.log((dimensions.width / dimensions.height) / (w / h)));
  };
  return ratios.reduce((best, ratio) => distance(ratio) < distance(best) ? ratio : best);
}

export const geminiAPIProvider = {
  id,
  label: "Google AI Studio (Gemini API)",
  kind: "api-key",
  note: "Direct Gemini image generation and editing using an AI Studio API key.",
  supportsImages: true,
  async probe(cfg) {
    return keyStatus(cfg, id, env);
  },
  async generate({ prompt, size, images = [], mask, cwd, model: requestedModel, onProgress }, cfg) {
    if (mask != null) throw providerError("UNSUPPORTED", "gemini-api does not support masks");
    const key = requireKey(cfg, id, env);
    const model = (requestedModel || cfg?.model || "gemini-2.5-flash-image").replace(/^models\//, "");
    const baseUrl = (cfg?.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
    const parts = [{ text: prompt }, ...images.map((path) => {
      const { buffer, mime } = readImageFile(path, cwd);
      return { inlineData: { mimeType: mime, data: buffer.toString("base64") } };
    })];
    const aspectRatio = closestRatio(size);
    const imageConfig = { ...(aspectRatio && { aspectRatio }), ...(cfg?.resolution && { imageSize: cfg.resolution }) };
    const body = {
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        ...(Object.keys(imageConfig).length && { imageConfig }),
      },
    };
    onProgress?.(`generating via Google AI Studio (${model})...`, 25);
    const data = await apiRequest(id, `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
      jsonPost(body, { "x-goog-api-key": key }), Number(cfg?.timeoutMs) || 180000);
    const image = data?.candidates?.flatMap((c) => c.content?.parts || [])
      .map((part) => part.inlineData || part.inline_data)
      .find((part) => (part?.mimeType || part?.mime_type || "").startsWith("image/") && typeof part.data === "string");
    const blocked = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
    if (!image && blocked && blocked !== "STOP") {
      throw providerError("BAD_IMAGE_PAYLOAD", `gemini-api returned no image (${String(blocked).replace(/[^A-Z_]/g, "")})`);
    }
    return imageResult(id, model, image && Buffer.from(image.data, "base64"), { images });
  },
};
