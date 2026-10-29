// OpenAI-compatible HTTP image providers.
//
// Both OpenRouter and fal.ai are configured the same way: POST a JSON body and
// pull the image out of the response. A tiny response-path resolver keeps this
// generic, so the same code also serves the user's "custom HTTP API" provider.

import { fetchWithTimeout, readBodyCapped, readImageAsDataUrl, detectImageMime } from "../util/common.js";
import { discoverKey } from "../util/keys.js";
import { registerSecret } from "../util/redact.js";
import { readFileSync } from "node:fs";

function resolveKey(cfg, provider) {
  // A key supplied directly in config must also be registered with the
  // redactor, otherwise a server echoing it in an error could leak it.
  if (cfg?.apiKey) return { key: registerSecret(cfg.apiKey), source: "config" };
  return discoverKey(provider);
}

export function resolvePath(obj, path) {
  // Supports "data.0.url" and "images.0.b64_json" style paths.
  return String(path)
    .split(".")
    .reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

// Body templates are JSON, so a raw prompt with quotes/backslashes/newlines
// would corrupt the document. Escape, then drop the wrapping quotes.
function applyTemplate(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) => {
    if (vars[k] == null) return "";
    return JSON.stringify(String(vars[k])).slice(1, -1);
  });
}

// URL templates are a different language with a different escaping rule. The
// JSON escaper leaves `#`, `?` and `&` alone because they are legal inside a
// JSON string — but in a URL they are structural. A prompt containing "#ff0000"
// used to truncate the request at the fragment, and "a&b" injected a query
// parameter. Percent-encoding is the only correct escape here, so the two
// contexts get two helpers instead of one shared one.
function applyUrlTemplate(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) => {
    if (vars[k] == null) return "";
    return encodeURIComponent(String(vars[k]));
  });
}

// A provider must return actual image bytes, not "the string that happened to
// sit at the response path". The two escapes below put a payload on disk, so a
// truncated b64, an error message echoed in a 200 body, or an HTML error page
// behind a download URL used to become a corrupt .png that nothing validated.
function assertImageBytes(buffer, { provider, value, locator }) {
  const mime = detectImageMime(buffer);
  if (mime) return mime;
  // Name the payload: the caller needs to see WHAT the endpoint returned to fix
  // the response path, and a bare "not an image" hides that.
  const preview = String(value ?? "").slice(0, 120).replace(/\s+/g, " ");
  const e = new Error(
    `${provider} returned no usable image at "${locator}" — the payload is not PNG/JPEG/WebP/GIF ` +
      `(${buffer.length} byte(s) decoded): ${preview}${String(value ?? "").length > 120 ? "..." : ""}`,
  );
  e.code = "BAD_IMAGE_PAYLOAD";
  throw e;
}

async function fetchImageToBuffer(url, headers) {
  const res = await fetchWithTimeout(url, { headers }, 120000);
  if (!res.ok) throw new Error(`image download failed: ${res.status}`);
  return readBodyCapped(res);
}

