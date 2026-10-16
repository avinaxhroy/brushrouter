// Codex / ChatGPT-subscription provider.
//
// Routes image generation through the Codex backend's hosted `image_generation`
// tool, billed to the local user's ChatGPT plan. No API key.
//
// Hardening notes (learned from real failures):
//   * The OAuth client id is DERIVED from the token's own `aud` claim, so a
//     hardcoded typo can never break refresh again.
//   * The orchestrator model is resolved from env -> ~/.codex/config.toml ->
//     fallback list, and generation retries the next candidate when a model is
//     retired (404 model_not_found). It never retries on quota/auth errors.
//   * IMPORTANT: the model here only *drives* the request; the image is produced
//     by the hosted image tool. This path shares the Codex TEXT quota, so a
//     text-quota exhaustion surfaces as 429 usage_limit_reached.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fetchWithTimeout, sseData, jwtExpiryMs, jwtClientId, readImageAsDataUrl, normalizeSize } from "../util/common.js";
import { registerSecret, safeParseMessage } from "../util/redact.js";

const CODEX_RESPONSES_ENDPOINT = process.env.BRUSHROUTER_CODEX_ENDPOINT || "https://chatgpt.com/backend-api/codex/responses";

// Dedicated image endpoints of the Codex backend — the same ones the Codex CLI
// uses for its hosted image tool. They do not run an orchestrator model, so
// they cost no text tokens and cannot fail on model retirement. Learned from
// github.com/yuji-hatakeyama/opencode-gpt-imagegen, whose e2e suite exercises
// both endpoints against gpt-image-2. Edits is the variant for reference images.
const CODEX_IMAGES_GENERATIONS_ENDPOINT = process.env.BRUSHROUTER_CODEX_IMAGES_ENDPOINT || "https://chatgpt.com/backend-api/codex/images/generations";
const CODEX_IMAGES_EDITS_ENDPOINT = process.env.BRUSHROUTER_CODEX_IMAGES_EDITS_ENDPOINT || "https://chatgpt.com/backend-api/codex/images/edits";

// The backend ignores model, quality and size here and takes the aspect ratio
// from the prompt text itself (github.com/.../issues/107), which is the only
// reliable levers are: the prompt (aspect) and background. Defaults keep body
// parity with the Codex CLI anyway.
const CODEX_IMAGES_DEFAULTS = { model: "gpt-image-2", quality: "auto", size: "auto", output_format: "png" };

// Append the requested size to the prompt so the backend can honor its aspect
// ratio. "auto" means no constraint, so the prompt is returned untouched.
// smith: known-mirror match within 2%, else exact gcd reduction — a 1672x941
// request prints "16:9" instead of the useless "1672:941".
function aspectText(w, h) {
  const known = [[1, 1], [3, 2], [2, 3], [4, 3], [3, 4], [16, 9], [9, 16]];
  let best = null;
  for (const [a, b] of known) {
    const err = Math.abs(w / h - a / b) / (a / b);
    if (err < 0.02 && (!best || err < best.err)) best = { err, a, b };
  }
  if (best) return `${best.a}:${best.b}`;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const d = gcd(w, h) || 1;
  return `${w / d}:${h / d}`;
}

export function appendSizeHint(prompt, size) {
  const s = normalizeSize(size);
  if (!s) return prompt;
  return `${prompt} Generate the image with a width of ${s.width} pixels and a height of ${s.height} pixels (${aspectText(s.width, s.height)} aspect ratio).`;
}

