// gptweb2api sidecar provider: the ChatGPT WEB image bucket, no browser.
//
// The vendored MIT-licensed gateway (github.com/5yu4n/gptweb2api) serves a
// localhost OpenAI-compatible `POST /v1/images/generations` over the ChatGPT
// Web conversation transport (in-process sentinel requirements, proof-of-work
// and conduit acquisition — no Chrome, no Playwright, ~22 MB RSS). It consumes
// the same OAuth credential this machine already has from `brushrouter login`
// or `codex login` — which works on FREE ChatGPT plans too, unlike the Codex
// text routes.
//
// brushrouter owns lifecycle glue only: vendor-verified binary, ephemeral
// localhost port, random per-instance admin key, warm process reuse with an
// idle shutdown. The reverse-engineered protocol itself stays upstream, so
// OpenAI churn is fixed by re-vendoring, never by editing this file.
//
// smith: /v1/images/generations accepts only prompt+model — size/quality ride
// the prompt (same convention as the codex route), edits are multipart and
// intentionally out of v1.

import { spawn, exec } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { getConfigDir } from "../config.js";
import { jwtExpiryMs } from "../util/common.js";
import { registerSecret } from "../util/redact.js";
import { httpImageGenerate } from "./http.js";
import { readAuth, appendSizeHint } from "./codex.js";

const GITHUB_REPO = "5yu4n/gptweb2api";
// Pinned source ref the build-from-source vendor path uses. A release-asset
// download (with its SHA256SUMS) is preferred as soon as upstream cuts one.
// Override with BRUSHROUTER_GPTWEB_REF or providers.gptweb2api.ref.
const PINNED_REF = process.env.BRUSHROUTER_GPTWEB_REF || "985f4f45a49fbfdb2f8524686ab25759fd5195bb";
const GOOS = { win32: "windows", darwin: "darwin", linux: "linux" }[process.platform] || process.platform;
const GOARCH = { x64: "amd64", arm64: "arm64", arm: "arm" }[process.arch] || process.arch;
const EXE = process.platform === "win32" ? ".exe" : "";

// Cleanup patch applied to the upstream source build: hide throwaway image
// conversations from account history right after generation. It lives outside
// src/, so it must stay listed in package.json "files" — a missing copy means a
// partial checkout, and the hook silently would not run.
export const HIDE_CONVERSATIONS_PATCH = fileURLToPath(
  new URL("../../scripts/gptweb2api-hideconversations.patch", import.meta.url),
);

const promisifiedExec = promisify(exec);

// Sidecar install root lives in the user config dir, so `npm link` checkouts
// and repository clones share one binary and it survives checkouts/updates.
export function sidecarDir(override) {
  return override || process.env.BRUSHROUTER_GPTWEB_DIR || join(getConfigDir(), "gptweb2api");
}

export function resolveBinaryPath(cfg) {
  if (cfg?.bin) return cfg.bin;
  if (process.env.BRUSHROUTER_GPTWEB_BIN) return process.env.BRUSHROUTER_GPTWEB_BIN;
  return join(sidecarDir(), `gptweb2api${EXE}`);
}

// ---------------------------------------------------------------------------
// Vendoring (install). Prefers a GitHub release asset + SHA256SUMS; falls back
// to building the pinned source commit with the local Go toolchain.
// ---------------------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "brushrouter", Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub API ${url} -> ${res.status}`);
  return res.json();
}

