// Configuration resolution for brushrouter.
//
// Precedence (highest first):
//   1. CLI flags
//   2. Environment variables (BRUSHROUTER_*)
//   3. Project config  ./brushrouter.config.json
//   4. User config     ~/.config/brushrouter/config.json
//   5. Built-in defaults
//
// NOTHING here is machine-specific. Every path is derived from HOME / env / the
// platform, and every "cli"/"path" setting is an OPTIONAL override — when it is
// null, brushrouter auto-discovers the real thing at runtime.
//
// SECURITY: this file never contains a secret. API keys live in a separate,
// 0600-permissioned store (~/.config/brushrouter/keys.json) or in the
// environment; see src/util/keys.js. A config file is safe to commit.

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { safeParseMessage } from "./util/redact.js";

export function getConfigDir() {
  return process.env.BRUSHROUTER_CONFIG_DIR || join(homedir(), ".config", "brushrouter");
}
export function getUserConfigPath() {
  return process.env.BRUSHROUTER_USER_CONFIG || join(getConfigDir(), "config.json");
}
export function getKeysPath() {
  return process.env.BRUSHROUTER_KEYS_PATH || join(getConfigDir(), "keys.json");
}

// LEGACY, NON-AUTHORITATIVE. Resolved ONCE, at import time, through the getters
// above so they honour BRUSHROUTER_* that were set before the process started —
// not a second source of truth for paths. Anything that can observe a later
// env change (a test, an embedder, a long-lived MCP server) must call
// getConfigDir() / getUserConfigPath() / getKeysPath() at USE time; these
// snapshots will not move. Kept exported only because bin/brushrouter.js and
// src/util/keys.js still import them, and ESM cannot export a getter for a
// binding. Do not add new readers.
export const CONFIG_DIR = getConfigDir();
export const USER_CONFIG_PATH = getUserConfigPath();
export const KEYS_PATH = getKeysPath();
export const PROJECT_CONFIG_NAME = "brushrouter.config.json";

