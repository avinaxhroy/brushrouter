// Codex CLI provider — the NATIVE route.
//
// Instead of re-implementing a browser session, this provider drives the real
// Codex CLI that the ChatGPT/Codex desktop app already ships (a signed native
// binary). Benefits:
//
//   * No second browser, no separate login, no selector scraping.
//   * The CLI owns its credentials end-to-end — brushrouter never reads, holds,
//     logs, or transmits the user's OAuth token. We only spawn a child process
//     and read the image it writes to disk.
//   * It is the vendor's supported interface, so it keeps working when the web
//     UI changes.
//
// SECURITY: `--json` output is parsed only for the image path. Any text we
// surface is passed through redact() so a credential echoed by the CLI in an
// error can never reach a model.

import { existsSync, readFileSync, mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { appendTailed } from "../util/common.js";
import { findCodexCli } from "../util/discover.js";
import { openaiJwtClaim } from "./codex.js";
import { redact } from "../util/redact.js";

function run(cmd, args, { timeoutMs = 300000, cwd, env, input, shell = false } = {}) {
  return new Promise((resolve) => {
    const isWindowsCmd = process.platform === "win32" && (cmd.endsWith(".cmd") || cmd.endsWith(".bat"));
    const child = spawn(cmd, args, {
      cwd,
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
      shell: shell || isWindowsCmd,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve({ code: 124, stdout, stderr: stderr + "\ntimed out", timedOut: true });
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
    if (input) child.stdin.end(input);
  });
}

// Newest image under a directory tree (the CLI writes images next to the cwd).
function findNewestImage(dir) {
  let best = null;
  let bestTime = 0;
  const walk = (d, depth = 0) => {
    if (depth > 4) return;
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
        if (t > bestTime) {
          bestTime = t;
          best = p;
        }
      } catch {}
    }
  };
  walk(dir);
  return best;
}

// The CLI's own auth store: CODEX_HOME (standard for the Codex CLI) or
// ~/.codex. We never read the token out of it and never send it anywhere — we
// decode only the non-secret `plan` claim, to skip a guaranteed-failure run
// (live-verified 2026-06: on a free plan the CLI's image tool errors after
// ~100k input tokens of text quota are spent, then produces no image).
function cliAuthPlan() {
  try {
    const dir = process.env.CODEX_HOME || join(homedir(), ".codex");
    const raw = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
    const tok = raw.tokens?.access_token || raw.openai?.access;
    return tok ? openaiJwtClaim(tok)?.plan || null : null;
  } catch {
    return null;
  }
}

function classify(blob, code) {
  if (/usage_limit_reached|usage limit has been reached|hit your usage limit/i.test(blob)) return "QUOTA";
  if (/not logged in|unauthenticated|401|invalid_client|authentication|please run .?codex login/i.test(blob)) return "NO_AUTH";
  if (/model.*(not found|does not exist|not supported)/i.test(blob)) return "MODEL";
  if (code === 124) return "TIMEOUT";
  return "FAILED";
}

export const codexCliProvider = {
  id: "codex-cli",
  supportsImages: true,
  label: "Codex CLI (bundled with the desktop app)",
  kind: "native-cli",
  note: "Native and vendor-supported: uses the app's own signed CLI and its existing login. brushrouter never touches the token.",

  // Cheap, credential-free health check: does a usable CLI exist, and does it
  // consider itself logged in?
  async probe(cfg) {
    const cli = findCodexCli({ explicit: cfg?.cli });
    if (!cli) {
      return {
        available: false,
        auth: "missing",
        detail: "no Codex CLI found (install the ChatGPT/Codex app, or set providers.codex-cli.cli)",
      };
    }
    const args = [...cli.argsPrefix, "login", "status"];
    const r = await run(cli.command, args, { timeoutMs: 20000 });
    const blob = `${r.stdout}\n${r.stderr}`;
    const loggedIn = /logged in/i.test(blob) && !/not logged in/i.test(blob);
    if (!loggedIn) {
      return {
        available: false,
        auth: "needs-login",
        detail: `${cli.path} found (${cli.version}), but not logged in — run \`codex login\``,
      };
    }
    const mode = /chatgpt/i.test(blob) ? "ChatGPT subscription" : /api key/i.test(blob) ? "API key" : "unknown";
    // A ChatGPT-subscription login on a free plan can never produce an image
    // here (tool plan gate) — report unavailable so the router moves on to a
    // usable route instead of spending the CLI's text quota on a failed turn.
    if (mode === "ChatGPT subscription" && cliAuthPlan() === "free") {
      return {
        available: false,
        auth: "plan-gated",
        detail: `${cli.path} (${cli.version}); ChatGPT login plan 'free' — the Codex CLI image tool requires a paid ChatGPT plan; the gptweb2api route works on free plans`,
      };
    }
    return {
      available: true,
      auth: "ok",
      detail: `${cli.path} (${cli.version}); logged in via ${mode}`,
      // Deliberately no expiry/token data: we never read credentials.
    };
  },

  async generate({ prompt, size, quality, images = [], cwd, onProgress, model: requestedModel }, cfg) {
    // Per-call --model wins over the configured model; both win over the CLI default.
    const model = requestedModel || cfg?.model || null;
    const cli = findCodexCli({ explicit: cfg?.cli });
    if (!cli) {
      const e = new Error("no Codex CLI found — install the ChatGPT/Codex desktop app, or set providers.codex-cli.cli");
      e.code = "NO_AUTH";
      throw e;
    }
    // Work in a scratch dir so we can identify exactly the image this run wrote.
    const work = mkdtempSync(join(tmpdir(), "brushrouter-codexcli-"));
    try {
      const outFile = join(work, "brushrouter-out.png");
      const instruction = [
        "Generate an image and save it to disk.",
        `Write the image file to exactly this absolute path: ${outFile}`,
        "Use your image generation capability. Do not ask for confirmation. Do not print the image data.",
        size && size !== "auto" ? `Preferred size: ${size}.` : "",
        quality && quality !== "auto" ? `Preferred quality: ${quality}.` : "",
        `Prompt: ${prompt}`,
      ]
        .filter(Boolean)
        .join(" ");

      const absImages = images.map((p) => (isAbsolute(p) ? p : resolve(cwd || process.cwd(), p)));
      const args = [
        ...cli.argsPrefix,
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--ephemeral",
        "--json",
        "--skip-git-repo-check",
        "-C",
        work,
        ...(model ? ["-m", model] : []),
        ...absImages.flatMap((p) => ["-i", p]),
        instruction,
      ];

      onProgress?.("generating via the native Codex CLI...", 20);
      const r = await run(cli.command, args, {
        cwd: work,
        timeoutMs: Number(cfg?.timeoutMs) || 300000,
      });

      // 1. Prefer the exact file we asked for.
      let found = existsSync(outFile) ? outFile : null;

      // 2. Otherwise read --json for a savedPath / image item.
      if (!found) {
        for (const line of r.stdout.split("\n")) {
          const t = line.trim();
          if (!t.startsWith("{")) continue;
          let j;
          try {
            j = JSON.parse(t);
          } catch {
            continue;
          }
          const item = j.item || j;
          const p = item.path || item.file || item.filename || item.output_path || item.savedPath || item.saved_path;
          if (p && existsSync(p) && /\.(png|jpe?g|webp|gif)$/i.test(p)) {
            found = p;
            break;
          }
          // Some builds inline base64; use it directly if present.
          if (item.type === "imageGeneration" && typeof item.result === "string" && item.result.length > 100) {
            return {
              buffer: Buffer.from(item.result, "base64"),
              meta: { provider: "codex-cli", model, source: "inline" },
            };
          }
        }
      }

      // 3. Fall back to the newest image written under the scratch dir.
      if (!found) found = findNewestImage(work);

      if (found && existsSync(found)) {
        return {
          buffer: readFileSync(found),
          meta: { provider: "codex-cli", model, source: "file" },
        };
      }

      // Failure: classify honestly, and redact anything we surface.
      const blob = `${r.stdout}\n${r.stderr}`;
      const code = classify(blob, r.code);
      const detail = blob.split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" ").slice(0, 400);
      const e = new Error(`Codex CLI produced no image (exit ${r.code})${detail ? `: ${redact(detail)}` : ""}`);
      e.code = code;
      throw e;
    } finally {
      try {
        rmSync(work, { recursive: true, force: true });
      } catch {}
    }
  },
};