// Shared implementation for any "POST json -> get url|b64|raw" image API.
export async function httpImageGenerate({ prompt, size, quality, images = [], cwd, onProgress }, cfg, preset) {
  const { url, method, headers, body, responsePath, defaultModel, apiKey, keyHeader, keyPrefix } = preset;
  // Per-call --model beats the configured model, which beats the preset default.
  const model = preset.model || cfg?.model || defaultModel;
  if (!url) {
    const e = new Error(`${preset.name} is not configured (missing endpoint URL)`);
    e.code = "UNCONFIGURED";
    throw e;
  }
  const key = apiKey || cfg?.apiKey || null;
  if (preset.requiresKey && !key) {
    const e = new Error(`${preset.name} needs an API key`);
    e.code = "NO_AUTH";
    throw e;
  }
  // Reference images. `{image}` in a template is documented, so it is populated
  // with a data URL (the only form a remote API can read — a local path means
  // nothing to the server). Only read the files when the template or a body
  // builder will actually consume them.
  const template = cfg?.body || body;
  const consumesImages = Boolean(preset.buildBody || /\{image\}/.test(template));
  // The capability is declared, not inferred: `supportsRefImages` defaults to
  // false, so a preset must opt in. Inferring it from the template alone left
  // the "cannot accept references" branch unreachable (nothing ever set the old
  // `withRefImages` flag) and dropped the images silently while the result still
  // claimed imagesUsed: true.
  if (images.length && preset.supportsRefImages === false) {
    // Fail loudly. Silently generating a text-only image while the caller
    // believes its reference was used is the worst outcome: the user pays for a
    // generation that cannot contain what they asked for.
    const e = new Error(
      `${preset.name} does not support reference images (${images.length} supplied) — use a provider that accepts images.`,
    );
    e.code = "UNSUPPORTED";
    throw e;
  }
  if (images.length && !consumesImages) {
    // Capable in principle (e.g. custom-http) but this deployment's template has
    // no `{image}` slot and no buildBody, so there is nowhere to put them.
    const e = new Error(
      `${preset.name} cannot carry reference images (${images.length} supplied): ` +
        `its request template has no {image} placeholder and it does not build a body. ` +
        `Add "{image}" to the configured body, or drop the images.`,
    );
    e.code = "UNSUPPORTED";
    throw e;
  }
  const imageUrls = images.length > 0 ? images.map((p) => readImageAsDataUrl(p, cwd)) : [];

  const vars = {
    prompt,
    size: size || "1024x1024",
    quality: quality || "standard",
    model,
    apiKey: key || "",
    image: imageUrls[0] || "",
  };
  const finalHeaders = { "Content-Type": "application/json", ...headers };
  if (key) finalHeaders[keyHeader || "Authorization"] = `${keyPrefix ?? "Bearer "}${key}`;
  if (cfg?.headers) Object.assign(finalHeaders, cfg.headers);

  // A body builder receives the raw prompt, so it can build structured content
  // (e.g. multimodal message parts) that a flat string template cannot express.
  const finalBody = preset.buildBody
    ? JSON.stringify(preset.buildBody({ prompt, size, quality, model, imageUrls }))
    : applyTemplate(template, vars);
  onProgress?.(`generating via ${preset.name}...`, 25);
  const res = await fetchWithTimeout(
    // URL context: percent-encode. Body context above: JSON-escape.
    applyUrlTemplate(cfg?.url || url, vars),
    { method: cfg?.method || method || "POST", headers: finalHeaders, body: finalBody },
    Number(cfg?.timeoutMs) || 180000,
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const e = new Error(`${preset.name} request failed: ${res.status} ${detail.slice(0, 400)}`);
    if (res.status === 401 || res.status === 403) e.code = "NO_AUTH";
    // A 404 here is the endpoint not existing — almost always a typo'd
    // baseUrl/url. Label it so the caller fixes config instead of hunting a
    // model problem, and so the router does not retry it as a modality signal.
    if (res.status === 404 && !isChatModalityError(detail)) e.code = "BAD_URL";
    throw e;
  }
  const responseMode = cfg?.response || responsePath;
  if (responseMode === "raw") {
    const raw = await readBodyCapped(res);
    // "raw" means "the body IS the image" — validate it rather than writing
    // whatever came back to disk as a .png.
    assertImageBytes(raw, { provider: preset.name, value: raw.subarray(0, 120).toString("latin1"), locator: "raw body" });
    return { buffer: raw, meta: { provider: preset.id, model, imagesUsed: imageUrls.length > 0 } };
  }
  const json = await res.json();
  const locator = responseMode.startsWith("json:") ? responseMode.slice(5) : responseMode;
  let value = resolvePath(json, locator);
  if (Array.isArray(value)) value = value[0];
  if (!value || typeof value !== "string") {
    throw new Error(`${preset.name} response had no image at "${locator}": ${JSON.stringify(json).slice(0, 300)}`);
  }
  let buffer;
  let sourceUrl = null;
  if (value.startsWith("data:")) {
    const commaIdx = value.indexOf(",");
    buffer = Buffer.from(commaIdx >= 0 ? value.slice(commaIdx + 1) : value, "base64");
  } else if (value.startsWith("http")) {
    sourceUrl = value;
    buffer = await fetchImageToBuffer(value, { "User-Agent": "brushrouter/0.1" });
  } else {
    // assume base64 payload
    buffer = Buffer.from(value, "base64");
  }
  // Validated before it is returned, so no caller can save junk: a b64 string
  // that is really an error message decodes to bytes that are not any image
  // format, and the file would be written as a valid-looking .png.
  assertImageBytes(buffer, { provider: preset.name, value, locator });
  return { buffer, meta: { provider: preset.id, model, imagesUsed: imageUrls.length > 0, sourceUrl } };
}

