import { setTimeout as delay } from "node:timers/promises";
import { detectImageMime, fetchWithTimeout, readBodyCapped, readImageFile } from "../util/common.js";
import { discoverKey } from "../util/keys.js";
import { redact, registerSecret } from "../util/redact.js";

export function apiKey(cfg, id) {
  return cfg?.apiKey ? { key: registerSecret(cfg.apiKey), source: "config" } : discoverKey(id);
}

export function keyStatus(cfg, id, env) {
  const found = apiKey(cfg, id);
  return found
    ? { available: true, auth: "ok", detail: `key from ${found.source} (validated on first use)` }
    : { available: false, auth: "missing", detail: `no API key (set ${env})` };
}

export function providerError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function requireKey(cfg, id, env) {
  const found = apiKey(cfg, id);
  if (!found) throw providerError("NO_AUTH", `${id} needs an API key (set ${env})`);
  return found.key;
}

export function multipartImage(path, cwd) {
  const { mime, buffer } = readImageFile(path, cwd);
  return { mime, blob: new Blob([buffer], { type: mime }), extension: mime === "image/jpeg" ? "jpg" : mime.split("/")[1] };
}

export function deadline(cfg, defaultMs) {
  const end = Date.now() + (Number(cfg?.timeoutMs) || defaultMs);
  return () => {
    const ms = end - Date.now();
    if (ms <= 0) throw providerError("TIMEOUT", "image request deadline exceeded");
    return ms;
  };
}

export async function pollDelay(remaining, cfg) {
  await delay(Math.min(remaining(), Number(cfg?.pollIntervalMs) > 0 ? Number(cfg.pollIntervalMs) : 1000));
}

export async function apiRequest(id, url, options, timeoutMs, { raw = false } = {}) {
  const res = await fetchWithTimeout(url, { ...options, redirect: "error" }, timeoutMs);
  if (!res.ok) {
    const detail = await readBodyCapped(res, 65536).catch(() => Buffer.alloc(0));
    const code = res.status === 401 || res.status === 403 ? "NO_AUTH" : res.status === 429 ? "RATE_LIMIT" : "FAILED";
    throw providerError(code, `${id} request failed: ${res.status} ${redact(detail.toString("utf8")).slice(0, 400)}`.trim());
  }
  const bytes = await readBodyCapped(res);
  if (raw) return bytes;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw providerError("BAD_RESPONSE", `${id} returned invalid JSON`);
  }
}

export function jsonPost(body, headers = {}) {
  return { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) };
}

export function imageResult(id, model, buffer, { images, mask } = {}) {
  if (!Buffer.isBuffer(buffer) || !detectImageMime(buffer)) {
    throw providerError("BAD_IMAGE_PAYLOAD", `${id} returned no valid image`);
  }
  return { buffer, meta: { provider: id, model, imagesUsed: Boolean(images?.length), maskUsed: Boolean(mask) } };
}

export function requireMaskImage(mask, images) {
  if (mask != null && (typeof mask !== "string" || !mask.trim() || !Array.isArray(images) || typeof images[0] !== "string" || !images[0].trim())) {
    throw providerError("INVALID_MASK", "mask must be a file path and requires a base image");
  }
}