async function downloadFile(url, dest, headers = {}) {
  const res = await fetch(url, { headers: { "User-Agent": "brushrouter", ...headers } });
  if (!res.ok) throw new Error(`download failed: ${url} -> ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const fs = await import("node:fs/promises");
  await fs.writeFile(dest, body);
  return body;
}

async function tryReleaseInstall(dir, onLog) {
  let release;
  try {
    const releases = await fetchJson(`https://api.github.com/repos/${GITHUB_REPO}/releases`);
    release = (releases || []).find((r) => !r.draft && !r.prerelease);
  } catch {
    return null; // GitHub unreachable is not an install failure yet
  }
  if (!release) return null;
  const wanted = `gptweb2api_${GOOS}_${GOARCH}${EXE}`;
  const asset = (release.assets || []).find((a) => a.name === wanted);
  const sums = (release.assets || []).find((a) => a.name === "SHA256SUMS");
  if (!asset || !sums) {
    onLog?.(`release ${release.tag_name} has no ${wanted}; falling back to source build`);
    return null;
  }
  const tmp = mkdtempSync(join(tmpdir(), "brushrouter-vendor-"));
  try {
    const payload = await downloadFile(asset.browser_download_url, join(tmp, wanted));
    const sumsBody = await downloadFile(sums.browser_download_url, join(tmp, "SHA256SUMS"));
    const line = sumsBody.toString().split("\n").find((l) => l.endsWith(`  ${wanted}`));
    const want = line?.split(/\s+/)[0];
    const got = createHash("sha256").update(payload).digest("hex");
    if (!want || want !== got) {
      throw new Error(`checksum mismatch for ${wanted} (expected ${want || "none"}, got ${got})`);
    }
    const binPath = join(dir, `gptweb2api${EXE}`);
    // copyFile, not rename: tmpdir() is often a different device from the
    // config dir (/tmp tmpfs on Linux), where EXDEV would kill the release
    // path. Copy falls through rmSync cleanup in the finally below.
    const fs = await import("node:fs/promises");
    await fs.copyFile(join(tmp, wanted), binPath);
    if (EXE !== ".exe") chmodSync(binPath, 0o755);
    onLog?.(`installed release ${release.tag_name} (sha256 verified)`);
    return binPath;
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function trySourceInstall(dir, ref, onLog) {
  const srcDir = join(dir, "src");
  if (!existsSync(join(srcDir, ".git"))) {
    onLog?.(`cloning ${GITHUB_REPO} ...`);
    mkdirSync(dir, { recursive: true });
    await promisifiedExec(`git clone --no-checkout https://github.com/${GITHUB_REPO} "${srcDir}"`);
  }
  const wanted = ref === "HEAD" ? "" : ref;
  if (wanted) {
    await promisifiedExec(`git -C "${srcDir}" checkout --detach --quiet ${wanted}`);
  }
  // Cleanup patch: hide throwaway image conversations from account history
  // right after generation (see scripts/gptweb2api-hideconversations.patch).
  if (existsSync(HIDE_CONVERSATIONS_PATCH)) {
    let applied = false;
    try {
      await promisifiedExec(`git -C "${srcDir}" apply "${HIDE_CONVERSATIONS_PATCH}"`);
      applied = true;
      onLog?.("applied hide-conversations patch");
    } catch {}
    if (!applied) {
      try {
        await promisifiedExec(`git -C "${srcDir}" apply --reverse --check "${HIDE_CONVERSATIONS_PATCH}"`);
        onLog?.("hide-conversations patch already applied (upstream took it)");
      } catch {
        onLog?.("warning: hide-conversations patch did not apply — image chats will stay in account history");
      }
    }
  } else {
    onLog?.(
      "warning: hide-conversations patch is missing from this install — image chats will stay in account history",
    );
  }
  onLog?.(`building with go (this downloads modules once) ...`);
  const binPath = join(dir, `gptweb2api${EXE}`);
  await promisifiedExec(
    `go build -trimpath -ldflags="-s -w" -o "${binPath}" ./cmd/gptweb2api`,
    { cwd: srcDir, timeout: 300000 },
  );
  if (EXE !== ".exe") chmodSync(binPath, 0o755);
  onLog?.(`built gptweb2api from ${wanted || "default branch"} -> ${binPath}`);
  return binPath;
}

// Install (or replace) the sidecar binary. Returns the binary path.
export async function installSidecar({ onLog, dir, ref } = {}) {
  const target = sidecarDir(dir);
  mkdirSync(target, { recursive: true });
  const log = (m) => onLog?.(m);
  try {
    const fromRelease = await tryReleaseInstall(target, log);
    if (fromRelease) return fromRelease;
  } catch (e) {
    log?.(`release install failed: ${e.message}`);
  }
  const srcRef = ref || process.env.BRUSHROUTER_GPTWEB_REF || PINNED_REF;
  return trySourceInstall(target, srcRef, log);
}

// ---------------------------------------------------------------------------
// Sidecar lifecycle: one warm localhost process, reused across calls.
// ---------------------------------------------------------------------------

let live = null; // { child, port, key, bin, grantedAccess, idleTimer, stderrTail }
let starting = null; // in-flight startSidecar promise (single-flight spawn)
let exitHookInstalled = false;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function stopSidecar() {
  if (!live) return;
  const { child, idleTimer } = live;
  live = null;
  clearTimeout(idleTimer);
  try { child.kill(); } catch {}
  try { child.kill("SIGKILL"); } catch {}
}

// Clean teardown for CLI hosts: the spawned gateway's open pipes pin the
// parent's event loop, so a one-shot command must stop it after dispatch.
export function shutdownSidecar() {
  stopSidecar();
}

async function healthWait(port, { timeoutMs = 10000, child } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(lastErr || "sidecar exited during startup");
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return;
      lastErr = `healthz ${res.status}`;
    } catch {
      lastErr = "healthz unreachable";
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`sidecar did not become healthy in ${Math.round(timeoutMs / 1000)}s (${lastErr})`);
}

function armIdle(idleMs) {
  clearTimeout(live?.idleTimer);
  const t = setTimeout(() => stopSidecar("idle timeout"), Math.max(30000, idleMs));
  t.unref?.();
  if (live) live.idleTimer = t;
}

// Resolve credential mode for the gateway:
//   * codex-shaped JSON with refresh_token -> pass the FILE path; the gateway
//     hot-reloads and renews it itself (nearest thing to zero-touch auth).
//   * any other shape brushrouter already reads (opencode/pi auth.json) -> pass
//     the access token directly; web access tokens expire, so a changed token
//     re-spawns the sidecar below instead of 401-ing forever.
function credentialMode(cfg) {
  const auth = readAuth(cfg);
  if (auth?.refresh && auth.format === "codex" && auth.filePath) {
    const accessToken = auth.access;
    registerSecret(accessToken);
    return { kind: "tokenFile", file: auth.filePath, accountId: auth.accountId, access: accessToken, plan: auth.plan };
  }
  if (auth?.access) {
    registerSecret(auth.access);
    if (auth.refresh) registerSecret(auth.refresh);
    const cookie = cfg?.cookie || process.env.BRUSHROUTER_GPTWEB_COOKIE || null;
    if (cookie) registerSecret(cookie);
    return { kind: "token", access: auth.access, accountId: auth.accountId, plan: auth.plan, cookie };
  }
  const cookie = cfg?.cookie || process.env.BRUSHROUTER_GPTWEB_COOKIE || null;
  if (cookie) {
    registerSecret(cookie);
    return { kind: "cookie", cookie, plan: null };
  }
  return null;
}

async function startSidecar(cfg, cred, onLog) {
  const bin = resolveBinaryPath(cfg);
  const port = await freePort();
  const apiKey = randomBytes(24).toString("hex");
  registerSecret(apiKey);
  const env = {
    ...process.env,
    GPTWEB_LISTEN: `127.0.0.1:${port}`,
    GPTWEB_API_KEY: apiKey,
    GPTWEB_TRANSPORT_MODE: "direct",
    GPTWEB_UPSTREAM_MAX_RETRIES: "2",
  };
  if (cred.kind === "tokenFile") {
    env.GPTWEB_OAUTH_TOKEN_FILE = cred.file;
  } else {
    env.GPTWEB_OAUTH_TOKEN = cred.access;
    if (cred.accountId) env.GPTWEB_ACCOUNT_ID = cred.accountId;
    if (cred.cookie) env.GPTWEB_COOKIE = cred.cookie;
  }
  // Chat cleanup: anchor every generation turn inside one ChatGPT project so
  // throwaway image chats collect in a folder instead of main history.
  const projectId = cfg?.projectId || process.env.BRUSHROUTER_GPTWEB_PROJECT_ID || null;
  if (projectId) env.GPTWEB_GENERATION_PROJECT_ID = projectId;
  const child = spawn(bin, [], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderrTail = "";
  child.stderr.on("data", (d) => {
    stderrTail = (stderrTail + d.toString()).split("\n").slice(-6).join("\n");
  });
  child.on("exit", (code) => {
    if (live?.child === child) {
      if (live.idleTimer) clearTimeout(live.idleTimer);
      live.dead = true;
      live.exitCode = code;
      live.stderrTail = stderrTail;
    }
  });

  onLog?.(`starting gptweb2api sidecar on 127.0.0.1:${port} (${cred.kind} auth, plan ${cred.plan || "unknown"})`);
  try {
    await healthWait(port, { child });
  } catch (e) {
    try { child.kill("SIGKILL"); } catch {}
    throw new Error(`${e.message}${stderrTail ? ` — ${stderrTail}` : ""}`);
  }
  live = {
    child,
    port,
    key: apiKey,
    bin,
    grantedAccess: cred.access || null,
    refreshable: cred.kind === "tokenFile",
    idleTimer: null,
    stderrTail: "",
  };
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => {
      if (live) {
        try { live.child.kill(); } catch {}
        live = null;
      }
    });
  }
  armIdle(Number(cfg?.idleMs) || 600000);
  return live;
}