// OpenRouter exposes TWO generation surfaces, and the right one depends on the
// model:
//
//   * POST /chat/completions  — for multimodal chat models (e.g. the Gemini
//                               image models). This is the classic path.
//   * POST /images            — for IMAGE-ONLY models (e.g. meta/muse-image,
//                               x-ai/grok-imagine-image-2.0). Chat-completions
//                               rejects these with "No endpoints found that
//                               support the requested output modalities".
//
// Rather than hardcode which model belongs to which surface, we try the chat
// path first and, ONLY when the failure is specifically "this model is not
// available over chat", transparently retry the /images path. Auth, quota and
// region errors are surfaced as-is (never masked by a second attempt).
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

function sizeToAspectRatio(size) {
  const m = String(size || "").match(/(\d+)\s*[xX]\s*(\d+)/);
  if (!m) return null;
  let w = Number(m[1]);
  let h = Number(m[2]);
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const d = gcd(w, h) || 1;
  return `${w / d}:${h / d}`;
}

// True only for "this model cannot be served over chat/completions, try
// /images instead". A bare status code is NOT a signal: /404/ is also the
// status of any wrong-host request, so matching it alone made a typo'd baseUrl
// look like a modality switch and sent the router retrying every model, the
// caller ending up with "all providers failed" instead of "your URL is wrong".
// Match the response BODY's modality wording (or a 404 that explicitly says the
// route/model does not exist), never the status alone.
function isChatModalityError(message) {
  const s = String(message);
  return (
    /No endpoints found that support the requested output modalities/i.test(s) ||
    /requested output modalities/i.test(s) ||
    // Some deployments word it as the model not being a chat model.
    /(not a (valid )?chat model|does not support chat|chat modality)/i.test(s) ||
    // A 404 that names the route/model is a real routing signal; a bare status
    // is not, so the status must be joined by explanatory text.
    /(no endpoints found|model not found|not a valid model)/i.test(s)
  );
}

// A 404 with no modality wording means the URL (or the endpoint path) is wrong.
// Reported as a config error so the caller fixes the baseUrl instead of paying
// for a retry across every model.
function isUrlConfigError(message) {
  const s = String(message);
  return /request failed: 404/.test(s) && !isChatModalityError(s);
}