async function callCodexImagesDirect(auth, { prompt, size, quality, background, images }, cfg, cwd, onProgress) {
  onProgress?.("generating via the Codex images endpoint...", 30);
  const dataUrls = (images || []).map((p) => readImageAsDataUrl(p, cwd));
  const isEdit = dataUrls.length > 0;
  const body = {
    prompt: appendSizeHint(prompt, size),
    ...CODEX_IMAGES_DEFAULTS,
    ...(quality && quality !== "auto" ? { quality } : {}),
    background: background === "transparent" ? "transparent" : "opaque",
    ...(isEdit ? { images: dataUrls.map((url) => ({ image_url: url })) } : {}),
  };
  const res = await fetchWithTimeout(
    isEdit ? CODEX_IMAGES_EDITS_ENDPOINT : CODEX_IMAGES_GENERATIONS_ENDPOINT,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.access}`,
        ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
        originator: ORIGINATOR,
      },
      body: JSON.stringify(body),
    },
    cfgTimeout(cfg, 300000),
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 403) {
      const e = new Error(
        "codex images endpoint rejected this account (403 Forbidden). These endpoints require a paid ChatGPT " +
          "subscription (Go/Plus/Pro/Team/Business); this token's plan is '" + (auth.plan || "unknown") + "'. " +
          "Free accounts: image generation is gated on every Codex path — use another provider (gemini/openrouter). [" + detail.slice(0, 200) + "]",
      );
      e.code = "NO_AUTH";
      throw e;
    }
    throw new Error(`codex images request failed: ${res.status} ${detail.slice(0, 500)}`);
  }
  const json = await res.json().catch(() => ({}));
  const b64 = json?.data?.[0]?.b64_json;
  // An empty string decodes to a 0-byte file that would still look like success.
  if (!b64) throw new Error("no image returned by the codex images endpoint");
  return Buffer.from(b64, "base64");
}
const TOKEN_ENDPOINT = process.env.BRUSHROUTER_OAUTH_TOKEN_ENDPOINT || "https://auth.openai.com/oauth/token";
// The OAuth client id is DERIVED from the token's own claims (see jwtClientId).
// A static value is only a last resort and is configurable, never hardcoded.
// Set BRUSHROUTER_CODEX_CLIENT_ID if your login uses a non-standard client.
const CONFIGURED_CLIENT_ID = () => process.env.BRUSHROUTER_CODEX_CLIENT_ID || null;
const ORIGINATOR = process.env.BRUSHROUTER_ORIGINATOR || "codex_cli_rs";
// Tried in order when no explicit/configured model works. gpt-6-luna is the
// current known-good orchestrator model (sol is discounted for free tiers and
// retired-5.5-era accounts), then the 0.1.14 migration target, then legacy.
const FALLBACK_MODELS = ["gpt-6-luna", "gpt-6-sol", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6", "gpt-5.5"];

function authCandidates(cfg) {
  const out = [];
  if (cfg?.authFile) out.push(cfg.authFile);
  if (process.env.BRUSHROUTER_CODEX_AUTH_FILE) out.push(process.env.BRUSHROUTER_CODEX_AUTH_FILE);
  // Our own login flow (brushrouter login) writes here — it must outrank the
  // borrowed files so signing in with a different account takes effect.
  const cfgDir = process.env.BRUSHROUTER_CONFIG_DIR || join(homedir(), ".config", "brushrouter");
  out.push(join(cfgDir, "auth.json"));
  out.push(join(homedir(), ".codex", "auth.json"));
  // Other agent runtimes keep an OpenAI OAuth entry in standard locations we
  // read but never write. Product-standard paths, not personal.
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  out.push(join(xdg, "opencode", "auth.json"));
  // pi and omp (can1357/oh-my-pi) store oauth credentials in their agent
  // dirs; omp is a pi fork with the same auth.json schema.
  out.push(join(homedir(), ".omp", "agent", "auth.json"));
  out.push(join(homedir(), ".pi", "agent", "auth.json"));
  return out;
}

function normalizeAuth(raw, filePath) {
  if (raw.tokens?.access_token) {
    return {
      filePath,
      format: "codex",
      access: raw.tokens.access_token,
      refresh: raw.tokens.refresh_token || null,
      accountId: raw.tokens.account_id || null,
      clientId: jwtClientId(raw.tokens.id_token || raw.tokens.access_token),
      plan: authPlan(raw.tokens.access_token),
    };
  }
  const o = raw.openai;
  if (o?.type === "oauth" && o.access) {
    return {
      filePath,
      format: "opencode",
      access: o.access,
      refresh: o.refresh || null,
      accountId: o.accountId || null,
      clientId: jwtClientId(o.access),
      plan: authPlan(o.access),
    };
  }
  // pi / omp (oh-my-pi) logins: any oauth entry in their per-provider auth.json
  const m = raw.openai ?? Object.values(raw).find((v) => v?.type === "oauth" && typeof v.access === "string");
  if (m?.type === "oauth" && m.access) {
    const claim = openaiJwtClaim(m.access);
    return {
      filePath,
      format: raw.openai ? "opencode" : "pi",
      access: m.access,
      refresh: m.refresh || null,
      accountId: m.accountId || claim?.account_id || null,
      clientId: jwtClientId(m.access),
      plan: claim?.plan ?? null,
    };
  }
  return null;
}

export function openaiJwtClaim(jwt) {
  try {
    const a = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString())?.["https://api.openai.com/auth"];
    return a ? { plan: a.chatgpt_plan_type || null, account_id: a.chatgpt_account_id || null } : null;
  } catch {
    return null;
  }
}

// The ChatGPT plan type lives in the access token's https://api.openai.com/auth
// claim; read locally, no network call. The Codex image endpoints are gated to
// paid subscriptions, so knowing "free" up front turns a live 403 into a plain
// sentence and lets probe report why before any request is spent.
function authPlan(jwt) {
  return openaiJwtClaim(jwt)?.plan ?? null;
}

export function readAuth(cfg) {
  const tried = [];
  for (const p of authCandidates(cfg)) {
    if (!existsSync(p)) continue;
    try {
      const auth = normalizeAuth(JSON.parse(readFileSync(p, "utf8")), p);
      if (auth) {
        // Register by value, so a token the backend echoes back inside an error
        // body is stripped even when it matches no known shape — an opaque
        // refresh token matches none of the shape patterns.
        registerSecret(auth.access);
        registerSecret(auth.refresh);
        return auth;
      }
      tried.push(`${p}: no openai oauth entry`);
    } catch (e) {
      // Not e.message: a JSON parse error quotes the file back at you, and this
      // path can be pointed at any file on disk.
      tried.push(`${p}: ${safeParseMessage(e)}`);
    }
  }
  const err = new Error(
    "no ChatGPT OAuth auth found (tried: " + tried.join("; ") + "). Run `brushrouter login` to sign in directly " +
      "(no API key — works with nothing else installed), or `npx @openai/codex login`, or sign in via OpenCode/pi; " +
      "all are read automatically.",
  );
  err.code = "NO_AUTH";
  throw err;
}

function persistAuth(auth, newAccess, newRefresh) {
  // readAuth() parsed this file moments ago, so a failure here means it changed
  // underneath us. Say that, instead of surfacing a raw SyntaxError (whose
  // message quotes the file back at you).
  let raw;
  try {
    raw = JSON.parse(readFileSync(auth.filePath, "utf8"));
  } catch (e) {
    throw new Error(`cannot persist the refreshed token to ${auth.filePath}: ${safeParseMessage(e)}`);
  }
  if (auth.format === "codex") {
    raw.tokens.access_token = newAccess;
    if (newRefresh) raw.tokens.refresh_token = newRefresh;
    raw.last_refresh = new Date().toISOString();
  } else {
    raw.openai.access = newAccess;
    if (newRefresh) raw.openai.refresh = newRefresh;
  }
  writeFileSync(auth.filePath, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
  // A refreshed token is a new secret the redactor has never seen.
  registerSecret(newAccess);
  registerSecret(newRefresh);
  auth.access = newAccess;
  if (newRefresh) auth.refresh = newRefresh;
  auth.clientId = jwtClientId(newAccess) || auth.clientId;
}

export async function refreshAuthToken(auth, cfg) {
  if (!auth.refresh) throw new Error("no refresh token available — re-authenticate with `codex login`");
  const clientId = cfg?.clientId || auth.clientId || CONFIGURED_CLIENT_ID();
  if (!clientId) {
    const e = new Error(
      "cannot refresh: no OAuth client id could be derived from the token. " +
        "Set providers.codex.clientId or BRUSHROUTER_CODEX_CLIENT_ID.",
    );
    e.code = "NO_CLIENT_ID";
    throw e;
  }
  const res = await fetchWithTimeout(
    TOKEN_ENDPOINT,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: auth.refresh, client_id: clientId }),
    },
    60000,
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const stale = res.status === 401 || res.status === 400;
    throw new Error(
      `token refresh failed: ${res.status} ${detail.slice(0, 300)}` +
        (stale ? "\n  the stored login is dead — run `brushrouter login` to sign in again" : ""),
    );
  }
  const data = await res.json();
  if (!data.access_token) throw new Error("token refresh returned no access_token");
  persistAuth(auth, data.access_token, data.refresh_token || null);
  return auth;
}

export async function ensureFreshAuth(auth, cfg) {
  const exp = jwtExpiryMs(auth.access);
  if (!exp || Date.now() < exp - 120000) return auth;
  if (auth.refresh) return refreshAuthToken(auth, cfg);
  if (Date.now() < exp) return auth;
  throw new Error("access token expired and cannot be refreshed — run `codex login` again");
}

function readCodexConfigModel() {
  try {
    const toml = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8");
    const m = toml.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

export function modelCandidates(cfg) {
  const list = [
    cfg?.model,
    process.env.BRUSHROUTER_CODEX_MODEL,
    readCodexConfigModel(),
    ...FALLBACK_MODELS,
  ];
  return [...new Set(list.filter(Boolean))];
}

function isModelError(err) {
  const m = String(err?.message || "");
  return /model_not_found|does not exist or you do not have access|not supported when using Codex/i.test(m);
}

function isQuotaError(err) {
  return /usage_limit_reached|: 429|\b429\b/.test(String(err?.message || ""));
}

async function callCodex(auth, { prompt, size, quality, model, images, background }, cfg, cwd, onProgress) {
  // The backend derives aspect from the prompt even on this route, where the
  // tool's size field is advisory — spell it out so a 16:9 ask cannot come back
  // as a square.
  const userContent = [{ type: "input_text", text: appendSizeHint(prompt, size) }];
  for (const p of images || []) {
    userContent.push({ type: "input_image", image_url: readImageAsDataUrl(p, cwd) });
  }
  const body = {
    model,
    instructions:
      "You are an image generation assistant. " +
      "Always satisfy the request by invoking the image_generation tool exactly once. " +
      "Do not respond with text only.",
    input: [{ role: "user", content: userContent }],
    tools: [
      {
        type: "image_generation",
        output_format: "png",
        quality: quality || "auto",
        ...(size && size !== "auto" ? { size } : {}),
        ...(background ? { background } : {}),
      },
    ],
    tool_choice: { type: "image_generation" },
    stream: true,
    store: false,
  };
  const res = await fetchWithTimeout(
    CODEX_RESPONSES_ENDPOINT,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.access}`,
        ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
        originator: ORIGINATOR,
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    },
    cfgTimeout(cfg, 300000),
  );
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    // 2026-10-16 live A/B on the same token+model: without the image tool the
    // backend streams 200; with it, free-plan tokens get this 400. It is the
    // same image-tool plan gate as the images endpoints' 403, in bad wording.
    if (res.status === 400 && /image_generation|"tools"/i.test(detail)) {
      const e = new Error(
        "the backend rejected the image_generation tool (400) — image generation on the Codex subscription " +
          "routes requires a paid ChatGPT plan (Go/Plus/Pro/Team/Business), or use a non-subscription provider " +
          "like gemini/openrouter. [" + detail.slice(0, 200) + "]",
      );
      e.code = "NO_AUTH";
      throw e;
    }
    throw new Error(`codex responses request failed: ${res.status} ${detail.slice(0, 500)}`);
  }
  for await (const data of sseData(res.body)) {
    if (data === "[DONE]") continue;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    if (json.type === "error" || json.error) {
      throw new Error(`OpenAI API error: ${json.error?.message || json.message || JSON.stringify(json.error || json)}`);
    }
    if (json.type === "response.failed") {
      const m = json.response?.error?.message || json.response?.status_details?.error?.message || "generation response failed";
      throw new Error(`OpenAI response failed: ${m}`);
    }
    if (json.type === "response.created" || json.type === "response.output_item.added") {
      onProgress?.("generating with Codex...", 40);
    }
    if (json.type === "response.output_item.done" && json.item?.type === "image_generation_call" && typeof json.item.result === "string" && json.item.result.length) {
      return Buffer.from(json.item.result, "base64");
    }
  }
  throw new Error("no image_generation result returned by codex backend");
}

