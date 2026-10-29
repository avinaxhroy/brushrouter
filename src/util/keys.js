// Discovery and storage of API keys.
//
// SECURITY MODEL
// --------------
// brushrouter must never expose a credential to a model or to a log. So:
//
//   * Keys are READ from stores that already exist on the machine, or from the
//     environment, or from brushrouter's own 0600 store.
//   * Every key we read is registered with the redactor, so even if a server
//     echoes it back inside an error message, it is replaced with *** before it
//     can reach stdout, stderr, or an MCP response.
//   * Nothing here ever prints a key. `describeKey()` returns only a masked
//     fingerprint (first 4 + length) for user-facing confirmation.
//   * The keys file is created with mode 0600 and its directory 0700.
//
// Nothing is hardcoded: stores are located from HOME/env, and any key name can
// be overridden by environment.

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
// Import the GETTERS, not the frozen constants: BRUSHROUTER_CONFIG_DIR /
// BRUSHROUTER_KEYS_PATH may be set after module load, and a snapshot taken at
// import time would then write a key store the rest of the process never reads.
import { getConfigDir, getKeysPath } from "../config.js";
import { registerSecret } from "./redact.js";

// Auth stores that other agent runtimes already maintain. These are
// product-standard locations (derived from HOME / XDG), not personal paths, so
// this works for any user; absent files are simply skipped. Users with a
// non-standard store can set the relevant BRUSHROUTER_*_KEY env var instead.
function agentAuthFiles() {
  const xdgData = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const appData = process.env.APPDATA || "";
  return [
    getKeysPath(),
    join(homedir(), ".codex", "auth.json"),
    join(xdgData, "opencode", "auth.json"),
    join(xdgConfig, "opencode", "auth.json"),
    join(homedir(), ".pi", "agent", "auth.json"),
    ...(appData ? [join(appData, "opencode", "auth.json"), join(appData, "codex", "auth.json")] : []),
  ];
}

// Environment variable names to try, per provider. The first non-empty wins.
const ENV_NAMES = {
  openrouter: ["BRUSHROUTER_OPENROUTER_KEY", "OPENROUTER_API_KEY", "OPENROUTER_KEY"],
  fal: ["BRUSHROUTER_FAL_KEY", "FAL_KEY", "FAL_API_KEY"],
  openai: ["BRUSHROUTER_OPENAI_KEY", "OPENAI_API_KEY"],
  custom: ["BRUSHROUTER_CUSTOM_KEY"],
};

// Provider id -> candidate key names inside an agent auth.json.
const STORE_NAMES = {
  openrouter: ["openrouter"],
  fal: ["fal", "fal-ai", "falai"],
  openai: ["openai"],
  custom: ["custom", "custom-http"],
};

// Reject obviously-wrong values so a proxy token sitting in OPENAI_API_KEY does
// not silently break OpenAI calls.
function looksLikeRealKey(provider, key) {
  if (!key || typeof key !== "string") return false;
  const k = key.trim();
  if (k.length < 12) return false;
  if (/^(your|changeme|placeholder|xxx|none|null|undefined)/i.test(k)) return false;
  if (provider === "openai" && !/^sk-/.test(k) && !/^sess-/.test(k)) return false;
  if (provider === "openrouter" && !/^sk-or-/.test(k) && !/^sk-/.test(k)) return false;
  return true;
}

function extractKey(entry) {
  if (typeof entry === "string") return entry;
  return entry?.key || entry?.apiKey || entry?.api_key || entry?.token || null;
}

// Returns { key, source } or null. `source` is safe to display (never the key).
export function discoverKey(provider, fileCache = null) {
  for (const env of ENV_NAMES[provider] || []) {
    if (looksLikeRealKey(provider, process.env[env])) {
      registerSecret(process.env[env]);
      return { key: process.env[env], source: `env:${env}` };
    }
  }
  const names = STORE_NAMES[provider] || [provider];
  for (const file of agentAuthFiles()) {
    let data;
    if (fileCache && fileCache.has(file)) {
      data = fileCache.get(file);
    } else {
      if (!existsSync(file)) {
        if (fileCache) fileCache.set(file, null);
        continue;
      }
      try {
        data = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        data = null;
      }
      if (fileCache) fileCache.set(file, data);
    }
    if (!data) continue;
    for (const name of names) {
      const key = extractKey(data?.[name]);
      if (looksLikeRealKey(provider, key)) {
        registerSecret(key);
        // Show a home-relative path so we never leak a username into output.
        const shown = file.startsWith(homedir()) ? `~${file.slice(homedir().length)}` : file;
        return { key, source: `${shown}#${name}` };
      }
    }
  }
  return null;
}

export function discoverAll() {
  const fileCache = new Map();
  const out = {};
  for (const p of ["openrouter", "fal", "openai", "custom"]) out[p] = discoverKey(p, fileCache);
  return out;
}

// A safe, non-reversible-ish fingerprint for confirming to a human which key is
// in use, without revealing it.
export function describeKey(key) {
  if (!key || typeof key !== "string") return "(none)";
  const prefix = key.slice(0, 4);
  return `${prefix}…${"*".repeat(6)} (${key.length} chars)`;
}

// Persist a key into brushrouter's own store (0600). Used by `setup`, and by
// nothing else. Returns the path written.
export function saveKey(provider, key) {
  if (!looksLikeRealKey(provider, key)) {
    const e = new Error(`that does not look like a valid ${provider} key`);
    e.code = "BAD_KEY";
    throw e;
  }
  // Resolve both paths ONCE, at use time, so an env override set after import
  // (tests, `setup`, an embedder) lands in the store this call actually writes.
  const configDir = getConfigDir();
  const keysPath = getKeysPath();
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  // mkdirSync does not tighten the mode of a directory that already exists, so
  // enforce 0700 explicitly — the key store lives here.
  try {
    chmodSync(configDir, 0o700);
  } catch {}
  let data = {};
  if (existsSync(keysPath)) {
    try {
      data = JSON.parse(readFileSync(keysPath, "utf8"));
    } catch (e) {
      // Never silently reset: `data = {}` here used to overwrite a real store
      // with one entry, destroying every other key with no backup and no word to
      // the user. Move the damaged file aside first, so the old contents are
      // recoverable and `setup` can still finish.
      const backup = `${keysPath}.corrupt-${Date.now()}`;
      try {
        renameSync(keysPath, backup);
      } catch (renameErr) {
        // Could not preserve it — refuse to write rather than lose it silently.
        const err = new Error(
          `cannot read ${keysPath} (${e.message}) and cannot move it aside (${renameErr.message}); ` +
            `refusing to overwrite it. Fix or remove the file, then retry.`,
        );
        err.code = "KEYS_CORRUPT";
        throw err;
      }
      if (!data || typeof data !== "object") data = {};
      process.stderr.write(
        `brushrouter: warning: ${keysPath} was not valid JSON (${e.message}); ` +
          `moved it to ${backup} and continued with an empty key store. ` +
          `Keys in the old file are not active — re-add them or restore that backup.\n`,
      );
    }
  }
  const name = (STORE_NAMES[provider] || [provider])[0];
  data[name] = { key: key.trim() };
  writeFileSync(keysPath, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(keysPath, 0o600);
  } catch {}
  registerSecret(key.trim());
  return keysPath;
}

export function hasStoredKey(provider) {
  return discoverKey(provider) !== null;
}