// Shared helper: POST /images and pull b64_json|url out of data[0].
export async function openrouterImagesGenerate({ prompt, size, quality, images = [], cwd, onProgress }, cfg, model, apiKey) {
  const base = (cfg?.baseUrl || OPENROUTER_BASE).replace(/\/$/, "");
  const body = { model, prompt, n: 1 };
  const aspect = sizeToAspectRatio(size);
  if (aspect) body.aspect_ratio = aspect;
  if (quality && quality !== "auto") body.quality = quality;
  if (cfg?.resolution) body.resolution = cfg.resolution;
  // input_references are fetched by OpenRouter's servers, so they must be URLs.
  // A local filesystem path is meaningless to them — send data URLs instead.
  if (images.length) body.input_references = images.map((p) => readImageAsDataUrl(p, cwd));
  onProgress?.(`generating via OpenRouter /images (${model})...`, 25);
  const res = await fetchWithTimeout(
    `${base}/images`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/brushrouter",
        "X-Title": "brushrouter",
      },
      body: JSON.stringify(body),
    },
    Number(cfg?.timeoutMs) || 180000,
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const e = new Error(`OpenRouter /images request failed: ${res.status} ${detail.slice(0, 400)}`);
    if (res.status === 401 || res.status === 403) e.code = /region|not available/i.test(detail) ? "REGION" : "NO_AUTH";
    if (res.status === 402) e.code = "NO_CREDITS";
    throw e;
  }
  const json = await res.json();
  const item = json?.data?.[0] || json?.images?.[0];
  const value = item?.b64_json || item?.url || item?.image_url?.url;
  if (!value || typeof value !== "string") {
    throw new Error(`OpenRouter /images response had no image: ${JSON.stringify(json).slice(0, 300)}`);
  }
  let buffer;
  let sourceUrl = null;
  if (value.startsWith("data:")) {
    const commaIdx = value.indexOf(",");
    buffer = Buffer.from(commaIdx >= 0 ? value.slice(commaIdx + 1) : value, "base64");
  } else if (value.startsWith("http")) {
    sourceUrl = value;
    buffer = await fetchImageToBuffer(value, { "User-Agent": "brushrouter/0.1" });
  } else buffer = Buffer.from(value, "base64");
  assertImageBytes(buffer, { provider: "OpenRouter /images", value, locator: "data[0]" });
  // imagesUsed reports what was actually sent (input_references went out above),
  // not what the caller asked for.
  return { buffer, meta: { provider: "openrouter", model, endpoint: "/images", imagesUsed: images.length > 0, sourceUrl } };
}