async function ensureSidecar(cfg) {
  if (!existsSync(resolveBinaryPath(cfg))) {
    const e = new Error("sidecar binary not installed — run `brushrouter vendor gptweb2api` (or set providers.gptweb2api.bin)");
    e.code = "NO_SIDECAR";
    throw e;
  }
  // Warm AND running on a token file whose contents the gateway hot-reloads
  // itself: skip the per-call credential re-read entirely, so the warm path
  // does no filesystem work at all.
  if (live && !live.dead && live.refreshable && live.bin === resolveBinaryPath(cfg)) {
    armIdle(Number(cfg?.idleMs) || 600000);
    return live;
  }
  const cred = credentialMode(cfg);
  if (!cred) {
    const e = new Error("no ChatGPT web credential on this machine — run `brushrouter login` (or `codex login`)");
    e.code = "NO_AUTH";
    throw e;
  }
  // A live token-needing instance must be restarted when the underlying access
  // token rotated underneath us, otherwise every call dies on a stale bearer.
  if (live && !live.dead && live.bin === resolveBinaryPath(cfg)) {
    if (cred.kind !== "tokenFile" && live.grantedAccess && cred.access && live.grantedAccess !== cred.access) {
      stopSidecar();
    } else {
      armIdle(Number(cfg?.idleMs) || 600000);
      return live;
    }
  }
  if (live && !live.dead) stopSidecar();
  // Single-flight startup: the provider runs at concurrency 2, so two queued
  // items can hit a cold sidecar in the same tick. Without this both spawn a
  // gateway and the second overwrite of `live` leaks the first's process.
  if (!starting) {
    starting = startSidecar(cfg, cred).finally(() => { starting = null; });
  }
  return starting;
}