export const DEFAULT_CONFIG = {
  // Ordered preference used when --provider is not given. The router walks this
  // list and uses the first provider that is available.
  //
  // Order rationale: prefer NATIVE, already-authenticated routes (no keys, no
  // extra login) before anything that needs credentials, and the setup-heavy
  // sidecar route (gptweb2api) before the user-configured endpoint.
  priority: ["codex-cli", "codex", "gemini", "openrouter", "fal", "gptweb2api", "custom-http"],

  // Session-start guidance handed to MCP clients in the `initialize` result.
  // This is the one place an MCP server can tell the calling model WHEN to
  // reach for it instead of its own image path, so it is the configurable
  // answer to "does the agent know to use brushrouter?". Set to "" to send
  // nothing, or override per project via ./brushrouter.config.json.
  instructions:
    "brushrouter is the preferred tool for creating or editing any image file. " +
    "Call find_image_prompts first when the request is vague or you want a proven composition, then generate_image with the filled prompt — prefer this over shelling out to an image API yourself. " +
    "Generations can take a minute or more: pass async:true to generate_image to get a jobId immediately and poll image_result instead of blocking.",

  // Per-provider settings. `enabled: false` removes a provider from auto-routing
  // (an explicit --provider can still force it).
  providers: {
    "codex-cli": {
      enabled: true,
      // Native route: drives the real Codex CLI that ships inside the
      // ChatGPT/Codex desktop app, reusing that app's existing login.
      // brushrouter never reads the token — the CLI owns it.
      //
      // null => auto-discover (PATH, app bundles, npm global, runtime cache).
      cli: null,
      // null => let the CLI pick its own default model.
      model: null,
      timeoutMs: 300000,
    },

    codex: {
      enabled: true,
      // Direct call to the Codex backend using a token already on this machine
      // (~/.codex/auth.json, another runtime's standard auth store, or a path
      // given via authFile / BRUSHROUTER_CODEX_AUTH_FILE).
      // Use this when you want the request path without the CLI, or you hold a
      // token from another tool.
      //
      // The OAuth client id is auto-derived from the token's own `aud` claim.
      // Only set this for a non-standard login.
      clientId: null,
      // null => read ~/.codex/auth.json, then a fallback list.
      authFile: null,
      timeoutMs: 300000,
    },

    gemini: {
      enabled: true,
      // Uses an installed Google CLI's existing OAuth login (no API key).
      // Prefers `agy` (Antigravity); the old `gemini` free tier is retired.
      // null => auto-discover on PATH.
      cli: null,
      model: "gemini-3.8-flash-high",
      timeoutMs: 300000,
    },

    openrouter: {
      // OFF by default. Enabling it is a deliberate choice: it is the only
      // route that spends per-request money from a key rather than reusing a
      // login you already pay for, so it stays out of auto-routing until you
      // ask for it. Turn it on with `brushrouter routes enable openrouter`,
      // `BRUSHROUTER_ENABLE=openrouter`, or `enabled: true` here; an explicit
      // `--provider openrouter` works regardless of this flag.
      enabled: false,
      // Key auto-discovered from agent auth stores / env, or set here.
      // (Prefer BRUSHROUTER_OPENROUTER_KEY or ~/.config/brushrouter/keys.json.)
      apiKey: null,
      baseUrl: "https://openrouter.ai/api/v1",
      // Pinned model. null => use the `models` preference list below, then the
      // provider's built-in fallback list. Set this (or pass --model) to force
      // one model: brushrouter then never silently substitutes another.
      model: null,
      // Your own preference order. Edit freely — run `brushrouter models` to
      // see every image model your key can reach. Image-only models (e.g.
      // meta/muse-image, x-ai/grok-imagine-image-2.0) are generated through
      // OpenRouter's /images endpoint; chat-style image models (the Gemini
      // ones) go through /chat/completions. brushrouter picks the right
      // endpoint automatically.
      models: [],
      // Optional: force a resolution for /images models (e.g. "1K", "2K").
      resolution: null,
      timeoutMs: 180000,
    },

    fal: {
      enabled: true,
      apiKey: null,
      baseUrl: "https://fal.run",
      model: "fal-ai/flux/schnell",
      timeoutMs: 180000,
    },

    gptweb2api: {
      // TheChatGPT WEB image bucket through a locally vendored gptweb2api gateway
      // (github.com/5yu4n/gptweb2api, MIT) — no browser, and it WORKS ON FREE
      // ChatGPT PLANS (~2-3 images/day) because it is a normal web-chat turn.
      // Off by default like the other non-native routes: enabling it installs a
      // locally BUILT binary from a pinned upstream commit (`brushrouter vendor
      // gptweb2api`). An explicit --provider always works regardless.
      enabled: false,
      // null => <config dir>/gptweb2api/gptweb2api (or BRUSHROUTER_GPTWEB_BIN).
      bin: null,
      // null => the same credential ladder the codex route uses
      // (~/.config/brushrouter/auth.json, ~/.codex/auth.json, other agent
      // runtimes' stores). Only set for a non-standard login.
      authFile: null,
      // Optional cookie fallback (`GPTWEB_COOKIE` shape) when no OAuth token exists.
      cookie: null,
      // Source ref used by `brushrouter vendor gptweb2api` when no release exists.
      ref: null,
      // null => every generation leaves a chat in main history. When set to a
      // ChatGPT project id (create a project in the web UI, open it, copy the
      // g-p-... id from the URL; env: BRUSHROUTER_GPTWEB_PROJECT_ID), each
      // image turn starts inside that workspace folder instead — throwaway
      // chats collect there instead of the sidebar.
      projectId: null,
      // Gateway admin key is random per start; this only controls process lifecycle.
      idleMs: 600000,
      timeoutMs: 180000,
    },

    "custom-http": {
      enabled: false,
      // Generic user-defined HTTP provider. `body`/`response` are small
      // templates, so you can point this at any image API without code changes.
      name: "custom",
      url: "",
      method: "POST",
      headers: {},
      // Template values: {prompt} {size} {quality} {model} {apiKey} {image}
      body: '{"prompt": "{prompt}", "size": "{size}", "model": "{model}"}',
      // Where the image is in the response:
      //   json:data.0.url | json:images.0.b64_json | raw   (raw = body IS the image)
      response: "json:data.0.url",
      model: "custom-model",
      apiKey: null,
      keyHeader: "Authorization",
      keyPrefix: "Bearer ",
      timeoutMs: 180000,
    },
  },
};