// Live model catalogue for `brushrouter models` — the image-capable models the
// user's key can actually see. Returns [] on any failure (never throws).
export async function openrouterListModels(cfg) {
  const found = resolveKey(cfg, "openrouter");
  if (!found) return [];
  const base = (cfg?.baseUrl || OPENROUTER_BASE).replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${found.key}` };
  const out = [];
  // Both catalogues are needed, so fetch them together instead of paying two
  // round-trips back to back. Order of `out` is preserved below: image-only
  // models first, so the de-dupe keeps the /images endpoint for a shared id.
  const [imgRes, chatRes] = await Promise.all([
    fetchWithTimeout(`${base}/images/models`, { headers }, 20000).catch(() => null),
    fetchWithTimeout(`${base}/models`, { headers }, 20000).catch(() => null),
  ]);
  // The dedicated images catalogue lists image-only models that /models omits.
  if (imgRes?.ok) {
    const j = await imgRes.json().catch(() => null);
    for (const m of j?.data || []) if (m?.id) out.push({ id: m.id, endpoint: "/images", name: m.name || null });
  }
  if (chatRes?.ok) {
    const j = await chatRes.json().catch(() => null);
    for (const m of j?.data || []) {
      if (m?.architecture?.output_modalities?.includes("image") || /image/.test(m.id)) {
        out.push({ id: m.id, endpoint: "/chat/completions", name: m.name || null });
      }
    }
  }
  const seen = new Set();
  return out.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

export const openrouterProvider = {
  id: "openrouter",
  supportsImages: true,
  label: "OpenRouter",
  kind: "api-key",
  note: "One key, many image models. Key auto-discovered from agent auth stores or BRUSHROUTER_OPENROUTER_KEY.",
  // Tried in order when the user has not pinned a model. This is a FALLBACK
  // list, not a hardcoded truth: set providers.openrouter.model (or --model) to
  // use any other id from `brushrouter models`.
  defaultModels: ["google/gemini-3.1-flash-image", "google/gemini-3-pro-image", "google/gemini-2.5-flash-image"],
  async probe(cfg) {
    const found = resolveKey(cfg, "openrouter");
    if (!found) return { available: false, auth: "missing", detail: "no API key (set BRUSHROUTER_OPENROUTER_KEY)" };
    const base = cfg?.baseUrl || OPENROUTER_BASE;
    const headers = { Authorization: `Bearer ${found.key}` };
    try {
      // The count needs both catalogues, so request them together: this probe
      // used to serialize two round-trips on the critical path of every
      // `providers` / `doctor` / `gen --dry-run`.
      const [res, r2] = await Promise.all([
        fetchWithTimeout(`${base}/models`, { headers }, 20000),
        fetchWithTimeout(`${base}/images/models`, { headers }, 20000).catch(() => null),
      ]);
      if (!res.ok) return { available: false, auth: "invalid", detail: `key rejected (${res.status}) from ${found.source}` };
      const j = await res.json();
      const all = Array.isArray(j.data) ? j.data : [];
      const chatImage = all.filter((m) => m.architecture?.output_modalities?.includes("image") || /image/.test(m.id)).length;
      // The dedicated image catalogue carries image-only models that /models omits.
      let imageOnly = 0;
      if (r2?.ok) imageOnly = (await r2.json().catch(() => null))?.data?.length || 0;
      const total = chatImage + imageOnly;
      const pinned = cfg?.model ? `; model pinned to ${cfg.model}` : "";
      return {
        available: true,
        auth: "ok",
        detail: `key from ${found.source}; ${total} image model(s) available (${chatImage} chat + ${imageOnly} image-only)${pinned}`,
      };
    } catch (e) {
      return { available: false, auth: "error", detail: e.message };
    }
  },
  async generate({ prompt, size, quality, images, cwd, onProgress, model: requestedModel }, cfg) {
    const found = resolveKey(cfg, "openrouter");
    if (!found) {
      const e = new Error("OpenRouter needs an API key");
      e.code = "NO_AUTH";
      throw e;
    }
    // Precedence: per-call model > configured model > built-in fallback list.
    const pinned = requestedModel || cfg?.model;
    const base = (cfg?.baseUrl || OPENROUTER_BASE).replace(/\/$/, "");
    const candidates = pinned
      ? [pinned]
      : [...new Set([...(cfg?.models || []), ...openrouterProvider.defaultModels].filter(Boolean))];
    if (!candidates.length) {
      const e = new Error("no OpenRouter models configured to try");
      e.code = "NO_MODELS";
      throw e;
    }
    let lastErr;
    for (const model of candidates) {
      try {
        try {
          return await generateOpenRouter({ prompt, size, quality, images, cwd, onProgress }, cfg, model, found.key);
        } catch (e) {
          // A wrong host/path is not a modality signal: report it as config and
          // stop, or every remaining model pays for the same 404.
          if (isUrlConfigError(e.message)) {
            const cfgErr = new Error(
              `OpenRouter endpoint not found (404) — check providers.openrouter.baseUrl ` +
                `(currently "${base}"). Provider said: ${e.message}`,
            );
            cfgErr.code = "BAD_URL";
            cfgErr.cause = e;
            throw cfgErr;
          }
          // Image-only models are rejected by chat/completions; retry /images.
          if (!isChatModalityError(e.message)) throw e;
          onProgress?.(`${model} is not a chat model; retrying via /images...`, 25);
          return await openrouterImagesGenerate({ prompt, size, quality, images, cwd, onProgress }, cfg, model, found.key);
        }
      } catch (e) {
        lastErr = e;
        // When the user pinned a model, that failure is final — do not silently
        // substitute a different model behind their back.
        if (pinned) throw e;
        // A config error applies to every candidate, so retrying is pure waste.
        if (e.code === "BAD_URL") throw e;
        if (!isChatModalityError(e.message) && !/not available|No endpoints found/i.test(e.message)) throw e;
        onProgress?.(`model ${model} unavailable, trying next...`, 25);
      }
    }
    throw lastErr;
  },
};

function generateOpenRouter({ prompt, size, quality, images, cwd, onProgress }, cfg, model, apiKey) {
  return httpImageGenerate({ prompt, size, quality, images, cwd, onProgress }, cfg, {
    id: "openrouter",
    name: "OpenRouter",
    url: `${(cfg?.baseUrl || OPENROUTER_BASE).replace(/\/$/, "")}/chat/completions`,
    method: "POST",
    requiresKey: true,
    apiKey,
    keyHeader: "Authorization",
    keyPrefix: "Bearer ",
    headers: { "HTTP-Referer": "https://github.com/brushrouter", "X-Title": "brushrouter" },
    model,
    // Chat path can carry references as multimodal parts → declared capable.
    supportsRefImages: true,
    // Reference images have to travel as multimodal content parts; a flat
    // string template cannot express an array, so this provider builds the body.
    buildBody: ({ prompt, imageUrls }) => ({
      model,
      messages: [
        {
          role: "user",
          content: imageUrls.length
            ? [{ type: "text", text: prompt }, ...imageUrls.map((url) => ({ type: "image_url", image_url: { url } }))]
            : prompt,
        },
      ],
      modalities: ["image", "text"],
    }),
    responsePath: "json:choices.0.message.images.0.image_url.url",
    defaultModel: model,
  });
}

export const falProvider = {
  id: "fal",
  supportsImages: false,
  label: "fal.ai",
  kind: "api-key",
  note: "Fast hosted models (FLUX, etc). Key from config or BRUSHROUTER_FAL_KEY.",
  async probe(cfg) {
    const found = resolveKey(cfg, "fal");
    if (!found) return { available: false, auth: "missing", detail: "no API key (set BRUSHROUTER_FAL_KEY)" };
    return { available: true, auth: "ok", detail: `key from ${found.source} (validated on first use)` };
  },
  async generate({ prompt, size, quality, cwd, onProgress, model: requestedModel }, cfg) {
    const found = resolveKey(cfg, "fal");
    const model = requestedModel || cfg?.model || "fal-ai/flux/schnell";
    const base = (cfg?.baseUrl || "https://fal.run").replace(/\/$/, "");
    const n = String(size || "1024x1024").match(/(\d+)\s*[xX]\s*(\d+)/);
    return httpImageGenerate({ prompt, size, quality, cwd, onProgress }, cfg, {
      id: "fal",
      name: "fal.ai",
      url: `${base}/${model}`,
      method: "POST",
      requiresKey: true,
      apiKey: found?.key,
      keyHeader: "Authorization",
      keyPrefix: "Key ",
      headers: {},
      model,
      // Text-to-image only: the vendor route takes a prompt, no image inputs.
      supportsRefImages: false,
      body: JSON.stringify({ prompt: "{prompt}", image_size: n ? { width: Number(n[1]), height: Number(n[2]) } : "square_hd", num_images: 1 }),
      responsePath: "json:images.0.url",
      defaultModel: model,
    });
  },
};

export const customHttpProvider = {
  id: "custom-http",
  supportsImages: true,
  label: "Custom HTTP API",
  kind: "user-defined",
  note: "Point at any image API. Configure url/headers/body/response in config.json.",
  async probe(cfg) {
    if (!cfg?.url) return { available: false, auth: "unconfigured", detail: "set providers.custom-http.url in config.json" };
    const found = resolveKey(cfg, "custom");
    return { available: true, auth: found ? "key" : "none", detail: cfg.url };
  },
  async generate({ prompt, size, quality, images = [], cwd, onProgress, model: requestedModel }, cfg) {
    const found = resolveKey(cfg, "custom");
    return httpImageGenerate({ prompt, size, quality, images, cwd, onProgress }, cfg, {
      id: "custom-http",
      name: cfg?.name || "custom-http",
      url: cfg?.url,
      method: cfg?.method || "POST",
      requiresKey: false,
      apiKey: found?.key,
      keyHeader: cfg?.keyHeader || "Authorization",
      keyPrefix: cfg?.keyPrefix ?? "Bearer ",
      headers: cfg?.headers || {},
      body: cfg?.body || '{"prompt": "{prompt}", "size": "{size}", "model": "{model}"}',
      responsePath: cfg?.response || "json:data.0.url",
      model: requestedModel,
      defaultModel: cfg?.model || "custom-model",
      // Capability is declared by the deployment, not guessed: a custom-http
      // body only carries references when the user's template has {image}.
      // The guard in httpImageGenerate then fails loudly instead of dropping.
      supportsRefImages: cfg?.supportsRefImages !== false,
    });
  },
};
