// Google image generation via an installed Google CLI's OAuth login.
//
// Two CLIs are supported, tried in order:
//   1. `agy`  — the Antigravity CLI (successor to Gemini Code Assist).
//      Has native image generation (gemini-3.1-flash-image-preview).
//   2. `gemini` — the older Gemini CLI. Its individual free tier is being
//      retired by Google, so this may report IneligibleTierError; we surface
//      that clearly instead of pretending it works.
//
// We delegate to the CLI rather than calling Google APIs directly so we never
// handle the user's Google tokens ourselves.

import { existsSync, readFileSync, mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { appendTailed } from "../util/common.js";
import { resolveExecutable } from "../util/discover.js";
import { registerSecret } from "../util/redact.js";

function run(cmd, args, { timeoutMs = 180000, cwd, env, shell = false } = {}) {
  return new Promise((resolve) => {
    const isWindowsCmd = process.platform === "win32" && (cmd.endsWith(".cmd") || cmd.endsWith(".bat"));
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
      shell: shell || isWindowsCmd,
    });
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve({ code: 124, stdout, stderr: stderr + "\ntimed out" });
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout = appendTailed(stdout, d)));
    child.stderr.on("data", (d) => (stderr = appendTailed(stderr, d)));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + `\n${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function findNewestImage(dir, sinceMs = 0) {
  let best = null;
  let bestTime = 0;
  const walk = (d, depth = 0) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
        continue;
      }
      if (!/\.(png|jpe?g|webp|gif)$/i.test(e.name)) continue;
      try {
        const t = statSync(p).mtimeMs;
        // `sinceMs` guards against returning a stale image from a previous run.
        if (t >= sinceMs && t > bestTime) {
          bestTime = t;
          best = p;
        }
      } catch {}
    }
  };
  walk(dir);
  return best;
}

// Which Google CLI should we use? Explicit cfg.cli wins, else probe.
//
// SECURITY: resolving a configured program used to run
// `/usr/bin/env sh -c "command -v <bin>"`. `bin` comes from
// providers.gemini.cli / BRUSHROUTER_GEMINI_CLI, so a config file could append
// `; curl ... | sh` and get shell execution out of a lookup that never needed a
// shell. resolveExecutable() does the same PATH scan (plus an explicit path)
// with no shell involved.
function resolveCli(cfg) {
  if (cfg?.cli) {
    const p = resolveExecutable(cfg.cli);
    return p ? { bin: cfg.cli, path: p, flavor: cfg.cli.includes("agy") ? "antigravity" : "gemini" } : null;
  }
  for (const [bin, flavor] of [
    ["agy", "antigravity"],
    ["gemini", "gemini"],
  ]) {
    const p = resolveExecutable(bin);
    if (p) return { bin, path: p, flavor };
  }
  return null;
}

// Antigravity keeps its OAuth credentials in a standalone token file. We treat
// the provider as logged in only when that file holds a usable token (access or
// refresh) — otherwise generation would fail with an auth error.
function antigravityCreds() {
  const p = join(homedir(), ".gemini", "jetski-standalone-oauth-token");
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    const t = j.token || {};
    const access = typeof t.access_token === "string" ? t.access_token : null;
    const refresh = typeof t.refresh_token === "string" ? t.refresh_token : null;
    if (!access && !refresh) return null;
    // Register by value: `ya29.*` is covered by a shape, an opaque refresh
    // token is not, and this provider is the only reader of these files.
    registerSecret(access);
    registerSecret(refresh);
    const expMs = t.expiry ? Date.parse(t.expiry) : null;
    return { path: p, access, refresh, expMs, authMethod: j.auth_method || null };
  } catch {
    return null;
  }
}

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash-high";

const AGY_AGENT_MODELS = new Set([
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
]);

async function generateWithAntigravity(cli, { prompt, onProgress, model: requestedModel }, cfg) {
  const timeoutMs = Number(cfg?.timeoutMs) || 300000;
  const work = mkdtempSync(join(tmpdir(), "brushrouter-agy-"));
  try {
    const model = requestedModel || cfg?.model || DEFAULT_GEMINI_MODEL;
    onProgress?.(`generating via Antigravity CLI (${model})...`, 20);
    const isAgyAgentModel = AGY_AGENT_MODELS.has(model);
    const agyModelFlag = isAgyAgentModel ? model : DEFAULT_GEMINI_MODEL;
    const modelMention = isAgyAgentModel ? "" : ` using ${model}`;
    const instruction =
      `Generate an image for this prompt${modelMention} and save the resulting image file in the current ` +
      `directory as brushrouter-out.png: ${prompt}`;
    const started = Date.now();
    const args = [
      "--print",
      instruction,
      "--dangerously-skip-permissions",
      "--print-timeout",
      // Must stay below run()'s outer kill timer, or brushrouter SIGKILLs agy
      // before it can return partial output + a saved image on slow turns.
      `${Math.max(30, Math.floor((timeoutMs - 5000) / 1000))}s`,
      "--model",
      agyModelFlag,
    ];
    const r = await run(cli.bin, args, {
      timeoutMs,
      cwd: work,
    });
    // The CLI is not guaranteed to honour the working directory: it sometimes
    // writes to its own scratch area instead. Look in both places, and only
    // accept a file created during THIS run so a stale image is never returned.
    const found =
      findNewestImage(work, started) ||
      findNewestImage(join(homedir(), ".gemini", "antigravity-cli", "scratch"), started) ||
      findNewestImage(work) ||
      parseImagePathFromOutput(r.stdout);
    if (found) return { buffer: readFileSync(found), meta: { provider: "gemini", cli: "agy", model } };
    throw failedFromCli("agy", r);
  } finally {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {}
  }
}

async function generateWithGemini(cli, { prompt, onProgress, model: requestedModel }, cfg) {
  const model = requestedModel || cfg?.model || "gemini-2.5-flash-image";
  const work = mkdtempSync(join(tmpdir(), "brushrouter-gemini-"));
  try {
    onProgress?.("generating via gemini CLI...", 20);
    const instruction =
      `Generate an image and save it as the file "brushrouter-out.png" in the current directory. ` +
      `Use your image generation capability. Do not ask for confirmation. Prompt: ${prompt}`;
    const started = Date.now();
    const r = await run(cli.bin, ["--skip-trust", "-m", model, "-p", instruction, "-y"], {
      timeoutMs: Number(cfg?.timeoutMs) || 180000,
      cwd: work,
      env: { GEMINI_CLI_TRUST_WORKSPACE: "true" },
    });
    const found =
      findNewestImage(work, started) || findNewestImage(work) || parseImagePathFromOutput(r.stdout);
    if (found) return { buffer: readFileSync(found), meta: { provider: "gemini", cli: "gemini", model } };
    throw failedFromCli("gemini", r);
  } finally {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {}
  }
}

// The CLI often prints the path it saved to (in markdown link or plain form).
// Using it is more reliable than guessing from the filesystem.
function parseImagePathFromOutput(stdout) {
  const text = String(stdout || "");
  const patterns = [
    /file:\/\/([^\s)\]"']+\.(?:png|jpe?g|webp|gif))/gi,
    /([a-zA-Z]:[\\/][^\s)\]"']+\.(?:png|jpe?g|webp|gif))/gi,
    /(\/[^\s)\]"']+\.(?:png|jpe?g|webp|gif))/gi,
  ];
  for (const re of patterns) {
    const matches = [...text.matchAll(re)];
    for (let i = matches.length - 1; i >= 0; i--) {
      try {
        const raw = matches[i][1];
        const p = decodeURIComponent(raw.startsWith("/") && raw.length > 2 && raw[2] === ":" ? raw.slice(1) : raw);
        if (existsSync(p)) return p;
      } catch {}
    }
  }
  return null;
}

function failedFromCli(name, r) {
  const blob = `${r.stdout}\n${r.stderr}`;
  const err = new Error(
    `${name} produced no image (exit ${r.code})` +
      (blob.trim() ? `: ${blob.split("\n").filter((l) => l.trim()).slice(-2).join(" ").slice(0, 300)}` : ""),
  );
  if (/IneligibleTier|UNSUPPORTED_CLIENT|no longer supported/i.test(blob)) {
    err.code = "DEPRECATED";
    err.message =
      "the gemini CLI's individual free tier has been retired by Google. " +
      "Use the Antigravity CLI (`agy`) or another provider.";
  } else if (/Authentication required|log in|login|credential|401|invalid authentication/i.test(blob)) {
    err.code = "NO_AUTH";
  } else {
    err.code = "FAILED";
  }
  return err;
}

export const geminiProvider = {
  id: "gemini",
  supportsImages: false,
  label: "Google (Antigravity / Gemini CLI)",
  kind: "cli-oauth",
  note: "Uses an installed Google CLI's login. Prefers `agy` (Antigravity); the old gemini free tier is retired.",

  async probe(cfg) {
    const cli = await resolveCli(cfg);
    if (!cli) return { available: false, auth: "missing", detail: "neither `agy` nor `gemini` found on PATH" };
    if (cli.flavor === "gemini") {
      const creds = join(homedir(), ".gemini", "oauth_creds.json");
      let exp = null;
      if (existsSync(creds)) {
        try {
          const c = JSON.parse(readFileSync(creds, "utf8"));
          exp = c.expiry_date ? new Date(c.expiry_date).toISOString() : null;
        } catch {}
      }
      return {
        available: false,
        auth: "deprecated",
        detail: `${cli.path} — Google retired the individual free tier; prefer \`agy\``,
        expires: exp,
      };
    }
    // Antigravity: only report ready if it actually has a login stored.
    const creds = antigravityCreds();
    if (!creds) {
      return {
        available: false,
        auth: "needs-login",
        detail: `run \`${cli.bin}\` once and sign in (one-time) to enable this provider`,
      };
    }
    const expired = creds.expMs ? Date.now() > creds.expMs : false;
    if (expired && !creds.refresh) {
      return { available: false, auth: "expired", detail: "Antigravity token expired; re-run the CLI to sign in" };
    }
    return {
      available: true,
      auth: "ok",
      detail: `${cli.path} (Antigravity${creds.authMethod ? `, ${creds.authMethod}` : ""})`,
      expires: creds.expMs ? new Date(creds.expMs).toISOString() : null,
    };
  },

  async generate({ prompt, onProgress, model: requestedModel }, cfg) {
    const cli = await resolveCli(cfg);
    if (!cli) {
      const e = new Error("neither `agy` nor `gemini` is installed");
      e.code = "NO_AUTH";
      throw e;
    }
    if (cli.flavor === "antigravity") return generateWithAntigravity(cli, { prompt, onProgress, model: requestedModel }, cfg);
    return generateWithGemini(cli, { prompt, onProgress, model: requestedModel }, cfg);
  },
};