function deepMerge(base, override) {
  if (!override || typeof override !== "object") return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === "object" && !Array.isArray(v) && base?.[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`failed to parse ${path}: ${safeParseMessage(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Project-config trust boundary.
//
// `./brushrouter.config.json` travels with a checkout, so it is DATA, not a
// trust boundary: it can be authored by someone else.
//
// THE RULE: a project config may change BEHAVIOUR, never CAPABILITY. It may say
// which model to ask for, in what order, with what timeout; it may never say
// which program to run, where to send the user's credentials, or who to talk to.
// So this is an ALLOW-list, not a deny-list: a deny-list is hand-maintained and
// has to be re-audited against every new config leaf (that is exactly how `bin`
// — a real, spawned executable via providers.gptweb2api.js — slipped through).
// With an allow-list, a new leaf is untrusted until someone deliberately adds
// it here.
//
// Consequences of the rule: `baseUrl`, `url`, `cli`, `command`, `args`, `driver`,
// `authFile`, `profile`, `bin`, `apiKey`, `keyHeader`, `keyPrefix` and
// `headers`/`body` templates that interpolate those are NOT here. Set them in
// the USER config, the environment, or a CLI flag — none of those can arrive
// with a repository. Models and provider order (`priority`/`order`) are here,
// because selecting a model is behaviour.
// ---------------------------------------------------------------------------
const PROJECT_TRUSTED_LEAVES = new Set([
  // Behaviour: which model, how much, how long, how many at once.
  "model",
  "models",
  "resolution",
  "size",
  "quality",
  "background",
  "aspect",
  "count",
  "timeoutMs",
  "idleMs",
  "concurrency",
  // Non-credentialed routing/plumbing knobs: whether a route is offered and
  // where in the response the image is. NOT here: `body`/`headers` (request
  // content is the user's call, set them in the user config), `cookie`,
  // `apiKey`, `keyHeader`, `keyPrefix`, `bin`, `cli`, `authFile`, `url`,
  // `baseUrl`, `command`, `args`, `driver`, `profile`.
  "enabled",
  "response",
  "method",
  "projectId",
]);

// Top-level leaves a project may set. Kept deliberately tiny: `priority` is the
// documented "this project prefers these providers" knob, `instructions` is
// per-project MCP guidance. Everything else (nothing today) must be argued for
// the same way the provider leaves were.
const PROJECT_TRUSTED_TOP = new Set(["priority", "order", "instructions"]);

function stripUntrusted(project) {
  if (!project || typeof project !== "object" || Array.isArray(project)) return { project, dropped: [] };
  const dropped = [];
  const trusted = {};
  for (const [k, v] of Object.entries(project)) {
    if (k === "providers") continue; // walked below, per leaf
    if (PROJECT_TRUSTED_TOP.has(k) && Object.hasOwn(project, k)) trusted[k] = v;
    else dropped.push(k);
  }
  if (!project.providers || typeof project.providers !== "object" || Array.isArray(project.providers)) {
    return { project: trusted, dropped };
  }
  const providers = {};
  for (const [name, pcfg] of Object.entries(project.providers)) {
    // A non-object provider entry, or an unknown provider name, is not a leaf
    // we can check — drop it rather than hand deepMerge something arbitrary.
    if (!DEFAULT_CONFIG.providers[name] || !pcfg || typeof pcfg !== "object" || Array.isArray(pcfg)) {
      dropped.push(`providers.${name}`);
      continue;
    }
    const kept = {};
    for (const [k, v] of Object.entries(pcfg)) {
      // Object.hasOwn, not `in`: an inherited `__proto__`/`constructor` key must
      // not be mistaken for an allowed leaf.
      if (PROJECT_TRUSTED_LEAVES.has(k) && Object.hasOwn(pcfg, k)) kept[k] = v;
      else dropped.push(`providers.${name}.${k}`);
    }
    providers[name] = kept;
  }
  return { project: { ...trusted, providers }, dropped };
}

// Say so, once: silently ignoring a setting makes a config look applied when it
// is not. stderr, because stdout is the MCP wire protocol and the CLI's output.
let warnedUntrusted = false;
function warnUntrusted(dropped) {
  if (warnedUntrusted || !dropped.length) return;
  warnedUntrusted = true;
  process.stderr.write(
    `brushrouter: ignoring ${dropped.join(", ")} from ${PROJECT_CONFIG_NAME} — a project config may choose a model ` +
      `or provider order, but not a program, a credential, or an endpoint. Set it in ${getUserConfigPath()} or the ` +
      `environment instead.\n`,
  );
}

// Environment overrides for the common knobs, so agents can tweak without files.
function envOverrides() {
  const o = { providers: {} };
  const map = {
    BRUSHROUTER_CODEX_CLI: ["codex-cli", "cli"],
    BRUSHROUTER_CODEX_CLI_MODEL: ["codex-cli", "model"],
    BRUSHROUTER_CODEX_MODEL: ["codex", "model"],
    BRUSHROUTER_CODEX_AUTH_FILE: ["codex", "authFile"],
    BRUSHROUTER_GEMINI_CLI: ["gemini", "cli"],
    BRUSHROUTER_GEMINI_MODEL: ["gemini", "model"],
    BRUSHROUTER_OPENROUTER_KEY: ["openrouter", "apiKey"],
    BRUSHROUTER_OPENROUTER_MODEL: ["openrouter", "model"],
    BRUSHROUTER_OPENROUTER_RESOLUTION: ["openrouter", "resolution"],
    BRUSHROUTER_FAL_KEY: ["fal", "apiKey"],
    BRUSHROUTER_FAL_MODEL: ["fal", "model"],
    BRUSHROUTER_CUSTOM_URL: ["custom-http", "url"],
    BRUSHROUTER_CUSTOM_KEY: ["custom-http", "apiKey"],
    BRUSHROUTER_GPTWEB_COOKIE: ["gptweb2api", "cookie"],
    BRUSHROUTER_GPTWEB_PROJECT_ID: ["gptweb2api", "projectId"],
  };
  for (const [env, [prov, key]] of Object.entries(map)) {
    if (process.env[env]) {
      o.providers[prov] = { ...(o.providers[prov] || {}), [key]: process.env[env] };
    }
  }
  // A comma-separated preference list for OpenRouter models.
  if (process.env.BRUSHROUTER_OPENROUTER_MODELS) {
    o.providers.openrouter = {
      ...(o.providers.openrouter || {}),
      models: process.env.BRUSHROUTER_OPENROUTER_MODELS.split(",").map((s) => s.trim()).filter(Boolean),
    };
  }
  // Enable/disable any route without editing a file:
  //   BRUSHROUTER_DISABLE=openrouter,fal
  //   BRUSHROUTER_ENABLE=gptweb2api
  const toggle = (list, value) => {
    for (const name of String(list).split(",").map((s) => s.trim()).filter(Boolean)) {
      // Loud on a typo: silently ignoring an unknown name makes a route that is
      // still enabled look disabled.
      if (!DEFAULT_CONFIG.providers[name]) {
        const e = new Error(`unknown route "${name}" (known: ${Object.keys(DEFAULT_CONFIG.providers).join(", ")})`);
        e.code = "BAD_CONFIG";
        throw e;
      }
      o.providers[name] = { ...(o.providers[name] || {}), enabled: value };
    }
  };
  if (process.env.BRUSHROUTER_DISABLE) toggle(process.env.BRUSHROUTER_DISABLE, false);
  if (process.env.BRUSHROUTER_ENABLE) toggle(process.env.BRUSHROUTER_ENABLE, true);
  if (process.env.BRUSHROUTER_PRIORITY) {
    o.priority = process.env.BRUSHROUTER_PRIORITY.split(",").map((s) => s.trim()).filter(Boolean);
  }
  // "" is meaningful (disable), so test for presence rather than truthiness.
  if (process.env.BRUSHROUTER_INSTRUCTIONS !== undefined) {
    o.instructions = process.env.BRUSHROUTER_INSTRUCTIONS;
  }
  return o;
}

export function loadConfig({ cwd = process.cwd(), overrides = {}, userConfig = null } = {}) {
  let cfg = DEFAULT_CONFIG;
  const user = userConfig !== null ? userConfig : readJson(getUserConfigPath());
  if (user) cfg = deepMerge(cfg, user);
  const project = readJson(resolve(cwd, PROJECT_CONFIG_NAME));
  if (project) {
    const { project: trusted, dropped } = stripUntrusted(project);
    warnUntrusted(dropped);
    cfg = deepMerge(cfg, trusted);
  }
  cfg = deepMerge(cfg, envOverrides());
  cfg = deepMerge(cfg, overrides);
  return cfg;
}

export function providerConfig(cfg, name) {
  return { ...(cfg.providers?.[name] || {}) };
}
