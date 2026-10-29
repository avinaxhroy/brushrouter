// Auto-discovery of local capabilities.
//
// NOTHING here is hardcoded to a particular machine or user. Every path is
// derived from the environment (HOME, PATH, platform conventions) and every
// candidate is verified before being reported.
//
// The goal is the user-facing promise: "auto-connect first; only ask if we
// genuinely cannot find anything."

import { existsSync, readdirSync, statSync, accessSync, constants } from "node:fs";
import { join, delimiter, isAbsolute, extname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

function isExecutable(p) {
  try {
    if (process.platform === "win32") {
      return statSync(p).isFile();
    }
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

const whichCache = new Map();

function whichSync(bin) {
  if (!bin) return null;
  const path = process.env.PATH || "";
  const cacheKey = `${process.platform}\0${path}\0${bin}`;
  if (whichCache.has(cacheKey)) return whichCache.get(cacheKey);
  let result = null;
  const isWin = process.platform === "win32";
  const exts = isWin
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];

  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const hasExt = isWin && extname(bin).length > 0;
    const candidates = hasExt
      ? [bin]
      : [bin, ...exts.map((e) => `${bin}${e.toLowerCase()}`), ...exts.map((e) => `${bin}${e.toUpperCase()}`)];
    for (const name of candidates) {
      const p = join(dir, name);
      if (isExecutable(p)) {
        result = p;
        break;
      }
    }
    if (result) break;
  }
  // Only successes are cached. A miss is a statement about the filesystem at one
  // instant, and the filesystem changes under us: `setup` checks isOnPath,
  // runs `npm link`, then checks again with the same PATH — caching the null
  // made the second check return the pre-install answer, so setup reported a
  // failed install of a link that had just succeeded. Hits are stable (a path
  // does not move), and miss cost is one stat per PATH entry.
  if (result) whichCache.set(cacheKey, result);
  return result;
}

function listApps(dirs) {
  const out = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.endsWith(".app")) out.push(join(dir, e));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Official Codex CLI
//
// The ChatGPT/Codex desktop app ships the real Codex CLI as a signed native
// binary, so the user's existing login is reused with no extra auth. We search
// generically: an explicit override, PATH, app bundles, per-user bin dirs, the
// npm global prefix, and the runtime cache the app maintains.
// ---------------------------------------------------------------------------

function appBundleCodexCandidates() {
  const roots = ["/Applications", "/Applications/Utilities", join(homedir(), "Applications")].filter(Boolean);
  // Allow extra search roots without hardcoding anyone's layout.
  if (process.env.BRUSHROUTER_APP_DIRS) {
    roots.push(...process.env.BRUSHROUTER_APP_DIRS.split(delimiter).filter(Boolean));
  }
  const out = [];
  for (const app of listApps(roots)) {
    for (const rel of [
      "Contents/Resources/codex-cli/bin/codex",
      "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
      "Contents/Resources/codex",
      "Contents/MacOS/codex",
      "Contents/Resources/bin/codex",
    ]) {
      const p = join(app, rel);
      if (isExecutable(p)) out.push(p);
    }
  }
  return out;
}

function staticNpmGlobalCodexCandidates() {
  const out = [];
  const prefixes = [
    process.env.npm_config_prefix,
    process.env.NPM_CONFIG_PREFIX,
    "/usr/local/lib/node_modules",
    "/opt/homebrew/lib/node_modules",
  ].filter(Boolean);
  for (const pre of prefixes) {
    for (const rel of ["@openai/codex/bin/codex.js", "codex/bin/codex.js"]) {
      const p = join(pre, rel);
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

function dynamicNpmRootCodexCandidates() {
  // Ask npm where its global root is as a last resort, only if npm is on PATH.
  if (!whichSync("npm")) return [];
  try {
    const r = spawnSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 8000 });
    if (r.status === 0 && r.stdout.trim()) {
      const root = r.stdout.trim();
      const out = [];
      for (const rel of ["@openai/codex/bin/codex.js", "@openai/codex/bin/codex", "codex/bin/codex.js"]) {
        const p = join(root, rel);
        if (existsSync(p)) out.push(p);
      }
      return out;
    }
  } catch {
    /* npm not present or failed */
  }
  return [];
}

function npmGlobalCodexCandidates() {
  const staticHits = staticNpmGlobalCodexCandidates();
  if (staticHits.length > 0) return staticHits;
  return dynamicNpmRootCodexCandidates();
}

function runtimeCacheCodexCandidates() {
  const out = [];
  const caches = [process.env.XDG_CACHE_HOME || join(homedir(), ".cache")];
  for (const c of caches) {
    const base = join(c, "codex-runtimes");
    if (!existsSync(base)) continue;
    let rts;
    try {
      rts = readdirSync(base);
    } catch {
      continue;
    }
    for (const rt of rts) {
      const dir = join(base, rt);
      for (const rel of ["codex", "bin/codex", "dependencies/codex"]) {
        const p = join(dir, rel);
        if (isExecutable(p)) out.push(p);
      }
      // one more level (e.g. codex-primary-runtime/<ver>/codex)
      try {
        for (const sub of readdirSync(dir)) {
          const p = join(dir, sub, "codex");
          if (isExecutable(p)) out.push(p);
        }
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

// Returns { path, version } or null. Never reads credentials.
//
// Discovery walks the filesystem and spawns `<cli> --version`, and both the
// provider probe and generate ask the same question in the same process — so
// the answer is memoized. The key must cover *every* input that can change the
// answer, or a login, a PATH edit or a `cd` keeps serving a stale miss. The old
// key held only the explicit override and two env vars, and the search also
// reads PATH, APPDATA/LOCALAPPDATA/PROGRAMFILES, XDG_CACHE_HOME, npm's prefix
// vars, homedir and cwd.
export function findCodexCli({ explicit = null } = {}) {
  const key = [
    explicit || "",
    process.env.BRUSHROUTER_CODEX_CLI || "",
    process.env.BRUSHROUTER_APP_DIRS || "",
    process.env.PATH || "",
    process.env.PATHEXT || "",
    process.env.APPDATA || "",
    process.env.LOCALAPPDATA || "",
    process.env.PROGRAMFILES || "",
    process.env.XDG_CACHE_HOME || "",
    process.env.npm_config_prefix || "",
    process.env.NPM_CONFIG_PREFIX || "",
    homedir(),
    process.cwd(),
    process.platform,
  ].join("\u0000");
  if (!codexCache.has(key)) codexCache.set(key, discoverCodexCli(explicit));
  return codexCache.get(key);
}

const codexCache = new Map();

function testCodexCandidate(p) {
  if (!p) return null;
  const abs = isAbsolute(p) ? p : join(process.cwd(), p);
  // A .js entrypoint is run via node; a binary is run directly.
  const isJs = abs.endsWith(".js");
  if (!isJs && !isExecutable(abs)) return null;
  if (isJs && !existsSync(abs)) return null;
  const isWindowsCmd = process.platform === "win32" && (abs.endsWith(".cmd") || abs.endsWith(".bat"));
  const cmd = isJs ? process.execPath : abs;
  const args = isJs ? [abs, "--version"] : ["--version"];
  let version = null;
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15000, shell: isWindowsCmd });
    const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
    // Only accept things that actually identify as codex.
    if (/codex/i.test(out) && r.status === 0) version = out.split("\n")[0].trim();
  } catch {
    /* not a usable codex */
  }
  if (version) return { path: abs, command: cmd, argsPrefix: isJs ? [abs] : [], version, shell: isWindowsCmd };
  return null;
}

function discoverCodexCli(explicit = null) {
  // Tier 1: Fast direct candidates (explicit, env, PATH, standard user bins)
  const isWin = process.platform === "win32";
  const appData = process.env.APPDATA || "";
  const localAppData = process.env.LOCALAPPDATA || "";
  const progFiles = process.env.PROGRAMFILES || "C:\\Program Files";

  const tier1 = [
    explicit,
    process.env.BRUSHROUTER_CODEX_CLI,
    whichSync("codex"),
    join(homedir(), ".codex", "bin", "codex"),
    isWin && join(homedir(), ".codex", "bin", "codex.exe"),
    join(homedir(), ".local", "bin", "codex"),
    isWin && join(homedir(), ".local", "bin", "codex.exe"),
    isWin && appData && join(appData, "npm", "codex.cmd"),
    isWin && localAppData && join(localAppData, "Programs", "ChatGPT", "resources", "codex-cli", "bin", "codex.exe"),
    isWin && progFiles && join(progFiles, "ChatGPT", "resources", "codex-cli", "bin", "codex.exe"),
  ];
  for (const p of new Set(tier1.filter(Boolean))) {
    const found = testCodexCandidate(p);
    if (found) return found;
  }

  // Tier 2: Direct desktop app bundle paths (avoid scanning all /Applications)
  const directApps = [
    "/Applications/ChatGPT.app",
    "/Applications/Codex.app",
    join(homedir(), "Applications", "ChatGPT.app"),
    join(homedir(), "Applications", "Codex.app"),
  ];
  for (const app of directApps) {
    if (!existsSync(app)) continue;
    for (const rel of [
      "Contents/Resources/codex-cli/bin/codex",
      "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
      "Contents/Resources/codex",
      "Contents/MacOS/codex",
      "Contents/Resources/bin/codex",
    ]) {
      const p = join(app, rel);
      const found = testCodexCandidate(p);
      if (found) return found;
    }
  }

  // Tier 3: Static npm global prefixes (fast existsSync, zero process spawn)
  for (const p of staticNpmGlobalCodexCandidates()) {
    const found = testCodexCandidate(p);
    if (found) return found;
  }

  // Tier 4: Runtime cache directories
  for (const p of runtimeCacheCodexCandidates()) {
    const found = testCodexCandidate(p);
    if (found) return found;
  }

  // Tier 5: Full app bundle search (scans /Applications)
  for (const p of appBundleCodexCandidates()) {
    const found = testCodexCandidate(p);
    if (found) return found;
  }

  // Tier 6: Last resort dynamic npm root -g
  for (const p of dynamicNpmRootCodexCandidates()) {
    const found = testCodexCandidate(p);
    if (found) return found;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Google CLIs
// ---------------------------------------------------------------------------

export function findGoogleClis() {
  const out = [];
  for (const bin of ["agy", "antigravity", "gemini"]) {
    const p = whichSync(bin);
    if (p) out.push({ bin, path: p });
  }
  return out;
}

export function isOnPath(bin) {
  return whichSync(bin);
}

// Resolve a program named by config: a bare name on PATH, or an explicit path.
// Use this instead of a shell (`sh -c "command -v ..."`) — a config value must
// never reach a shell, or a stray `;`/`$(...)` in it becomes code execution.
export function resolveExecutable(bin) {
  if (!bin || typeof bin !== "string") return null;
  if (bin.includes("/") || bin.includes("\\")) return isExecutable(bin) ? bin : null;
  return whichSync(bin);
}

export function resetDiscoverCache() {
  codexCache.clear();
  whichCache.clear();
}