function cfgTimeout(cfg, dflt) {
  return Number(cfg?.timeoutMs) || dflt;
}

export const codexProvider = {
  id: "codex",
  supportsImages: true,
  label: "ChatGPT subscription (Codex backend)",
  kind: "subscription",
  note: "Shares the Codex TEXT quota. No API key needed. Paid ChatGPT plans only; free accounts use gptweb2api.",

  async probe(cfg) {
    try {
      const auth = readAuth(cfg);
      // A free token authenticates fine but every image path here is paid-gated;
      // say so before a request is spent (live-verified 2026-06: 403 on the
      // images endpoints, 400 on the orchestrator's image tool).
      if (auth.plan === "free") {
        return {
          available: false,
          auth: "plan-gated",
          detail: `auth ${auth.filePath}, plan free — the Codex image routes require a paid ChatGPT plan; the gptweb2api route works on free plans`,
        };
      }
      const exp = jwtExpiryMs(auth.access);
      return {
        available: true,
        auth: "ok",
        detail: `auth ${auth.filePath}${auth.plan ? `, plan ${auth.plan}` : ""}`,
        expires: exp ? new Date(exp).toISOString() : null,
        clientId: auth.clientId ? "derived-from-token" : "unresolved",
      };
    } catch (e) {
      return { available: false, auth: "missing", detail: e.message };
    }
  },

  async generate({ prompt, size, quality, background, images = [], cwd, onProgress, model: requestedModel }, cfg) {
    // Per-call --model wins over the configured model; both win over the CLI default.
    const model = requestedModel || cfg?.model || null;
    const auth0 = readAuth(cfg);
    let auth = await ensureFreshAuth(auth0, cfg);
    const candidates = modelCandidates({ ...cfg, model });
    if (!candidates.length) {
      const e = new Error("no Codex models available to try");
      e.code = "NO_MODELS";
      throw e;
    }
    let lastErr;
    let refreshed = false;
    // Try the dedicated images endpoints first (no orchestrator model, no text
    // quota). The orchestrator route below stays as the fallback for accounts or
    // regions where they misbehave; opt out with providers.codex.endpoint="responses".
    if (cfg?.endpoint !== "responses") {
        try {
            const buf = await callCodexImagesDirect(auth, { prompt, size, quality, background, images }, cfg, cwd, onProgress);
            return { buffer: buf, meta: { provider: "codex", model: "gpt-image-2", billing: "subscription", endpoint: "images", authFile: auth.filePath } };
        } catch (e) {
            // Auth-class failures (403 plan gating, 401) cannot improve on the
            // orchestrator route below — it authenticates with the same token. Fall
            // back only for availability or request-shape problems.
            if (e.code === "NO_AUTH" || /401|403/.test(e.message)) {
                throw e;
            }
            lastErr = e;
            onProgress?.(`images endpoint failed (${e.message}); falling back to the orchestrator route...`, 20);
        }
    }
    for (let i = 0; i < candidates.length; i++) {
      try {
        if (i > 0) onProgress?.(`retrying with model ${candidates[i]}...`, 30);
        const buf = await callCodex(auth, { prompt, size, quality, model: candidates[i], images, background }, cfg, cwd, onProgress);
        return { buffer: buf, meta: { provider: "codex", model: candidates[i], billing: "subscription", authFile: auth.filePath } };
      } catch (err) {
        lastErr = err;
        if (!refreshed && auth.refresh && /401|unauthorized|invalid_token/i.test(err?.message)) {
          try {
            auth = await refreshAuthToken(auth, cfg);
            refreshed = true;
            i--;
            continue;
          } catch {}
        }
        if (!isModelError(err)) break;
      }
    }
    // Attach a machine-readable signal so the router/report can react.
    if (isQuotaError(lastErr)) lastErr.code = "QUOTA";
    else if (/401|unauthorized|invalid_token/i.test(lastErr?.message)) lastErr.code = "NO_AUTH";
    throw lastErr;
  },
};