// ---------------------------------------------------------------------------

export const gptweb2apiProvider = {
  id: "gptweb2api",
  supportsImages: false,
  label: "ChatGPT web bucket (bundled gptweb2api gateway)",
  kind: "web-session",
  note: "Bills the ChatGPT web/Images bucket — works on FREE plans (~2-3 images/day). Vendored browserless gateway; off by default (installs a build of it).",

  async probe(cfg) {
    const bin = resolveBinaryPath(cfg);
    if (!existsSync(bin)) {
      return {
        available: false,
        auth: "vendor",
        detail: "gateway binary missing — run `brushrouter vendor gptweb2api`, or set providers.gptweb2api.bin (env: BRUSHROUTER_GPTWEB_BIN)",
      };
    }
    const cred = credentialMode(cfg);
    if (!cred) {
      return {
        available: false,
        auth: "needs-login",
        detail: "no ChatGPT web credential — run `brushrouter login` (or sign into the Codex CLI) on this machine",
      };
    }
    const exp = jwtExpiryMs(cred.access || "");
    const plan = cred.plan || "unknown";
    return {
      available: true,
      auth: "builtin",
      detail: `web transport via local gateway at ${bin} — credential ${cred.kind} (plan: ${plan})`,
      expires: Number.isFinite(exp) ? new Date(exp).toISOString() : null,
    };
  },

  async generate({ prompt, size, images, quality, onProgress, model: requestedModel }, cfg) {
    if (images?.length) {
      const e = new Error("gptweb2api is text-to-image only (reference images unsupported in the gateway's images route) — use --provider codex or gemini");
      e.code = "UNSUPPORTED";
      throw e;
    }
    if (requestedModel) onProgress?.(`note: model is routed by the account on the web transport; --model ${requestedModel} is a hint only`, 15);
    if (quality && quality !== "auto") onProgress?.(`note: the web transport takes no quality flag; "quality: ${quality}" is ignored`, 15);

    const s = await ensureSidecar(cfg);
    onProgress?.("generating via the gptweb2api gateway (web bucket)...", 25);
    const result = await httpImageGenerate(
      { prompt: appendSizeHint(prompt, size), size, quality, images: [], cwd: process.cwd(), onProgress },
      { ...(cfg || {}), timeoutMs: Number(cfg?.timeoutMs) || 180000 },
      {
        id: "gptweb2api",
        name: "gptweb2api",
        url: `http://127.0.0.1:${s.port}/v1/images/generations`,
        method: "POST",
        headers: {},
        body: '{"model": "auto", "prompt": "{prompt}"}',
        responsePath: "json:data.0.b64_json",
        defaultModel: "auto",
        model: cfg?.model || null,
        apiKey: s.key,
        keyHeader: "Authorization",
        keyPrefix: "Bearer ",
        requiresKey: true,
      },
    );
    return { ...result, meta: { ...result.meta, provider: "gptweb2api", billing: "web-session", route: "gptweb2api" } };
  },
};
