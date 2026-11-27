#!/usr/bin/env node
// brushrouter CLI.
//
// Commands:
//   generate | gen   Generate an image (auto-routes by default).
//   providers        List providers and whether they are connected.
//   doctor           Diagnose connectivity/config for every provider.
//   init             Write a starter config file.
//   install          Wire brushrouter into agent MCP configs.
//   serve            Run as an MCP server on stdio.
//   models           List known model ids per provider.
//
// Examples:
//   brushrouter gen "a red fox in snow" -o fox.png
//   brushrouter gen "logo" --provider fal --fallback
//   brushrouter providers
//   brushrouter doctor --json

import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, statSync, writeSync, lstatSync, chmodSync, copyFileSync, constants, mkdtempSync, renameSync, rmSync } from "node:fs";
import { resolve, join, dirname, extname, basename, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadConfig, getConfigDir, getUserConfigPath, getKeysPath, getHistoryPath, DEFAULT_CONFIG, DEFAULT_OPENAI_IMAGE_MODEL } from "../src/config.js";
import { generate, probeAll, listProviderIds, setRouteEnabled, planAttemptOrder, PROVIDERS, batchGenerate, DEFAULT_PROVIDER_CONCURRENCY } from "../src/router.js";
import {
  tryRecordHistory,
  listHistory,
  getHistoryEntry,
  buildReplayRequest,
  pruneHistory,
  clearHistory,
  computeStats,
  generateBatchId,
  formatDurationMs,
  formatUsd,
  formatPct,
  renderHistoryList,
  renderHistoryDetail,
  renderStats,
} from "../src/history.js";
import { saveImage, detectImageMime, assertImageFile, batchItemPath, pngSize } from "../src/util/common.js";
import { redact, redactValue, registerSecret } from "../src/util/redact.js";
import { discoverKey, saveKey, describeKey } from "../src/util/keys.js";
import { findCodexCli, findGoogleClis, isOnPath } from "../src/util/discover.js";
import { findRecipes, renderResult, listCategories, publicRecipe, composePrompt, resolveBatchItem, expandBrainstormBatch, MODES, RECIPES_DIR, STYLES_FILE, recipeCounts, validateCustomRecipes } from "../src/library.js";
import { getKnownAgentConfigs, detectInstalledAgents, getBrushrouterMcpEntry, installMcpToAgent } from "../src/util/mcp-install.js";
import { detectRuleFiles, injectRuleToFile } from "../src/util/rules.js";
// NOTE: ../src/mcp.js is imported dynamically in the `serve` case below. A static
// import dragged the whole recipe library (and its ~1 MB of styles.json) into
// every command, including `--help`.

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NPM_LINK_TIMEOUT_MS = 60000;
const REPAIRED_USER_CONFIG = { providers: { fal: { enabled: false } } };
// Fails loudly: a corrupted package.json is a broken install, not a soft error.
const PKG = (() => {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
  } catch (e) {
    console.error(`fatal: cannot read brushrouter's own package.json: ${e.message}`);
    process.exit(1);
  }
})();

// The install one-liner must point at the real repo. This used to be a literal
// `OWNER` placeholder that shipped in the message users copy — derive it from
// package.json's repository URL so there is exactly one place to get it wrong.
// Handles https://host/owner/repo(.git) and git@host:owner/repo(.git).
function repoSshSlug() {
  const url = PKG.repository?.url || "";
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}
function installScriptUrl() {
  const slug = repoSshSlug();
  return slug
    ? `https://raw.githubusercontent.com/${slug}/main/install.sh`
    : "the install.sh from the repository this package came from";
}

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c, s) => (useColor ? `${c}${s}${C.reset}` : s);
const ok = (s) => paint(C.green, s);
const bad = (s) => paint(C.red, s);
const warn = (s) => paint(C.yellow, s);
const dim = (s) => paint(C.dim, s);

// ---------------------------------------------------------------------------
// Exiting safely.
//
// `process.exit()` discards whatever is still queued in a pipe: Node's stdout
// to a pipe is ASYNCHRONOUS, so a `console.log()` followed immediately by
// `process.exit()` can lose most of the payload. Reproduce by piping a
// 700-item `batch --json` into another process: it arrives cut at 131072 bytes
// (`Unterminated string in JSON`), while the same command redirected to a file
// writes all 150477 bytes. Exit-code-only calls (usage errors, no output) keep
// using `process.exit`.
//
// The contract: `await exitAfterFlush(n)` waits until every pending write to
// stdout/stderr has been handed to the OS, then exits. Callers that print and
// are about to fail must `await` it.
// ---------------------------------------------------------------------------
function streamWritePending(stream) {
  // `writableLength` is undocumented-but-stable stream state: bytes accepted by
  // write() that the OS has not taken yet. A TTY (or a file) is synchronous, so
  // this is 0 there and the wait is a no-op.
  return typeof stream.writableLength === "number" && stream.writableLength > 0;
}

async function flushStream(stream) {
  if (!streamWritePending(stream)) return;
  await new Promise((resolveDrain) => {
    // Don't wait forever on a stream whose reader went away (EPIPE): a broken
    // pipe must not turn a clean failure into a hang.
    const done = () => {
      stream.removeListener("drain", done);
      stream.removeListener("error", done);
      resolveDrain();
    };
    stream.once("drain", done);
    stream.once("error", done);
    // Belt and braces: some platforms never emit `drain` for a pipe whose
    // buffer is already empty.
    const tick = setInterval(() => {
      if (!streamWritePending(stream)) {
        clearInterval(tick);
        done();
      }
    }, 5);
    if (typeof tick.unref === "function") tick.unref();
    setTimeout(() => {
      clearInterval(tick);
      done();
    }, 5000).unref?.();
  });
}

async function exitAfterFlush(code) {
  try {
    // A prompt may have left stdin flowing; nothing should keep the loop alive
    // while we are on our way out.
    process.stdin.pause?.();
  } catch {}
  await Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
  process.exit(code);
}

function parse(argv) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        provider: { type: "string", short: "p" },
        model: { type: "string", short: "m" },
        fallback: { type: "boolean", short: "f", default: false },
        out: { type: "string", short: "o" },
        size: { type: "string", short: "s" },
        quality: { type: "string", short: "q" },
        background: { type: "string" },
        images: { type: "string", multiple: true },
        mask: { type: "string" },
        json: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        yes: { type: "boolean", short: "y", default: false },
        "non-interactive": { type: "boolean", default: false },
        fix: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        verbose: { type: "boolean", short: "v", default: false },
        category: { type: "string", short: "c" },
        kind: { type: "string" },
        mode: { type: "string" },
        limit: { type: "string", short: "n" },
        offset: { type: "string" },
        full: { type: "boolean", default: false },
        "prompt-only": { type: "boolean", default: false },
        raw: { type: "boolean", default: false },
        id: { type: "string" },
        seed: { type: "string" },
        input: { type: "string" },
        shape: { type: "string" },
        recipe: { type: "string" },
        look: { type: "string" },
        twist: { type: "string" },
        brainstorm: { type: "boolean", default: false },
        diverse: { type: "boolean", default: false },
        "no-negatives": { type: "boolean", default: false },
        set: { type: "string", multiple: true },
        prompt: { type: "string", multiple: true },
        concurrency: { type: "string" },
        "skip-mcp": { type: "boolean", default: false },
        "skip-test": { type: "boolean", default: false },
        agent: { type: "string" },
        all: { type: "boolean", default: false },
        rules: { type: "boolean", default: false },
        project: { type: "boolean", default: false },
        global: { type: "boolean", default: false },
        create: { type: "boolean", default: false },
        only: { type: "string" },
        since: { type: "string" },
        until: { type: "string" },
        status: { type: "string" },
        failed: { type: "boolean", default: false },
        source: { type: "string" },
        query: { type: "string" },
        keep: { type: "string" },
        before: { type: "string" },
        "no-images": { type: "boolean", default: false },
        version: { type: "boolean", short: "V", default: false },
      },
    });
    return { values, positionals };
  } catch (e) {
    // A typo'd flag is the user's mistake, not a crash. This used to escape to
    // main().catch() as `fatal: TypeError [ERR_PARSE_ARGS_UNKNOWN_OPTION]` plus
    // a Node-internals stack trace, which reads like brushrouter broke. Every
    // subcommand parses through here, so the handling lives in one place.
    // The message is returned rather than printed+exited so the caller can
    // flush before exiting (a pipe write is asynchronous).
    return { values: null, positionals: null, error: String(e.message || e) };
  }
}

// Value-taking flags, by long and short spelling. Used only to know how many
// tokens a leading flag consumes while looking for the command.
const VALUE_FLAGS = new Set([
  "--provider", "-p", "--model", "-m", "--out", "-o", "--size", "-s",
  "--quality", "-q", "--background", "--images", "--mask", "--category", "-c", "--kind",
  "--mode", "--limit", "-n", "--offset", "--id", "--seed", "--input", "--shape",
  "--recipe", "--look", "--twist", "--set",
  "--prompt", "--concurrency", "--agent", "--only",
  "--since", "--until", "--status", "--source", "--query", "--keep", "--before",
]);

// Find the command token in an argv that may put flags first:
//   ["--json", "providers"]            -> providers at index 1
//   ["-o", "out.png", "gen", "a fox"]  -> gen at index 2 (out.png is a value)
//   ["--help"]                         -> none (-1)
// Returns { token, index } so the caller can drop exactly that token and hand
// parseArgs the rest, and `--json` still reaches the subcommand once.
function firstPositional(argv) {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    // `--` ends flag parsing: the next token is a positional by definition.
    if (tok === "--") return { token: argv[i + 1] ?? null, index: i + 1 };
    if (!tok.startsWith("-") || tok === "-") return { token: tok, index: i };
    // `--flag=value` is self-contained; a bare value-taking flag eats the next
    // token. Unknown flags are left alone — parseArgs reports them (exit 2).
    if (!tok.includes("=") && VALUE_FLAGS.has(tok)) i++;
  }
  return { token: null, index: -1 };
}

// Counted on demand, defensively: `--help` must never crash because the library
// is missing or malformed — and commands that never mention the counts must not
// pay to load the library either. Memoized because help is built once per call.
let libCountsCache = null;
function libCounts() {
  if (!libCountsCache) {
    try {
      libCountsCache = recipeCounts();
    } catch {
      libCountsCache = { job: 0, look: 0 };
    }
  }
  return libCountsCache;
}

function help() {
  const LIB_COUNTS = libCounts();
  return `${paint(C.bold, "brushrouter")} — provider-agnostic image generation router

${paint(C.bold, "USAGE")}
  brushrouter <command> [options]

${paint(C.bold, "COMMANDS")}
  setup                    Auto-connect; exits nonzero if no provider is usable
  login                    Sign in to ChatGPT for the codex route (browser OAuth,
                           no API key — nothing else needs to be installed)
  vendor gptweb2api        Install the browserless ChatGPT-web gateway binary
                           (release asset verified by SHA256SUMS, or built from
                           a pinned source commit with the local Go toolchain)
  generate, gen <prompt>   Generate an image (auto-routes across providers)
  batch <prompts...|file>  Batch generate multiple prompts in parallel across backends
  history [show|prune|clear] View or manage generation history & manifest log
  replay [id|last|~N]      Re-run a past generation with its prompt & seed (or overrides)
  stats                    Provider latency, success-rate, and spend/usage stats
  providers                List providers + connection status
  routes [enable|disable]  Show or toggle which routes auto-routing may use
  doctor [--fix]           Diagnose enabled providers; optional local config fixes
  models [provider...]     List available models (live, when the provider can)
  prompts [query]          Find a prompt recipe or a look to build an image from
  recipes validate [dir...]  Check custom recipe/looks JSON (defaults to configured dirs)
  init [--force]           Write a starter config to ${dim(getUserConfigPath())}
  install [--dry-run]      Add brushrouter to detected agent MCP configs
  rules [--dry-run]        Inject or update clean brushrouter guidance in AI coding
                           tools (targets detected harnesses; see options below)
  update                   Update brushrouter to the latest version and verify health
  serve                    Run as an MCP server on stdio (for agents)

${paint(C.bold, "OPTIONS")}
  -p, --provider <id>      Force a provider (see \`brushrouter providers\`)
  -m, --model <id>         Force a model id (see \`brushrouter models\`)
  -f, --fallback           With --provider, allow fallback to others on failure
  -o, --out <path>         Output path (default: brushrouter-<timestamp>.png)
  -s, --size <WxH>         Image size (e.g. 1024x1024, auto)
  -q, --quality <level>    Quality hint (low|medium|high|auto)
      --background <b>     opaque | transparent (transparent is an API field on
                           the codex route; phrase prompts as "sticker/isolated"
                           to reliably keep alpha — other routes get a prompt hint)
      --images <path>      Reference image (repeatable; image-to-image)
      --mask <path>        Inpaint the first reference image (requires --images)
      --json               Machine-readable output
      --non-interactive    setup: never prompt (also automatic with CI or no TTY)
  -y, --yes                setup: never prompt; allow MCP and rules changes
      --fix                doctor: repair local user config only; no login or installs
  -c, --category <id>      Recipes: restrict to one category
      --kind <k>           Recipes: job (a layout we wrote, ${LIB_COUNTS.job}) | look
                           (a vendored visual system, ${LIB_COUNTS.look}). Omit for both
      --mode <m>           Recipes: categories | related (default) | one | brainstorm
  -n, --limit <n>          Recipes/brainstorm: how many to return (default 4, max 10)
      --prompt <text>      Prompt to generate (repeatable for multiple prompts in gen/batch)
      --recipe <id>        gen/batch: generate directly from a recipe or look id
      --look <id>          gen/batch/prompts: layer a visual look onto a recipe
      --twist <text>       gen/batch/prompts: extra creative direction before STYLE LOCK
      --no-negatives       gen/batch/prompts: omit DO NOT REPRODUCE and AVOID blocks
      --brainstorm         batch: fan out a brainstorm query straight into contrasting items
      --diverse            prompts: diversify results across categories and kinds
      --concurrency <n>    Batch: max concurrent requests across providers
      --input <kind>       Recipes: text (default) | image — use image if you
                           already have a reference photo
      --shape <s>          Recipes: single | grid | sheet | document
      --id <id>            Recipes: fetch one exact recipe
      --set k=v            Recipes: fill a slot (repeatable; e.g. --set text=ACME)
      --full               Recipes: return the whole skeleton, not a preview
      --prompt-only, --raw Recipes: output only the filled prompt text (pipeable)
      --seed <n>           Integer seed for gen/replay, or pick seed for prompts
      --since <win|date>   history/stats: filter window (e.g. 24h, 7d, 30d, ISO date)
      --status <ok|failed> history: filter by outcome (or --failed)
      --keep <n>           history prune: keep the newest N entries
      --before <days>      history prune: remove entries older than N days (e.g. 30d)
      --no-images          replay: drop original reference images and mask
      --dry-run            gen: show the route it would take, send nothing.
                           routes/install/setup/update/doctor --fix: plan only
      --force              gen: overwrite -o instead of saving a new version.
                           init: overwrite an existing config
  -v, --verbose            Show routing decisions
      --global, --project  rules: restrict to global / project rule files
      --all, --only <ids>  rules: include undetected harnesses / cherry-pick ids
       --create            rules: create missing project rule files (--global or
                           --all must be alongside to create global ones)
  -h, --help               Show this help

${paint(C.bold, "EXAMPLES")}
  brushrouter setup                        # first run: connect automatically
  brushrouter gen "a red fox in snow" -o fox.png
  brushrouter gen "product shot" --provider fal --fallback
  brushrouter gen "logo" --provider openrouter --model x-ai/grok-imagine-image-2.0
  brushrouter gen "logo" -s 1024x1024 -q high --seed 42
  brushrouter gen --recipe product-hero --look retro-pop-sticker-cutout --set subject="kettle"
  brushrouter batch --brainstorm "product" --set subject="ceramic kettle" -n 4 -o ./out
  brushrouter history -n 10                # recent generations & outputs
  brushrouter replay last --provider fal   # replay last prompt+seed on fal
  brushrouter stats --since 7d             # provider latency, success rate & spend
  brushrouter routes disable gptweb2api   # keep a route out of auto-routing
  brushrouter models openrouter           # see models your key can reach
  brushrouter prompts                     # the map: ${LIB_COUNTS.job} recipes + ${LIB_COUNTS.look} looks
  brushrouter prompts "product hero shot" # best match + similar alternatives
  brushrouter prompts --kind look "mono noir editorial"
  brushrouter prompts -c infographic -n 2 --full
  brushrouter prompts --id character-sheet --full --set subject="a courier"
  brushrouter prompts "my own logo" --input image   # I already have a photo
  brushrouter doctor --json

${paint(C.bold, "SECURITY")}
  brushrouter never prints credentials, and never sends them to a model.
  Keys live in the environment or in ${dim(getKeysPath())} (mode 0600), never in
  logs, --json output, or MCP responses.
`;
}

async function cmdGenerate(args) {
  const { values, positionals } = args;
  if (values.prompt && values.prompt.length > 1) {
    if (values.recipe || values.look) {
      console.error(bad("error: --recipe/--look cannot be combined with multiple --prompt flags"));
      return exitAfterFlush(2);
    }
    return cmdBatch(args);
  }
  // Two bare prompts used to be glued together into one prompt ("a red fox a
  // blue jay"), quietly generating a single wrong image instead of the batch
  // the user obviously meant. Point at batch and stop.
  if (positionals.length > 1) {
    console.error(bad(`error: gen takes one prompt, got ${positionals.length}`));
    console.error(dim(`  to generate several, use: brushrouter batch ${positionals.map((p) => JSON.stringify(p)).join(" ")}`));
    console.error(dim("  (to pass a prompt containing spaces, quote it as one argument)"));
    return exitAfterFlush(2);
  }
  let prompt = values.prompt?.[0] || positionals.join(" ").trim();
  let autoSize = values.size;
  let recipeMeta = {};
  if (values.recipe || values.look) {
    const slotValues = {};
    for (const pair of values.set || []) {
      const eq = pair.indexOf("=");
      if (eq < 1) {
        console.error(bad(`--set expects key=value, got "${redact(pair)}"`));
        return exitAfterFlush(2);
      }
      slotValues[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
    }
    const extraTwist = [values.twist, prompt || null].filter((s) => s && String(s).trim()).join(" ");
    let composed;
    try {
      composed = composePrompt({
        recipeId: values.recipe || null,
        lookId: values.look || null,
        values: slotValues,
        input: (values.images || []).length ? "image" : "text",
        includeNegatives: !values["no-negatives"],
        twist: extraTwist || null,
      });
    } catch (e) {
      console.error(bad(`error: ${redact(e.message)}`));
      return exitAfterFlush(2);
    }
    if (composed.missing.length) {
      console.error(bad(`error: recipe "${composed.recipeId}" is missing required slot(s): ${composed.missing.map((m) => `{${m}}`).join(", ")}`));
      console.error(dim(`  pass them with: ${composed.missing.map((m) => `--set ${m}="..."`).join(" ")}`));
      return exitAfterFlush(2);
    }
    prompt = composed.text;
    if (!autoSize && composed.suggestedSize) autoSize = composed.suggestedSize;
    recipeMeta = {
      recipe: values.recipe || null,
      look: values.look || null,
      values: Object.keys(slotValues).length ? slotValues : null,
      twist: extraTwist || null,
    };
  }
  let seed;
  if (values.seed !== undefined) {
    const n = Number(values.seed);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      console.error(bad(`error: --seed expects an integer, got "${values.seed}"`));
      return exitAfterFlush(2);
    }
    seed = n;
  }
  if (!prompt) {
    console.error(bad("error: no prompt given"));
    console.error(dim('usage: brushrouter gen "your prompt" [-o out.png]  (or --recipe <id> --set subject="...")'));
    return exitAfterFlush(2);
  }
  const cwd = process.cwd();
  const cfg = loadConfig({ cwd });
  const out = values.out || `brushrouter-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  // `-o` is a FILE for a single generation. A directory was silently accepted
  // and then produced a file literally named after the directory, or an EEXIST
  // from writeFileSync. Reject it up front, before any request is spent.
  const outAbs = isAbsolute(out) ? out : resolve(cwd, out);
  if (existsSync(outAbs) && statSync(outAbs).isDirectory()) {
    console.error(bad(`error: -o "${out}" is a directory — gen writes one file`));
    console.error(dim(`  give a file path, e.g. -o ${join(out, "image.png")}`));
    console.error(dim(`  to write a directory of results, use: brushrouter batch ... -o ${out}`));
    return exitAfterFlush(2);
  }
  // Reference images: validate before spending a request, and never let a route
  // silently drop them (they used to be accepted and ignored on 4 of 7 routes).
  const imagePaths = values.images || [];
  const mask = values.mask;
  if (mask != null) {
    try {
      if (!mask.trim() || !imagePaths.length) throw new Error("requires a base image via --images");
      assertImageFile(mask, cwd);
    } catch (e) {
      console.error(bad(`error: --mask ${redact(e.message)}`));
      return exitAfterFlush(2);
    }
  }
  for (const p of imagePaths) {
    try {
      // Header-only: this loop only needs to reject a bad reference before a
      // request is spent. Encoding the file to base64 here just to discard it
      // cost a full read + encode per image on every generate.
      assertImageFile(p, cwd);
    } catch (e) {
      console.error(bad(`error: --images ${redact(e.message)}`));
      return exitAfterFlush(2);
    }
  }
  if (values.background && values.background !== "transparent" && values.background !== "opaque") {
    console.error(bad("error: --background must be opaque or transparent"));
    return exitAfterFlush(2);
  }
  if (imagePaths.length && values.provider && !(mask && values.fallback)) {
    // `supportsImages` is a static capability flag, not a health check. This used
    // to call probeAll() — spawning the Codex CLI and hitting the OpenRouter API
    // — to read a constant. An unknown id is left for generate() to reject.
    const p = PROVIDERS[values.provider];
    if (p && p.supportsImages === false) {
      const capable = Object.entries(PROVIDERS).filter(([, v]) => v.supportsImages !== false).map(([id]) => id);
      console.error(bad(`error: ${values.provider} cannot take reference images`));
      console.error(dim(`  --images is supported by: ${capable.join(", ")}`));
      return exitAfterFlush(2);
    }
  }
  // SECURITY: progress text embeds raw provider error bodies, which can echo a
  // credential back. It is a boundary like any other, so it is redacted.
  const onProgress = values.verbose
    ? (msg) => process.stderr.write(dim(`  · ${redact(msg)}\n`))
    : null;

  if (values["dry-run"]) {
    let order;
    try {
      order = await planAttemptOrder(cfg, { provider: values.provider, fallback: values.fallback, images: imagePaths, mask });
    } catch (e) {
      console.error(bad(`error: ${redact(e.message)}`));
      return exitAfterFlush(1);
    }
    const rows = await probeAll(cfg);
    const byId = new Map(rows.map((r) => [r.id, r]));
    if (values.json) {
      console.log(JSON.stringify(redactValue({ dryRun: true, prompt, out, provider: values.provider || null, model: values.model || null, images: imagePaths, mask, wouldTry: order.map((id) => ({ id, ready: Boolean(byId.get(id)?.available), detail: byId.get(id)?.detail || null })) }), null, 2));
      return;
    }
    console.log(paint(C.bold, "Dry run") + dim(" — no request sent, no quota used\n"));
    console.log(`  prompt:   ${prompt}`);
    console.log(`  out:      ${out}`);
    if (values.model) console.log(`  model:    ${values.model}`);
    if (imagePaths.length) console.log(`  images:   ${imagePaths.join(", ")}`);
    if (mask) console.log(`  mask:     ${redact(mask)}`);
    console.log(dim("\n  would try, in order:"));
    for (const id of order) {
      const r = byId.get(id);
      const state = !r ? dim("unknown") : !r.enabled ? warn("disabled") : r.available ? ok("ready") : bad(r.auth || "unavailable");
      const img = imagePaths.length && r && !r.supportsImages ? warn("  (drops --images)") : "";
      console.log(`    ${id.padEnd(12)} ${state}${img}`);
    }
    console.log("");
    return;
  }

  let result;
  try {
    result = await generate(
      {
        prompt,
        size: autoSize,
        quality: values.quality,
        background: values.background || undefined,
        seed,
        images: imagePaths,
        mask,
        out,
        cwd,
        provider: values.provider,
        model: values.model,
        fallback: values.fallback,
        onProgress,
      },
      cfg,
    );
  } catch (e) {
    const msg = redact(e.message);
    const histRec = tryRecordHistory(
      {
        source: "cli",
        ok: false,
        prompt,
        provider: values.provider || null,
        requestedProvider: values.provider || null,
        model: values.model || null,
        requestedModel: values.model || null,
        size: autoSize || null,
        quality: values.quality || null,
        background: values.background || null,
        seed: seed ?? null,
        images: imagePaths,
        mask,
        ...recipeMeta,
        out: outAbs,
        durationMs: e.durationMs ?? null,
        attempts: e.attempts || [],
        error: msg,
        errorCode: e.code || null,
      },
      { cfg },
    );
    if (values.json) {
      console.log(JSON.stringify(redactValue({ ok: false, id: histRec?.id || null, error: msg, code: e.code, durationMs: e.durationMs ?? null, attempts: e.attempts }), null, 2));
    } else {
      console.error(bad(`error: ${msg}`));
      if (e.attempts?.length) {
        console.error(dim("\nattempts:"));
        for (const a of e.attempts) console.error(dim(`  ${a.provider}: ${a.outcome}${a.reason ? ` — ${redact(a.reason)}` : ""}`));
      }
      if (e.code === "QUOTA") {
        console.error(warn("\nHint: the ChatGPT subscription quota is exhausted on that path."));
        console.error(warn("Try a different provider: brushrouter gen \"...\" --provider gemini --fallback"));
      }
      if (e.code === "NO_AUTH") console.error(warn("\nHint: run `brushrouter doctor` to see which providers need login."));
    }
    return exitAfterFlush(1);
  }

  let saved;
  try {
    saved = saveImage(out, result.buffer, cwd, { force: values.force, matchExtension: !values.out });
  } catch (e) {
    if (values.json) {
      console.log(JSON.stringify(redactValue({ ok: false, error: e.message, code: "SAVE_FAILED" }), null, 2));
    } else {
      console.error(bad(`error: failed to save image to "${out}": ${e.message}`));
    }
    return exitAfterFlush(1);
  }
  const mime = detectImageMime(result.buffer) || "image/png";
  const dims = pngSize(result.buffer);
  const histRec = tryRecordHistory(
    {
      source: "cli",
      ok: true,
      prompt,
      provider: result.provider,
      requestedProvider: values.provider || null,
      model: result.meta?.model || null,
      requestedModel: values.model || null,
      size: autoSize || null,
      actualSize: dims ? `${dims.width}x${dims.height}` : null,
      quality: values.quality || null,
      background: values.background || null,
      seed: result.meta?.seed ?? seed ?? null,
      images: imagePaths,
      mask,
      imagesUsed: result.meta?.imagesUsed,
      ...recipeMeta,
      out: saved.savedPath,
      bytes: result.buffer.length,
      mime,
      durationMs: result.durationMs ?? null,
      attempts: result.attempts || [],
      usage: result.meta?.usage || null,
      costUsd: result.meta?.costUsd,
    },
    { cfg },
  );
  if (values.json) {
    console.log(
      JSON.stringify(
        redactValue({
          ok: true,
          id: histRec?.id || null,
          provider: result.provider,
          model: result.meta?.model || null,
          path: saved.savedPath,
          bytes: result.buffer.length,
          durationMs: result.durationMs ?? null,
          seed: result.meta?.seed ?? seed ?? null,
          costUsd: histRec?.costUsd ?? null,
          costSource: histRec?.costSource ?? null,
          attempts: result.attempts,
        }),
        null,
        2,
      ),
    );
  } else {
    const dimText = dims ? `, ${dims.width}x${dims.height}` : "";
    const durText = result.durationMs != null ? ` in ${formatDurationMs(result.durationMs)}` : "";
    const idText = histRec?.id ? dim(` [${histRec.id}]`) : "";
    console.log(`${ok("✓")} generated with ${paint(C.cyan, result.provider)}${result.meta?.model ? dim(` (${result.meta.model})`) : ""}${dim(durText)}${idText}`);
    console.log(`  ${saved.savedPath} ${dim(`(${mime}${dimText}, ${(result.buffer.length / 1024).toFixed(0)} KB)`)}${saved.versioned ? warn("  [not overwritten — saved as new version]") : ""}`);
    if (result.attempts?.length > 1) {
      console.log(dim(`  routing: ${result.attempts.map((a) => `${a.provider}=${a.outcome}`).join(" → ")}`));
    }
    if (imagePaths.length && result.meta?.imagesUsed === false) {
      console.error(warn(`  warning: ${result.provider} ignored the ${imagePaths.length} reference image(s) you passed`));
    }
  }
}

function isUsableBatchObject(item, allowInherited = false) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  if (allowInherited) return true;
  return (
    (typeof item.prompt === "string" && item.prompt.trim() !== "") ||
    (typeof item.recipe === "string" && item.recipe.trim() !== "") ||
    (typeof item.look === "string" && item.look.trim() !== "")
  );
}

function parseBatchContent(content, { allowInherited = false } = {}) {
  const trimmed = content.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    // Whole-file JSON is validated strictly. The old code swallowed parse
    // errors with `catch {}` and fell through to line splitting, so a malformed
    // array turned into one giant "prompt" made of raw JSON text and lost every
    // real entry — a pay-per-image request spending money on garbage.
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      const err = new Error(`batch input is not valid JSON: ${e.message}`);
      err.code = "BAD_JSON";
      throw err;
    }
    if (!Array.isArray(parsed)) {
      const err = new Error("batch input JSON must be an array of prompts or items");
      err.code = "BAD_JSON";
      throw err;
    }
    return parsed.map((item, i) => {
      if (typeof item === "string") {
        if (!item.trim()) {
          const err = new Error(`batch item ${i} is an empty string`);
          err.code = "BAD_ITEM";
          throw err;
        }
        return { prompt: item };
      }
      if (isUsableBatchObject(item, allowInherited)) return item;
      const err = new Error(`batch item ${i} has no usable "prompt" (or "recipe"/"look") (got ${JSON.stringify(item)?.slice(0, 80)})`);
      err.code = "BAD_ITEM";
      throw err;
    });
  }

  const lines = trimmed.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("{") && line.endsWith("}")) {
      // A line that LOOKS like JSON must parse. Falling back to "use the raw
      // text as the prompt" sent malformed JSON to the model as a prompt and
      // reported the batch as successful.
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (e) {
        const err = new Error(`batch line ${i + 1} is not valid JSON: ${e.message}`);
        err.code = "BAD_JSON";
        throw err;
      }
      if (!isUsableBatchObject(obj, allowInherited)) {
        const err = new Error(`batch line ${i + 1} has no usable "prompt" (or "recipe"/"look")`);
        err.code = "BAD_ITEM";
        throw err;
      }
      items.push(obj);
      continue;
    }
    items.push({ prompt: line });
  }
  return items;
}

function loadBatchItems(filePath, cwd, { allowInherited = false } = {}) {
  let content = "";
  if (filePath === "-" || !filePath) {
    content = readFileSync(0, "utf8");
  } else {
    const abs = resolve(cwd, filePath);
    if (!existsSync(abs)) {
      const err = new Error(`batch input file not found: ${filePath}`);
      err.code = "ENOENT";
      throw err;
    }
    content = readFileSync(abs, "utf8");
  }
  return parseBatchContent(content, { allowInherited });
}

function readStdinIfAvailable(idleTimeoutMs = 50) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let gotData = false;
    let settled = false;
    const finish = (val, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
      if (err) rejectPromise(err);
      else resolvePromise(val);
    };
    const onData = (chunk) => {
      gotData = true;
      clearTimeout(timer);
      chunks.push(chunk);
    };
    const onEnd = () => finish(Buffer.concat(chunks).toString("utf8"));
    const onError = (err) => {
      if (!gotData && (err?.code === "EAGAIN" || err?.code === "EWOULDBLOCK")) {
        finish("");
      } else {
        finish(null, err);
      }
    };
    const timer = setTimeout(() => {
      if (!gotData) {
        process.stdin.pause();
        process.stdin.unref?.();
        finish("");
      }
    }, idleTimeoutMs);
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onError);
    process.stdin.resume();
  });
}

function parseSlotPairs(pairs) {
  const slotValues = {};
  for (const pair of pairs || []) {
    const eq = pair.indexOf("=");
    if (eq < 1) {
      throw new Error(`--set expects key=value, got "${redact(pair)}"`);
    }
    slotValues[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
  }
  return slotValues;
}

async function cmdBatch(args) {
  const { values, positionals } = args;
  const cwd = process.cwd();
  const cfg = loadConfig({ cwd });

  // Validate --concurrency here rather than at each use site: Number("abc") is
  // NaN, and both the dry-run summary (printed as `NaN`) and the real run
  // (silently no throttling) accepted it without a word.
  if (values.concurrency !== undefined) {
    const n = Number(values.concurrency);
    if (!Number.isInteger(n) || n < 1) {
      console.error(bad(`error: --concurrency expects a positive integer, got "${values.concurrency}"`));
      return exitAfterFlush(2);
    }
  }

  let slotValues;
  try {
    slotValues = parseSlotPairs(values.set);
  } catch (e) {
    console.error(bad(`error: ${e.message}`));
    return exitAfterFlush(2);
  }

  const isBrainstorm = Boolean(values.brainstorm || values.mode === "brainstorm");
  let resolvedItems = [];
  let brainstormMeta = null;

  if (isBrainstorm) {
    if (values.prompt && values.prompt.length > 0) {
      console.error(bad("error: --brainstorm cannot be combined with --prompt"));
      return exitAfterFlush(2);
    }
    const count = values.limit !== undefined ? Number(values.limit) : 4;
    if (!Number.isInteger(count) || count < 1 || count > 10) {
      console.error(bad(`error: --limit expects an integer between 1 and 10, got "${values.limit}"`));
      return exitAfterFlush(2);
    }
    const seed = values.seed !== undefined ? Number(values.seed) : 0;
    if (!Number.isFinite(seed)) {
      console.error(bad(`error: --seed expects a number, got "${values.seed}"`));
      return exitAfterFlush(2);
    }
    try {
      const expanded = expandBrainstormBatch({
        query: positionals.join(" ").trim(),
        count,
        kind: values.kind || null,
        category: values.category || null,
        shape: values.shape || null,
        input: values.input || ((values.images || []).length ? "image" : "text"),
        seed,
        recipe: values.recipe || null,
        look: values.look || null,
        values: slotValues,
        twist: values.twist || null,
        includeNegatives: !values["no-negatives"],
        size: values.size || null,
        quality: values.quality || null,
        background: values.background || null,
        model: values.model || null,
        images: values.images || [],
      });
      resolvedItems = expanded.items;
      brainstormMeta = { query: expanded.query, seed: expanded.seed, totalMatched: expanded.totalMatched };
    } catch (e) {
      console.error(bad(`error: ${redact(e.message)}`));
      return exitAfterFlush(2);
    }
  } else {
    let rawItems = [];
    if (values.prompt && values.prompt.length > 0) {
      rawItems = values.prompt.map((p) => ({ prompt: p }));
    } else if (positionals.length > 1) {
      // Multiple prompts provided as CLI arguments:
      // brushrouter batch "a red fox in snow" "a blue jay in a pine tree"
      rawItems = positionals.map((p) => ({ prompt: p }));
    } else if (positionals.length === 1 && positionals[0] !== "-" && !existsSync(resolve(cwd, positionals[0]))) {
      const arg = positionals[0];
      if (arg.endsWith(".txt") || arg.endsWith(".json") || arg.endsWith(".jsonl")) {
        console.error(bad(`error: batch input file not found: ${arg}`));
        return exitAfterFlush(1);
      }
      rawItems = [{ prompt: arg }];
    } else {
      const allowInherited = Boolean(values.recipe || values.look);
      const inputArg = positionals[0] || (process.stdin.isTTY ? null : "-");
      if (!inputArg) {
        if (allowInherited) {
          rawItems = [{}];
        } else {
          console.error(bad("error: no prompts or batch file provided"));
          console.error(dim('usage: brushrouter batch "prompt 1" "prompt 2" ... [-o ./out-dir]'));
          console.error(dim("       brushrouter batch prompts.txt [-o ./out-dir]"));
          console.error(dim('       brushrouter batch --brainstorm "product" --set subject="kettle" -n 4'));
          console.error(dim("       cat prompts.txt | brushrouter batch [-o ./out-dir]"));
          return exitAfterFlush(2);
        }
      } else if (!positionals[0] && inputArg === "-" && allowInherited) {
        // When --recipe/--look is passed without a positional file or explicit `-`,
        // consume piped stdin if data arrives, but fall back cleanly to a single
        // recipe/look item only when no stdin content was provided.
        try {
          const piped = await readStdinIfAvailable();
          rawItems = piped.trim()
            ? parseBatchContent(piped, { allowInherited: true })
            : [{}];
        } catch (e) {
          console.error(bad(`error: ${redact(e.message)}`));
          return exitAfterFlush(1);
        }
      } else {
        try {
          rawItems = loadBatchItems(inputArg, cwd, { allowInherited });
        } catch (e) {
          console.error(bad(`error: ${redact(e.message)}`));
          return exitAfterFlush(1);
        }
      }
    }

    if (!rawItems.length) {
      console.error(bad("error: batch input contains no prompts"));
      return exitAfterFlush(2);
    }

    const batchDefaults = {
      recipe: values.recipe || null,
      look: values.look || null,
      values: Object.keys(slotValues).length ? slotValues : undefined,
      twist: values.twist || null,
      includeNegatives: !values["no-negatives"],
      size: values.size || undefined,
      quality: values.quality || undefined,
      background: values.background || undefined,
      model: values.model || undefined,
      images: values.images || [],
    };
    try {
      resolvedItems = rawItems.map((item, idx) =>
        resolveBatchItem(item, batchDefaults, { index: idx, label: "batch item" }),
      );
    } catch (e) {
      console.error(bad(`error: ${redact(e.message)}`));
      return exitAfterFlush(2);
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve(cwd, values.out || `brushrouter-batch-${timestamp}`);

  let batchSeed;
  if (!isBrainstorm && values.seed !== undefined) {
    const n = Number(values.seed);
    if (!Number.isInteger(n)) {
      console.error(bad(`error: --seed expects an integer, got "${values.seed}"`));
      return exitAfterFlush(2);
    }
    batchSeed = n;
  }

  const items = resolvedItems.map((item, idx) => ({
    ...item,
    ...(item.mask != null || values.mask != null ? { mask: item.mask ?? values.mask } : {}),
    ...(item.seed !== undefined ? { seed: item.seed } : batchSeed !== undefined ? { seed: batchSeed } : {}),
    out: item.out ? resolve(outDir, item.out) : undefined,
  }));

  for (const [index, item] of items.entries()) {
    if (item.mask == null) continue;
    try {
      if (typeof item.mask !== "string" || !item.mask.trim() || !item.images.length) throw new Error("requires a mask file path and a base image");
      assertImageFile(item.mask, cwd);
      for (const path of item.images) assertImageFile(path, cwd);
    } catch (e) {
      console.error(bad(`error: batch item ${index + 1} mask: ${redact(e.message)}`));
      return exitAfterFlush(2);
    }
  }

  const onProgress = values.verbose
    ? (msg) => process.stderr.write(dim(`  · ${redact(msg)}\n`))
    : null;

  if (values["dry-run"]) {
    const previewPath = (item, index) => item.out || batchItemPath(outDir, index + 1, items.length, item.slugLabel || item.prompt);
    let plans;
    try {
      plans = await Promise.all(items.map(async (item) => {
        try {
          const order = await planAttemptOrder(cfg, {
            provider: values.provider, fallback: values.fallback, images: item.images, mask: item.mask,
          });
          return { order };
        } catch (error) {
          if (!item.mask || error.code !== "UNSUPPORTED") throw error;
          return { order: [], code: error.code, error: error.message };
        }
      }));
    } catch (e) {
      console.error(bad(`error: ${redact(e.message)}`));
      return exitAfterFlush(1);
    }
    const probes = await probeAll(cfg);
    const byId = new Map(probes.map((p) => [p.id, p]));
    const readyProbes = [...new Set(plans.flatMap((plan) => plan.order))]
      .map((id) => byId.get(id))
      .filter((p) => p && (values.provider === p.id ? p.enabled : p.enabled && p.available));
    const perProviderLimit = (id) => {
      const configured = cfg.providers?.[id]?.concurrency;
      return typeof configured === "number" && configured >= 1 ? configured : DEFAULT_PROVIDER_CONCURRENCY[id] || 1;
    };
    const concurrency = values.concurrency
      ? Number(values.concurrency)
      : readyProbes.reduce((sum, p) => sum + perProviderLimit(p.id), 0);
    const allFailed = plans.length > 0 && plans.every((plan) => plan.error);

    if (values.json) {
      console.log(
        JSON.stringify(
          redactValue({
            dryRun: true,
            totalItems: items.length,
            outDir,
            concurrency,
            ...(brainstormMeta ? { brainstorm: brainstormMeta } : {}),
            readyProviders: readyProbes.map((p) => ({ id: p.id, concurrency: perProviderLimit(p.id) })),
            items: items.map((it, idx) => ({
              index: idx + 1,
              prompt: it.prompt,
              out: previewPath(it, idx),
              code: plans[idx].code,
              error: plans[idx].error,
              ...(it.mask !== undefined ? { mask: it.mask } : {}),
              ...(it.size ? { size: it.size } : {}),
              ...(it.recipe ? { recipe: it.recipe } : {}),
              ...(it.look ? { look: it.look } : {}),
              ...(it.source ? { source: it.source } : {}),
            })),
          }),
          null,
          2,
        ),
      );
      if (allFailed) return exitAfterFlush(1);
      return;
    }

    console.log(paint(C.bold, "Batch Dry Run") + dim(` — ${items.length} item(s), no requests sent, no quota used\n`));
    console.log(`  out directory:  ${outDir}`);
    console.log(`  concurrency:    ${concurrency} worker(s) across ready backends`);
    console.log(dim("  ready backends:"));
    for (const p of readyProbes) {
      console.log(`    ${p.id.padEnd(12)} (concurrency limit: ${perProviderLimit(p.id)})`);
    }
    console.log(dim("\n  items to process:"));
    for (let i = 0; i < Math.min(items.length, 10); i++) {
      const it = items[i];
      const tagParts = [it.recipe, it.look && it.look !== it.recipe ? it.look : null].filter(Boolean);
      const tag = tagParts.length ? `[${tagParts.join(" + ")}] ` : "";
      const destination = plans[i].error ? warn(redact(plans[i].error)) : previewPath(it, i);
      console.log(`    ${String(i + 1).padStart(2, " ")}. ${tag}"${it.prompt.slice(0, 50)}" -> ${destination}`);
    }
    if (items.length > 10) console.log(dim(`    ... and ${items.length - 10} more`));
    console.log("");
    if (allFailed) return exitAfterFlush(1);
    return;
  }

  mkdirSync(outDir, { recursive: true });
  const manifestPath = join(outDir, "manifest.jsonl");
  const batchId = generateBatchId();

  if (!values.json) {
    console.log(paint(C.bold, `Starting batch generation: ${items.length} item(s)`) + dim(` -> ${outDir}\n`));
  }

  const startTime = Date.now();

  let result;
  try {
    result = await batchGenerate(
      {
        items,
        outDir,
        concurrency: values.concurrency ? Number(values.concurrency) : undefined,
        provider: values.provider,
        fallback: values.fallback,
        force: values.force,
        retainBuffers: false,
        cwd,
        onProgress,
        onItemStart: ({ item, index, provider }) => {
          if (values.verbose && !values.json) {
            process.stdout.write(dim(`[${index + 1}/${items.length}] dispatching to ${provider}: "${item.prompt.slice(0, 40)}..."\n`));
          }
        },
        onItemComplete: (res) => {
          const histRec = tryRecordHistory(
            {
              source: "batch",
              ok: true,
              prompt: res.item.prompt,
              provider: res.provider,
              requestedProvider: values.provider || null,
              model: res.meta?.model || null,
              requestedModel: res.item.model || null,
              size: res.item.size || null,
              actualSize: res.actualSize || null,
              quality: res.item.quality || null,
              background: res.item.background || null,
              seed: res.meta?.seed ?? res.item.seed ?? null,
              images: res.item.images || [],
              mask: res.item.mask,
              imagesUsed: res.meta?.imagesUsed,
              out: res.savedPath,
              bytes: res.bytes ?? null,
              mime: res.mime || null,
              durationMs: res.durationMs ?? null,
              attempts: res.attempts,
              usage: res.meta?.usage || null,
              costUsd: res.meta?.costUsd,
              batchId,
            },
            { cfg },
          );
          const record = {
            ok: true,
            id: histRec?.id || null,
            batchId,
            index: res.index + 1,
            prompt: res.item.prompt,
            ...(res.item.recipe ? { recipe: res.item.recipe } : {}),
            ...(res.item.look ? { look: res.item.look } : {}),
            ...(res.item.source ? { source: res.item.source } : {}),
            savedPath: res.savedPath,
            provider: res.provider,
            model: res.meta?.model || null,
            seed: res.meta?.seed ?? res.item.seed ?? null,
            durationMs: res.durationMs ?? null,
            costUsd: histRec?.costUsd ?? null,
            costSource: histRec?.costSource ?? null,
            usage: histRec?.usage || null,
            attempts: res.attempts,
          };
          appendFileSync(manifestPath, JSON.stringify(redactValue(record)) + "\n");
          if (!values.json) {
            const tagParts = [res.item.recipe, res.item.look && res.item.look !== res.item.recipe ? res.item.look : null].filter(Boolean);
            const tag = tagParts.length ? `[${tagParts.join(" + ")}] ` : "";
            console.log(ok(`✓ [${res.index + 1}/${items.length}] ${tag}${res.provider} -> ${res.savedPath}`));
          }
        },
        onItemFail: (fail) => {
          const histRec = tryRecordHistory(
            {
              source: "batch",
              ok: false,
              prompt: fail.item.prompt,
              provider: values.provider || null,
              requestedProvider: values.provider || null,
              model: fail.item.model || null,
              requestedModel: fail.item.model || null,
              size: fail.item.size || null,
              quality: fail.item.quality || null,
              background: fail.item.background || null,
              seed: fail.item.seed ?? null,
              images: fail.item.images || [],
              mask: fail.item.mask,
              out: fail.item.out || null,
              durationMs: fail.durationMs ?? null,
              attempts: fail.attempts,
              batchId,
              error: redact(fail.error),
              errorCode: fail.code || null,
            },
            { cfg },
          );
          const record = {
            ok: false,
            id: histRec?.id || null,
            batchId,
            index: fail.index + 1,
            prompt: fail.item.prompt,
            ...(fail.item.recipe ? { recipe: fail.item.recipe } : {}),
            ...(fail.item.look ? { look: fail.item.look } : {}),
            ...(fail.item.source ? { source: fail.item.source } : {}),
            error: redact(fail.error),
            code: fail.code,
            durationMs: fail.durationMs ?? null,
            attempts: fail.attempts,
          };
          appendFileSync(manifestPath, JSON.stringify(redactValue(record)) + "\n");
          if (!values.json) {
            console.error(bad(`✗ [${fail.index + 1}/${items.length}] failed: ${redact(fail.error)}`));
          }
        },
        onProviderCooldown: ({ provider, reason, cooldownUntil }) => {
          if (!values.json) {
            console.error(warn(`! backend ${provider} on cooldown (${redact(reason)}) until ${new Date(cooldownUntil).toISOString()}`));
          }
        },
      },
      cfg,
    );
  } catch (e) {
    if (values.json) {
      console.log(JSON.stringify(redactValue({ ok: false, error: redact(e.message), code: e.code }), null, 2));
    } else {
      console.error(bad(`error: ${redact(e.message)}`));
    }
    return exitAfterFlush(1);
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

  if (values.json) {
    console.log(
      JSON.stringify(
        redactValue({
          ok: result.failed === 0,
          total: result.total,
          completed: result.completed,
          failed: result.failed,
          durationSec: Number(durationSec),
          outDir,
          manifest: manifestPath,
          results: result.results.map((r) => ({
            ok: r.ok,
            index: r.index + 1,
            prompt: r.item.prompt,
            ...(r.item.recipe ? { recipe: r.item.recipe } : {}),
            ...(r.item.look ? { look: r.item.look } : {}),
            ...(r.item.source ? { source: r.item.source } : {}),
            savedPath: r.savedPath || null,
            provider: r.provider || null,
            error: r.error || null,
          })),
        }),
        null,
        2,
      ),
    );
  } else {
    console.log("");
    const statusFn = result.failed === 0 ? ok : result.completed > 0 ? warn : bad;
    console.log(statusFn(`Batch finished: ${result.completed}/${result.total} completed (${result.failed} failed) in ${durationSec}s`));
    console.log(dim(`Manifest: ${manifestPath}`));
  }

  if (result.completed === 0 && result.total > 0) {
    return exitAfterFlush(1);
  }
}

function parseNonNegInt(raw, flagName) {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    const e = new Error(`${flagName} expects a non-negative integer, got "${raw}"`);
    e.code = "BAD_ARGS";
    throw e;
  }
  return n;
}

function parseBeforeDays(raw) {
  const m = /^(\d+(?:\.\d+)?)\s*d?$/i.exec(String(raw).trim());
  if (!m) {
    const e = new Error(`--before expects a number of days (e.g. 30 or 30d), got "${raw}"`);
    e.code = "BAD_ARGS";
    throw e;
  }
  return Number(m[1]);
}

async function cmdHistory(args) {
  const { values, positionals } = args;
  const cwd = process.cwd();
  const cfg = loadConfig({ cwd });
  const sub = positionals[0];

  if (sub === "show" || sub === "get" || values.id) {
    const selector = values.id || positionals[1] || "last";
    try {
      const entry = getHistoryEntry(selector, { cwd });
      if (values.json) {
        console.log(JSON.stringify(redactValue(entry), null, 2));
      } else {
        console.log(renderHistoryDetail(entry));
      }
      return;
    } catch (e) {
      if (values.json) {
        console.log(JSON.stringify(redactValue({ ok: false, error: redact(e.message), code: e.code }), null, 2));
      } else {
        console.error(bad(`error: ${redact(e.message)}`));
      }
      return exitAfterFlush(1);
    }
  }

  if (sub === "prune") {
    try {
      const keep = values.keep !== undefined
        ? parseNonNegInt(values.keep, "--keep")
        : values.before === undefined
          ? (cfg.history?.maxEntries ?? 5000)
          : null;
      const beforeDays = values.before !== undefined ? parseBeforeDays(values.before) : null;
      const res = pruneHistory({ keep, beforeDays, dryRun: values["dry-run"] });
      if (values.json) {
        console.log(JSON.stringify(redactValue({ ok: true, ...res }), null, 2));
      } else if (res.dryRun) {
        console.log(paint(C.bold, "Dry run") + dim(` — would remove ${res.removed} of ${res.before} entry/entries (${res.after} kept)`));
      } else {
        console.log(`${ok("✓")} pruned ${res.removed} entry/entries (${res.after} kept in ${dim(res.path)})`);
      }
      return;
    } catch (e) {
      if (values.json) {
        console.log(JSON.stringify(redactValue({ ok: false, error: redact(e.message), code: e.code }), null, 2));
      } else {
        console.error(bad(`error: ${redact(e.message)}`));
      }
      return exitAfterFlush(2);
    }
  }

  if (sub === "clear") {
    if (!values.yes && !values.force) {
      console.error(bad("error: clearing generation history is destructive — pass --yes or --force to confirm"));
      return exitAfterFlush(2);
    }
    const res = clearHistory();
    if (values.json) {
      console.log(JSON.stringify(redactValue({ ok: true, ...res }), null, 2));
    } else {
      console.log(`${ok("✓")} cleared ${res.removed} history entry/entries from ${dim(res.path)}`);
    }
    return;
  }

  // Default: list history
  let limit;
  let offset;
  try {
    limit = values.limit !== undefined ? parseNonNegInt(values.limit, "--limit") : 20;
    offset = values.offset !== undefined ? parseNonNegInt(values.offset, "--offset") : 0;
  } catch (e) {
    console.error(bad(`error: ${e.message}`));
    return exitAfterFlush(2);
  }
  const status = values.failed ? "failed" : values.status || undefined;
  if (status && status !== "ok" && status !== "failed") {
    console.error(bad(`error: --status must be "ok" or "failed", got "${status}"`));
    return exitAfterFlush(2);
  }
  const query = values.query || (sub && sub !== "list" ? positionals.join(" ") : undefined);

  let res;
  try {
    res = listHistory({
      provider: values.provider,
      model: values.model,
      status,
      source: values.source,
      query,
      since: values.since,
      until: values.until,
      limit,
      offset,
    });
  } catch (e) {
    console.error(bad(`error: ${redact(e.message)}`));
    return exitAfterFlush(2);
  }

  if (values.json) {
    console.log(JSON.stringify(redactValue(res), null, 2));
    return;
  }
  console.log(renderHistoryList(res));
}

async function cmdReplay(args) {
  const { values, positionals } = args;
  const cwd = process.cwd();
  const cfg = loadConfig({ cwd });
  const selector = values.id || positionals[0] || "last";

  let entry;
  try {
    entry = getHistoryEntry(selector, { cwd });
  } catch (e) {
    if (values.json) {
      console.log(JSON.stringify(redactValue({ ok: false, error: redact(e.message), code: e.code }), null, 2));
    } else {
      console.error(bad(`error: ${redact(e.message)}`));
    }
    return exitAfterFlush(1);
  }

  let seedOverride;
  if (values.seed !== undefined) {
    const n = Number(values.seed);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      console.error(bad(`error: --seed expects an integer, got "${values.seed}"`));
      return exitAfterFlush(2);
    }
    seedOverride = n;
  }
  if (values.background && values.background !== "transparent" && values.background !== "opaque") {
    console.error(bad("error: --background must be opaque or transparent"));
    return exitAfterFlush(2);
  }

  let req;
  try {
    req = buildReplayRequest(entry, {
      provider: values.provider,
      model: values.model,
      size: values.size,
      quality: values.quality,
      background: values.background,
      seed: seedOverride,
      out: values.out,
      fallback: values.fallback,
      images: values.images,
      mask: values.mask,
      noImages: values["no-images"],
      prompt: values.prompt?.[0],
      twist: values.twist,
    });
  } catch (e) {
    console.error(bad(`error: ${redact(e.message)}`));
    return exitAfterFlush(2);
  }

  const out = req.out || `brushrouter-replay-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  const outAbs = isAbsolute(out) ? out : resolve(cwd, out);
  if (existsSync(outAbs) && statSync(outAbs).isDirectory()) {
    console.error(bad(`error: -o "${out}" is a directory — replay writes one file`));
    return exitAfterFlush(2);
  }

  for (const p of req.images || []) {
    try {
      assertImageFile(p, cwd);
    } catch (e) {
      console.error(bad(`error: reference image "${p}" from original generation is unavailable (${redact(e.message)})`));
      console.error(dim("  pass --no-images to replay without reference images, or --images <path> to supply a replacement"));
      return exitAfterFlush(2);
    }
  }
  if (req.mask != null) {
    try {
      if (!req.mask.trim() || !req.images.length) throw new Error("requires a mask file path and a base image");
      assertImageFile(req.mask, cwd);
    } catch (e) {
      console.error(bad(`error: mask is unavailable (${redact(e.message)})`));
      console.error(dim("  pass --mask <path> to supply a replacement, or --no-images to drop the references and mask"));
      return exitAfterFlush(2);
    }
  }

  if (values["dry-run"]) {
    let order;
    try {
      order = await planAttemptOrder(cfg, req);
    } catch (e) {
      console.error(bad(`error: ${redact(e.message)}`));
      return exitAfterFlush(1);
    }
    if (values.json) {
      console.log(JSON.stringify(redactValue({ dryRun: true, replayOf: entry.id, ...req, out, wouldTry: order }), null, 2));
      return;
    }
    console.log(paint(C.bold, `Replay Dry Run (${entry.id})`) + dim(" — no request sent, no quota used\n"));
    console.log(`  prompt:   ${req.prompt}`);
    console.log(`  out:      ${out}`);
    if (req.provider) console.log(`  provider: ${req.provider}${req.fallback ? " (+fallback)" : ""}`);
    if (req.model) console.log(`  model:    ${req.model}`);
    if (req.size) console.log(`  size:     ${req.size}`);
    if (req.seed != null) console.log(`  seed:     ${req.seed}`);
    if (req.images?.length) console.log(`  images:   ${req.images.join(", ")}`);
    if (req.mask) console.log(`  mask:     ${redact(req.mask)}`);
    console.log(`  would try: ${order.join(" → ")}\n`);
    return;
  }

  const onProgress = values.verbose
    ? (msg) => process.stderr.write(dim(`  · ${redact(msg)}\n`))
    : null;

  let result;
  try {
    result = await generate(
      {
        prompt: req.prompt,
        size: req.size,
        quality: req.quality,
        background: req.background,
        seed: req.seed,
        images: req.images,
        mask: req.mask,
        out,
        cwd,
        provider: req.provider,
        model: req.model,
        fallback: req.fallback,
        onProgress,
      },
      cfg,
    );
  } catch (e) {
    const msg = redact(e.message);
    const histRec = tryRecordHistory(
      {
        source: "replay",
        ok: false,
        prompt: req.prompt,
        provider: req.provider || null,
        requestedProvider: req.provider || null,
        model: req.model || null,
        requestedModel: req.model || null,
        size: req.size || null,
        quality: req.quality || null,
        background: req.background || null,
        seed: req.seed ?? null,
        images: req.images || [],
        mask: req.mask,
        recipe: req.recipe,
        look: req.look,
        values: req.values,
        twist: req.twist,
        out: outAbs,
        durationMs: e.durationMs ?? null,
        attempts: e.attempts || [],
        replayOf: entry.id,
        error: msg,
        errorCode: e.code || null,
      },
      { cfg },
    );
    if (values.json) {
      console.log(JSON.stringify(redactValue({ ok: false, id: histRec?.id || null, replayOf: entry.id, error: msg, code: e.code, attempts: e.attempts }), null, 2));
    } else {
      console.error(bad(`error: replay of ${entry.id} failed: ${msg}`));
    }
    return exitAfterFlush(1);
  }

  const saved = saveImage(out, result.buffer, cwd, { force: values.force });
  const mime = detectImageMime(result.buffer) || "image/png";
  const dims = pngSize(result.buffer);
  const histRec = tryRecordHistory(
    {
      source: "replay",
      ok: true,
      prompt: req.prompt,
      provider: result.provider,
      requestedProvider: req.provider || null,
      model: result.meta?.model || null,
      requestedModel: req.model || null,
      size: req.size || null,
      actualSize: dims ? `${dims.width}x${dims.height}` : null,
      quality: req.quality || null,
      background: req.background || null,
      seed: result.meta?.seed ?? req.seed ?? null,
      images: req.images || [],
      mask: req.mask,
      imagesUsed: result.meta?.imagesUsed,
      recipe: req.recipe,
      look: req.look,
      values: req.values,
      twist: req.twist,
      out: saved.savedPath,
      bytes: result.buffer.length,
      mime,
      durationMs: result.durationMs ?? null,
      attempts: result.attempts || [],
      usage: result.meta?.usage || null,
      costUsd: result.meta?.costUsd,
      replayOf: entry.id,
    },
    { cfg },
  );

  if (values.json) {
    console.log(
      JSON.stringify(
        redactValue({
          ok: true,
          id: histRec?.id || null,
          replayOf: entry.id,
          provider: result.provider,
          model: result.meta?.model || null,
          path: saved.savedPath,
          bytes: result.buffer.length,
          durationMs: result.durationMs ?? null,
          seed: result.meta?.seed ?? req.seed ?? null,
          costUsd: histRec?.costUsd ?? null,
          costSource: histRec?.costSource ?? null,
          attempts: result.attempts,
        }),
        null,
        2,
      ),
    );
  } else {
    const dimText = dims ? `, ${dims.width}x${dims.height}` : "";
    const durText = result.durationMs != null ? ` in ${formatDurationMs(result.durationMs)}` : "";
    console.log(`${ok("✓")} replayed ${dim(entry.id)} with ${paint(C.cyan, result.provider)}${result.meta?.model ? dim(` (${result.meta.model})`) : ""}${dim(durText)}${histRec?.id ? dim(` [${histRec.id}]`) : ""}`);
    console.log(`  ${saved.savedPath} ${dim(`(${mime}${dimText}, ${(result.buffer.length / 1024).toFixed(0)} KB)`)}`);
  }
}

async function cmdStats(args) {
  const { values } = args;
  let stats;
  try {
    stats = computeStats({
      since: values.since,
      until: values.until,
      provider: values.provider,
      model: values.model,
      source: values.source,
    });
  } catch (e) {
    console.error(bad(`error: ${redact(e.message)}`));
    return exitAfterFlush(2);
  }
  if (values.json) {
    console.log(JSON.stringify(redactValue(stats), null, 2));
    return;
  }
  console.log(renderStats(stats));
}

async function cmdProviders(args) {
  const cwd = process.cwd();
  const cfg = loadConfig({ cwd });
  const rows = await probeAll(cfg);
  if (args.values.json) {
    console.log(JSON.stringify(redactValue(rows), null, 2));
    return;
  }
  console.log(paint(C.bold, "Providers\n"));
  const width = Math.max(0, ...rows.map((r) => r.id.length));
  for (const r of rows) {
    const badge = !r.enabled ? warn("disabled") : r.available ? ok("connected") : bad("unavailable");
    console.log(`  ${r.id.padEnd(width)}  ${badge}  ${dim(r.label)}${r.supportsMask ? dim("  (inpainting)") : r.supportsImages ? "" : dim("  (no reference images)")}`);
    if (r.detail) console.log(`  ${" ".repeat(width)}  ${dim(redact(r.detail))}`);
  }
  console.log(dim(`\nAuto-routing order: ${cfg.priority.join(" → ")}`));
}

function writeJson(value) {
  console.log(JSON.stringify(redactValue(value), null, 2));
}

function pathInfo(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

function repairUserConfig(dry) {
  const fixes = [];
  const dir = getConfigDir();
  const file = getUserConfigPath();
  const safe = (info, type) => info[type]() && (!process.getuid || info.uid === process.getuid()) && (type !== "isFile" || info.nlink === 1);
  const apply = (action, path, change) => {
    const result = { action, path, status: dry ? "planned" : "applied" };
    fixes.push(result);
    if (!dry) {
      try {
        change(result);
      } catch (error) {
        Object.assign(result, { status: "error", error: error.message });
      }
    }
  };
  try {
    const info = pathInfo(dir);
    if (!info) apply("create-directory", dir, () => mkdirSync(dir, { recursive: true, mode: 0o700 }));
    else if (!safe(info, "isDirectory")) throw new Error(`not an owned directory: ${dir}`);
    else if (process.platform !== "win32" && (info.mode & 0o777) !== 0o700) {
      apply("secure-directory", dir, () => chmodSync(dir, 0o700));
    }
    const configInfo = pathInfo(file);
    if (!configInfo) {
      apply("create-config", file, () => {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file, "{}\n", { mode: 0o600, flag: "wx" });
      });
    } else {
      if (!safe(configInfo, "isFile")) throw new Error(`not an owned regular file: ${file}`);
      const source = readFileSync(file, "utf8");
      let valid;
      try {
        const parsed = JSON.parse(source);
        valid = parsed && typeof parsed === "object" && !Array.isArray(parsed);
      } catch {
        valid = false;
      }
      if (!valid) {
        apply("repair-config", file, (result) => {
          const backupDir = mkdtempSync(`${file}.backup-`);
          const backup = join(backupDir, "config.json");
          copyFileSync(file, backup, constants.COPYFILE_EXCL);
          result.backup = backup;
          const replacement = join(backupDir, "replacement.json");
          try {
            writeFileSync(replacement, JSON.stringify(REPAIRED_USER_CONFIG, null, 2) + "\n", { mode: 0o600, flag: "wx" });
            renameSync(replacement, file);
          } finally {
            rmSync(replacement, { force: true });
          }
        });
      } else if (process.platform !== "win32" && (configInfo.mode & 0o777) !== 0o600) {
        apply("secure-config", file, () => chmodSync(file, 0o600));
      }
    }
  } catch (error) {
    fixes.push({ action: "inspect-config", path: file, status: "error", error: error.message });
  }
  return fixes;
}

async function diagnose({ fix = false, dry = false } = {}) {
  const user = getUserConfigPath();
  const fixes = fix ? repairUserConfig(dry) : [];
  const result = { ok: false, ready: 0, config: { user, exists: existsSync(user) }, providers: [], agents: [], fixes };
  try {
    const repairedInPlan = fixes.some((item) => item.action === "repair-config" && item.status === "planned");
    const cfg = loadConfig({ userConfig: repairedInPlan ? REPAIRED_USER_CONFIG : null });
    result.providers = (await probeAll(cfg, { skipDisabled: true })).map((row) => ({
      ...row,
      verification: row.available ? row.verification || "configured" : null,
    }));
    result.agents = detectInstalledAgents().filter((a) => a.isInstalled);
    result.ready = result.providers.filter((row) => row.enabled && row.available).length;
    result.ok = result.ready > 0 && !fixes.some((item) => item.status === "error");
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

function renderDoctor(result) {
  const { providers: rows, agents: installedAgents, ready, fixes, config, error } = result;
  console.log(paint(C.bold, "brushrouter doctor\n"));
  for (const fix of fixes) {
    console.log(redact(`  ${fix.status}: ${fix.action} ${fix.path}${fix.backup ? ` (backup: ${fix.backup})` : ""}${fix.error ? ` — ${fix.error}` : ""}`));
  }
  if (error) return console.error(bad(redact(error)));
  for (const r of rows) {
    const mark = !r.enabled ? warn("○") : r.available ? ok("●") : bad("○");
    console.log(`${mark} ${paint(C.bold, r.id)} ${dim(`(${r.kind})`)}`);
    console.log(`    ${r.label}`);
    console.log(`    status: ${r.available ? ok(r.verification === "verified" ? "verified" : "configured (not verified)") : r.enabled ? bad(r.auth || "unavailable") : warn("disabled")}`);
    if (r.detail) console.log(`    ${dim(redact(r.detail))}`);
    if (r.expires) console.log(`    token expires: ${dim(r.expires)}`);
    if (r.note) console.log(`    ${dim("note: " + r.note)}`);
    console.log("");
  }
  console.log(ready > 0 ? ok(`\n${ready} provider(s) available.`) : bad("\nNo providers ready — run `brushrouter setup` to connect one."));

  if (installedAgents.length > 0) {
    console.log(paint(C.bold, "\nMCP Agent Integrations:"));
    for (const a of installedAgents) {
      const mark = a.hasBrushrouter ? ok("●") : warn("○");
      const status = a.hasBrushrouter ? ok("configured") : warn("detected, MCP not wired (run `brushrouter install`)");
      console.log(`  ${mark} ${paint(C.bold, a.name.padEnd(16))} ${status} ${dim(a.path)}`);
    }
  }

  if (!config.exists) {
    console.log(dim(`\nTip: run \`brushrouter setup\` to configure your environment and agents.`));
  }
}

async function cmdDoctor({ values }) {
  const result = await diagnose({ fix: values.fix, dry: values["dry-run"] });
  if (values.json) writeJson(result);
  else renderDoctor(result);
  if (!result.ok) return exitAfterFlush(1);
}

async function cmdModels(args) {
  const { json } = args.values;
  // Static knowledge — what each provider can do even with no network.
  const known = {
    "codex-cli": ["(auto — the bundled Codex CLI picks its own default)", "gpt-image-1", "gpt-image-1.5", "gpt-image-2"],
    codex: ["(auto from ~/.codex/config.toml)", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.5"],
    gptweb2api: ["(auto — the ChatGPT web conversation picks the image model)"],
    gemini: [
      "gemini-3.8-flash-high (default)",
      "gemini-3.1-flash-image",
      "gemini-nano-banana-2.1",
      "gemini-3.1-flash-image-preview (Nano Banana 2)",
      "gemini-3-pro-image (Nano Banana Pro)",
      "gemini-2.5-flash-image",
    ],
    openrouter: [],
    fal: ["fal-ai/flux/schnell", "fal-ai/flux/dev", "fal-ai/flux-pro/v1.1", "fal-ai/flux-2/edit", "fal-ai/flux-lora/inpainting"],
    openai: [DEFAULT_OPENAI_IMAGE_MODEL, "gpt-image-2.6-flare"],
    "gemini-api": ["gemini-2.5-flash-image"],
    replicate: ["black-forest-labs/flux-schnell"],
    comfyui: ["flux1-schnell.safetensors"],
    "custom-http": ["(from your config)"],
  };
  const ids = args.positionals.length ? [...new Set(args.positionals)] : Object.keys(known);
  const unknown = ids.filter((id) => !Object.hasOwn(known, id));
  if (unknown.length) {
    const message = `Unknown provider(s): ${unknown.join(", ")}. Known providers: ${Object.keys(known).join(", ")}`;
    if (json) writeJson({ error: { code: "unknown-provider", message } });
    else console.error(bad(redact(message)));
    return exitAfterFlush(2);
  }
  let cfg;
  try {
    cfg = loadConfig({ cwd: process.cwd() });
  } catch (error) {
    if (json) writeJson({ error: { code: "config", message: error.message } });
    else console.error(bad(redact(error.message)));
    return exitAfterFlush(1);
  }
  const out = {};
  for (const id of ids) {
    const provider = cfg.providers?.[id];
    const entry = out[id] = { configured: provider?.model || null, models: known[id] };
    if (id === "openrouter") {
      const { openrouterListModels } = await import("../src/providers/http.js");
      const { models, error, warnings } = await openrouterListModels(provider || {});
      entry.models = models.map((m) => m.id);
      if (models.length) entry.endpoints = models.map(({ id, endpoint }) => ({ id, endpoint }));
      if (error) entry.error = error;
      if (warnings?.length) entry.warnings = warnings;
    }
  }
  if (json) writeJson(out);
  else {
    console.log(paint(C.bold, "Models per provider") + "\n");
    for (const [id, entry] of Object.entries(out)) {
      const { configured, models, endpoints, error, warnings } = entry;
      const endpointByModel = new Map(endpoints?.map(({ id, endpoint }) => [id, endpoint]));
      const enabled = cfg.providers?.[id]?.enabled !== false;
      console.log(`${paint(C.bold, id)}${enabled ? "" : warn(" (disabled)")}${configured ? dim(`  (pinned: ${redact(configured)})`) : ""}`);
      for (const m of models) {
        const endpoint = endpointByModel.get(m);
        console.log(`  ${redact(m)}${endpoint ? dim(`  [${endpoint}]`) : ""}`);
      }
      if (error) console.error(bad(redact(`  ${error.message}`)));
      for (const warning of warnings || []) console.error(warn(redact(`  ${warning.message}`)));
      console.log("");
    }
    if (!args.positionals.length) console.log(dim("Pin one with: brushrouter gen \"...\" -p openrouter -m <model-id>"));
  }
  if (Object.values(out).every((entry) => entry.error)) return exitAfterFlush(1);
}

function cmdRecipes({ values, positionals }) {
  const [action, ...dirs] = positionals;
  if (action !== "validate") {
    const message = "usage: brushrouter recipes validate [dir...] [--json]";
    if (values.json) writeJson({ ok: false, error: message });
    else console.error(message);
    return exitAfterFlush(2);
  }
  let result;
  try {
    result = validateCustomRecipes(dirs);
  } catch (error) {
    result = { ok: false, files: [], error: error.message };
  }
  if (values.json) writeJson(result);
  else {
    if (result.error) console.error(bad(redact(result.error)));
    for (const { file, errors } of result.files) {
      for (const error of errors) console.error(bad(redact(`${file}: ${error}`)));
    }
    if (result.ok) console.log(`Validated ${result.files.length} custom recipe file(s).`);
  }
  if (!result.ok) return exitAfterFlush(1);
}

// Prompt recipes: search brushrouter's own recipe library. Same engine the MCP
// tool uses, so the CLI and an agent see identical results.
//
// `kind` is the axis worth understanding: a "job" is a layout we wrote that you
// fill in; a "look" is a vendored visual system you supply content for. Both
// come back through the same search, labelled, so neither has to be chosen
// before you know which you want.
function cmdPrompts(args) {
  const { values, positionals } = args;
  const query = positionals.join(" ").trim() || null;
  // No arguments at all means "show me the map"; an id means "give me that
  // one"; anything else is a search. Spelling it out beats a nested ternary.
  let mode = values.mode;
  if (!mode) {
    if (values.id) mode = "one";
    else if (query || values.category || values.kind || values.shape || values.input === "image") mode = "related";
    else mode = "categories";
  }
  if (!MODES.includes(mode)) {
    console.error(bad(`unknown --mode "${mode}" (use: ${MODES.join(" | ")})`));
    return exitAfterFlush(2);
  }

  // --set ratio=16:9 --set text=ACME fills slots in the returned skeleton.
  const slotValues = {};
  for (const pair of values.set || []) {
    const eq = pair.indexOf("=");
    if (eq < 1) {
      console.error(bad(`--set expects key=value, got "${pair}"`));
      return exitAfterFlush(2);
    }
    slotValues[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
  }

  // Reject a typo'd number instead of coercing it to NaN, which used to make a
  // matching query report "Nothing matched".
  for (const [flag, raw] of [["--limit", values.limit], ["--offset", values.offset], ["--seed", values.seed]]) {
    if (raw !== undefined && !Number.isFinite(Number(raw))) {
      console.error(bad(`error: ${flag} expects a number, got "${raw}"`));
      return exitAfterFlush(2);
    }
  }

  let result;
  try {
    result = findRecipes({
      query,
      category: values.category,
      kind: values.kind,
      input: values.input || "text",
      shape: values.shape,
      mode,
      limit: values.limit !== undefined ? Number(values.limit) : undefined,
      offset: values.offset !== undefined ? Number(values.offset) : 0,
      id: values.id,
      seed: values.seed ? Number(values.seed) : 0,
      diverse: values.diverse === true,
    });
  } catch (e) {
    console.error(bad(`error: ${e.message}`));
    return exitAfterFlush(1);
  }
  const renderOpts = {
    full: values.full,
    values: slotValues,
    input: result.input,
    includeNegatives: !values["no-negatives"],
    twist: values.twist || null,
    lookId: values.look || null,
  };
  if (values["prompt-only"] || values.raw) {
    if (!result.rows.length) {
      console.error(bad(result.matched ? `no recipes returned (limit ${result.limit})` : `nothing matched "${result.query || values.id || ""}"`));
      return exitAfterFlush(1);
    }
    const pub = publicRecipe(result.rows[0], { ...renderOpts, full: true });
    console.log(pub.prompt);
    return;
  }
  if (values.json) {
    console.log(
      JSON.stringify(
        result.mode === "categories"
          ? { mode: "categories", total: result.total, categories: listCategories({ kind: result.kind }) }
          : {
              mode: result.mode,
              query: result.query,
              category: result.category,
              kind: result.kind,
              input: result.input,
              matched: result.matched,
              total: result.total,
              limit: result.limit,
              offset: result.offset,
              hasMore: result.hasMore,
              available: result.available,
              ...(result.suggestions ? { suggestions: result.suggestions } : {}),
              recipes: result.rows.map((r) => publicRecipe(r, renderOpts)),
            },
        null,
        2,
      ),
    );
    return;
  }
  console.log(renderResult(result, renderOpts));
  if (result.mode !== "categories") {
    console.log(dim(`\nlibrary: ${RECIPES_DIR}${libCounts().look ? `  ·  looks: ${STYLES_FILE}` : ""}`));
    if (!values.full) console.log(dim("Add --full to get the whole skeleton, and --set key=value to fill slots."));
  }
}

// Show or toggle which routes auto-routing may use. Writes to the USER config
// (never a project file), so the choice follows the person, not the checkout.
function cmdRoutes(args) {
  const cfg = loadConfig({ cwd: process.cwd() });
  const [action, ...names] = args.positionals || [];
  if (action && !["enable", "disable", "on", "off"].includes(action)) {
    console.error(bad(`unknown action "${action}" (use: enable | disable)`));
    return exitAfterFlush(2);
  }
  if (action && !names.length) {
    console.error(bad("no route given"));
    console.error(dim(`known routes: ${listProviderIds().join(", ")}`));
    return exitAfterFlush(2);
  }
  if (action) {
    const enable = action === "enable" || action === "on";
    const dry = args.values["dry-run"];
    let path = null;
    for (const name of names) {
      if (!listProviderIds().includes(name)) {
        console.error(bad(`error: unknown route "${name}" (known: ${listProviderIds().join(", ")})`));
        return exitAfterFlush(2);
      }
      if (dry) {
        console.log(`${warn("→")} ${name} would be ${enable ? "enabled" : "disabled"}`);
        continue;
      }
      try {
        path = setRouteEnabled(name, enable);
        console.log(`${enable ? ok("✓") : warn("○")} ${name} ${enable ? "enabled" : "disabled"}`);
      } catch (e) {
        console.error(bad(`error: ${redact(e.message)}`));
        return exitAfterFlush(1);
      }
    }
    if (dry) {
      console.log(warn(`\nDry run: ${names.length} route(s) would change. Re-run without --dry-run to apply.`));
      return;
    }
    console.log(dim(`\nwritten to ${path}`));
    console.log(dim("A disabled route is skipped by auto-routing and refused by --provider."));
    return;
  }
  // No action: show current state, in auto-routing order. `priority` is the
  // authoritative order, so list by it first and append anything manual-only —
  // iterating registration order here contradicted the line printed below.
  const inPriority = new Set(cfg.priority);
  const ids = [...cfg.priority.filter((id) => listProviderIds().includes(id)), ...listProviderIds().filter((id) => !inPriority.has(id))];
  console.log(paint(C.bold, "Routes\n"));
  for (const id of ids) {
    const pcfg = cfg.providers?.[id] || {};
    const enabled = pcfg.enabled !== false;
    const auto = inPriority.has(id) && enabled;
    const mark = enabled ? ok("●") : warn("○");
    const state = !enabled ? warn("disabled") : auto ? ok("auto") : dim("manual only (not in priority)");
    console.log(`  ${mark} ${id.padEnd(12)} ${state}${pcfg.model ? dim(`  model: ${pcfg.model}`) : ""}`);
  }
  console.log(dim(`\nAuto-routing order: ${cfg.priority.join(" → ")}`));
  console.log(dim("Toggle with: brushrouter routes disable <id> | brushrouter routes enable <id>"));
}

// Known agent MCP config locations. These are the standard per-product paths
// (not personal), and the list is extensible via BRUSHROUTER_MCP_CONFIGS so a
// user with a non-standard agent can add it without editing code. We only ever
// ADD our entry, never remove or rewrite anything else, and we back up first.
async function cmdInstall(args) {
  const entry = getBrushrouterMcpEntry();
  const dry = args.values["dry-run"];
  const targetAgent = args.values.agent?.toLowerCase();
  const forceAll = args.values.all;

  console.log(paint(C.bold, "brushrouter install — AI agent MCP setup\n"));
  console.log(dim(`MCP entry: ${JSON.stringify(entry)}\n`));

  const allConfigs = getKnownAgentConfigs();
  let changed = 0;
  let alreadyCount = 0;

  for (const agent of allConfigs) {
    if (targetAgent && agent.name.toLowerCase() !== targetAgent) {
      continue;
    }
    if (agent.optInOnly && !targetAgent && !forceAll) {
      continue;
    }

    const res = installMcpToAgent(agent, entry, { dry, force: forceAll });
    switch (res.status) {
      case "already-installed":
        console.log(`${ok("=")} ${agent.name.padEnd(16)} ${dim("already configured")} ${dim(`(${agent.path})`)}`);
        alreadyCount++;
        break;
      case "updated":
        console.log(`${ok("+")} ${agent.name.padEnd(16)} ${ok("updated")} ${dim(`(backup: ${res.backup.split("/").pop()})`)}`);
        changed++;
        break;
      case "created":
        console.log(`${ok("+")} ${agent.name.padEnd(16)} ${ok("configured (created file)")} ${dim(`(${agent.path})`)}`);
        changed++;
        break;
      case "would-update":
      case "would-create":
        console.log(`${warn("→")} ${agent.name.padEnd(16)} ${warn(`would ${res.status === "would-create" ? "create" : "update"}`)} ${dim(`(${agent.path})`)}`);
        changed++;
        break;
      case "not-present":
        if (targetAgent || forceAll) {
          console.log(`${dim("-")} ${agent.name.padEnd(16)} ${dim("app directory not found, skipping")}`);
        }
        break;
      case "error":
        console.log(`${bad("!")} ${agent.name.padEnd(16)} ${bad(redact(res.error))}`);
        break;
    }
  }

  console.log("");
  if (changed === 0 && alreadyCount > 0) {
    console.log(ok(`All ${alreadyCount} detected agent(s) are already configured.`));
  } else if (dry) {
    console.log(warn(`Dry run: ${changed} config(s) would change. Re-run without --dry-run to apply.`));
  } else if (changed > 0) {
    console.log(ok(`Updated ${changed} config(s). Restart your agents or reload MCP servers to pick up the new tool.`));
  } else {
    console.log(dim("No supported agent installations detected."));
    console.log(dim("Tip: Pass --all to create configs anyway, or specify custom paths via BRUSHROUTER_MCP_CONFIGS."));
  }
}

async function cmdRules(args) {
  const dry = args.values["dry-run"];
  const targetProject = args.values.project;
  const targetGlobal = args.values.global;
  const targetAll = args.values.all; // user override: touch every known target, even undetected harnesses
  const onlyIds = args.values.only ? args.values.only.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const createFlag = args.values.create;

  console.log(paint(C.bold, "brushrouter rules — Coding Tool Guidance Injection\n"));
  console.log(dim("Injects compact, bounded rule blocks (<!-- BRUSHROUTER_START -->...<!-- BRUSHROUTER_END -->)"));
  console.log(dim("into AGENTS.md, CLAUDE.md, GEMINI.md, .cursorrules, and other rule files without context bulkup (~60 tokens)."));
  console.log(dim("Smart by default: only targets harnesses detected on this machine. Override with --all, --only <id>, --global, or --project.\n"));

  const detected = detectRuleFiles();

  // Validate --only before touching anything: a typo'd id used to filter the
  // list down to nothing and still exit 0, which reads as "already set up".
  if (onlyIds) {
    const known = detected.map((d) => d.id);
    const unknown = onlyIds.filter((id) => !known.includes(id));
    if (unknown.length) {
      console.error(bad(`error: unknown harness id${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`));
      console.error(dim(`valid ids: ${known.join(", ")}`));
      return exitAfterFlush(2);
    }
  }

  let changed = 0;
  let currentCount = 0;
  let skippedCount = 0;

  for (const item of detected) {
    if (targetProject && item.scope !== "project") continue;
    if (targetGlobal && item.scope !== "global") continue;
    if (onlyIds && !onlyIds.includes(item.id)) continue;

    // Smart inclusion: file already present, or its harness is installed here.
    // --all is the user's explicit decision to include everything anyway.
    if (!(targetAll || item.exists || item.installed)) {
      skippedCount++;
      if (args.values.verbose) {
        console.log(`${dim("-")} ${item.name.padEnd(35)} ${dim("harness not detected, skipping")} ${dim(`(${item.id})`)}`);
      }
      continue;
    }

    // Bare --create only creates project-level files; creating a global rules
    // file takes an explicit --global or --all beside it.
    const create = createFlag && (item.scope === "project" || targetGlobal || targetAll);
    const res = injectRuleToFile(item.path, { dry, create });
    switch (res.status) {
      case "not-present":
        console.log(`${dim("-")} ${item.name.padEnd(35)} ${dim("not present, skipping")} ${dim(`(${item.path})`)}`);
        break;
      case "already-current":
        console.log(`${ok("=")} ${item.name.padEnd(35)} ${dim("already up to date")} ${dim(`(${item.path})`)}`);
        currentCount++;
        break;
      case "updated":
        console.log(`${ok("+")} ${item.name.padEnd(35)} ${ok("injected/updated")} ${dim(`(backup: ${res.backup.split("/").pop()})`)}`);
        changed++;
        break;
      case "created":
        console.log(`${ok("+")} ${item.name.padEnd(35)} ${ok("created rule file")} ${dim(`(${item.path})`)}`);
        changed++;
        break;
      case "would-update":
      case "would-create":
        console.log(`${warn("→")} ${item.name.padEnd(35)} ${warn(`would ${res.status === "would-create" ? "create" : "update"}`)} ${dim(`(${item.path})`)}`);
        changed++;
        break;
      case "error":
        console.log(`${bad("!")} ${item.name.padEnd(35)} ${bad(redact(res.error))}`);
        break;
    }
  }

  console.log("");
  if (changed === 0 && currentCount > 0) {
    console.log(ok(`All ${currentCount} detected coding tool rule file(s) are up to date.`));
  } else if (dry) {
    console.log(warn(`Dry run: ${changed} rule file(s) would change. Re-run without --dry-run to apply.`));
  } else if (changed > 0) {
    console.log(ok(`Updated ${changed} coding tool rule file(s). Coding agents will now automatically reach for brushrouter.`));
  } else if (skippedCount > 0) {
    console.log(dim(`No eligible rule files in scope (${skippedCount} skipping undetected harnesses).`));
    console.log(dim("Run with -v to see what was skipped, or --all to target every known harness."));
  }
}

function commandFailure(command, result) {
  const detail = result.error?.message || (result.stderr || result.stdout || "").trim() || `exit ${result.status ?? result.signal ?? "unknown"}`;
  return `${command} failed: ${detail}`;
}

function diagnoseUpdatedInstall() {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "doctor", "--json"], {
    encoding: "utf8",
    timeout: 90000,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.status === 0 || child.status === 1) {
    try {
      const result = JSON.parse(child.stdout);
      if (Array.isArray(result?.providers) && Array.isArray(result.agents) && Array.isArray(result.fixes) && result.config) return result;
    } catch {}
  }
  return { ok: false, providers: [], agents: [], fixes: [], error: commandFailure("post-update doctor", child) };
}

async function cmdUpdate({ values }) {
  const dry = values["dry-run"];
  const isGit = existsSync(join(PACKAGE_ROOT, ".git"));
  const steps = isGit ? [
    { command: "git", args: ["pull", "--rebase", "--no-edit"], timeout: 30000 },
    { command: "npm", args: ["link"], timeout: NPM_LINK_TIMEOUT_MS },
  ] : [
    { command: "npm", args: ["install", "-g", "brushrouter@latest"], timeout: 60000 },
  ];
  const result = { ok: true, dryRun: dry, method: isGit ? "git" : "npm", previousVersion: PKG.version, version: PKG.version, steps: [], doctor: null };
  if (!values.json) console.log(paint(C.bold, `brushrouter update (current version: v${PKG.version})\n`));
  for (const { command, args, timeout } of steps) {
    const display = [command, ...args].join(" ");
    const step = { command, args, status: dry ? "planned" : "applied" };
    result.steps.push(step);
    if (dry) {
      if (!values.json) console.log(`Dry run: would run '${display}'${isGit ? ` in ${PACKAGE_ROOT}` : ""}`);
      continue;
    }
    const child = spawnSync(command, args, {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
      shell: command === "npm" && process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(command === "git" ? { GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" } : {}),
      },
    });
    if (child.status !== 0) {
      const error = commandFailure(isGit ? `${command} ${args[0]}` : "npm install", child);
      Object.assign(step, { status: "error", error });
      result.ok = false;
      if (!isGit) result.recovery = ["npm install -g brushrouter@latest", `curl -fsSL ${installScriptUrl()} | bash`];
      if (!values.json) {
        console.error(bad(redact(`  ${error}`)));
        for (const hint of result.recovery || []) console.log(dim(`  To update manually: ${hint}`));
      }
      break;
    }
    if (!values.json) console.log(ok(redact(`  ${(child.stdout || "").trim() || `${display} completed`}`)));
  }
  if (result.ok && !dry) {
    try {
      result.version = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;
    } catch {}
    result.doctor = diagnoseUpdatedInstall();
    if (!values.json) {
      console.log(`\n${ok("✓")} Current version: ${paint(C.bold, `v${result.version}`)}`);
      console.log("\nVerifying providers and routing after update:");
      renderDoctor(result.doctor);
    }
  }
  if (values.json) writeJson(result);
  if (!result.ok) return exitAfterFlush(1);
}

function cmdInit(args) {
  // Ask src/config.js for the paths NOW. BRUSHROUTER_USER_CONFIG /
  // BRUSHROUTER_KEYS_PATH / BRUSHROUTER_CONFIG_DIR are honoured by loadConfig()
  // and setRouteEnabled(), so init must write where they point — it used to
  // write the frozen ~/.config/brushrouter path that loadConfig never reads,
  // and the config silently did nothing.
  const userConfigPath = getUserConfigPath();
  if (existsSync(userConfigPath) && !args.values.force) {
    console.error(warn(`config already exists: ${userConfigPath}`));
    console.error(dim("use `brushrouter init --force` to overwrite"));
    return exitAfterFlush(1);
  }
  mkdirSync(dirname(userConfigPath), { recursive: true });
  writeFileSync(userConfigPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  console.log(`${ok("✓")} wrote ${userConfigPath}`);
  console.log(dim("\nNext:"));
  console.log(dim("  1. brushrouter doctor            # see what's connected"));
  console.log(dim("  2. brushrouter gen \"a cat\"       # generate"));
  console.log(dim("  3. add to your agent's mcp.json:"));
  console.log(dim('     "brushrouter": { "command": "brushrouter", "args": ["serve"] }'));
}

// ---------------------------------------------------------------------------
// setup — auto-connect first, ask only for what is genuinely missing.
//
// Design rules:
//   * Detect everything automatically and report it. The common case is that the
//     user already has the ChatGPT/Codex app (native route, no key at all) or a
//     Google CLI login, so no question is asked.
//   * Only prompt for a credential when nothing usable was found, the input is
//     hidden, and it is stored 0600 — never echoed, never logged.
//   * In a non-interactive context (no TTY, or --yes) we NEVER block: we print
//     exactly what to set when no provider is usable.
// ---------------------------------------------------------------------------

// A free ChatGPT plan can only generate through the gptweb2api web-bucket
// sidecar (every Codex path is paid-gated), so wire that route into auto-routing
// right after such a login. Paid plans need nothing — this is a no-op for them.
// Returns a summary of what changed, for the caller to print.
function applyFreePlanRouting(plan) {
  if (plan !== "free") return null;
  setRouteEnabled("gptweb2api", true);
  return "ChatGPT plan 'free' detected → gptweb2api route enabled for auto-routing (the web image bucket works on free plans, ~2-3 images/day)";
}

// ---------------------------------------------------------------------------
// Interactive prompt.
//
// Uses readline so line editing works, BUT every exit path must close the
// interface and pause stdin: an open readline interface holds a `data` listener
// on stdin, which holds a ref on the event loop, so `setup` printed
// "brushrouter is ready!" and then never exited (a scripted-pty run found the
// process still alive 16 s later). `rl.pause()` alone is not enough — the
// interface itself must be closed.
//
// Ctrl-C at a hidden prompt is its own hazard: the process dies while the tty
// is still in raw mode, which leaves the terminal without echo or line
// discipline. So SIGINT is trapped here, the tty is restored, and only then do
// we exit.
// ---------------------------------------------------------------------------
function prompt(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const stdout = process.stdout;
    const wasRaw = stdin.isRaw;

    // A hidden answer is read as raw bytes, so no readline interface is created
    // at all: readline echoes what it reads, and a secret must never hit the
    // screen. For a visible prompt readline gives line editing for free.
    const rl = hidden ? null : createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
    if (rl) {
      rl.setPrompt("");
      rl.prompt();
    }

    let settled = false;
    let val = "";
    if (hidden && stdin.isTTY) stdin.setRawMode(true);

    // Single exit path: restore the tty, drop every listener, close readline,
    // pause stdin, then resolve. Called from success, abort, and SIGINT.
    const finish = (value) => {
      if (settled) return;
      settled = true;
      process.removeListener("SIGINT", onSigint);
      try {
        if (hidden && stdin.isTTY) stdin.setRawMode(wasRaw);
      } catch {}
      try {
        if (rl) {
          rl.removeAllListeners();
          rl.close();
        }
      } catch {}
      // pause() is what stops stdin holding the event loop open once the
      // interface is gone (closing readline alone leaves the socket ref'd).
      try {
        stdin.pause();
        stdin.removeListener("data", onData);
      } catch {}
      resolve(value);
    };

    // Ctrl-C. In raw mode a tty delivers 0x03 as data (handled in onData); on a
    // cooked terminal Node raises SIGINT. Both must restore the tty first, so
    // the shell we return to is not left without echo.
    const abort = () => {
      if (settled) return;
      process.stdout.write("\n");
      process.removeListener("SIGINT", onSigint);
      try {
        if (hidden && stdin.isTTY) stdin.setRawMode(wasRaw);
      } catch {}
      try {
        if (rl) {
          rl.removeAllListeners();
          rl.close();
        }
      } catch {}
      try {
        stdin.pause();
        stdin.removeListener("data", onData);
      } catch {}
      settled = true;
      // Do NOT resolve: resolving would let the caller run its next prompt
      // (which re-enters raw mode) before this process finishes dying.
      return exitAfterFlush(130);
    };

    const onSigint = () => abort();
    process.once("SIGINT", onSigint);

    const onData = (chunk) => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\u0003") return abort();
        if (ch === "\n" || ch === "\r" || ch === "\u0004") {
          process.stdout.write("\n");
          return finish(val.trim());
        }
        if (ch === "\u007f" || ch === "\b") {
          val = val.slice(0, -1);
          continue;
        }
        val += ch;
      }
    };

    if (hidden) {
      stdin.resume();
      stdin.on("data", onData);
    } else {
      rl.on("line", (line) => finish(line.trim()));
      // Ctrl-D / closed stdin: resolve with whatever was typed rather than
      // hanging forever waiting for a line that will never arrive.
      rl.on("close", () => finish(val.trim()));
    }
  });
}

async function cmdSetup(args) {
  const cwd = process.cwd();
  const { json, yes } = args.values;
  const dry = args.values["dry-run"];
  const interactive = process.stdin.isTTY && process.stdout.isTTY && /^(?:false|0)?$/i.test(process.env.CI || "")
    && !args.values["non-interactive"] && !yes && !dry && !json;
  const messages = [];
  const log = json ? (message) => messages.push(String(message).replace(/\x1b\[[0-9;]*m/g, "")) : console.log;
  const finish = (result) => {
    if (json) writeJson({ ...result, dryRun: dry, interactive: Boolean(interactive), messages });
    return exitAfterFlush(result.ok ? 0 : 1);
  };
  let cfg;
  try {
    cfg = loadConfig({ cwd });
  } catch (error) {
    if (!json) console.error(bad(redact(error.message)));
    return finish({ ok: false, error: error.message });
  }
  const skipMcp = args.values["skip-mcp"];
  const skipTest = args.values["skip-test"];

  log(paint(C.bold, "brushrouter setup — auto-connect backends & AI agent MCP wiring\n"));

  // Ensure the user config directory exists with safe permissions. Resolved at
  // use time so BRUSHROUTER_CONFIG_DIR is honoured, and skipped on --dry-run
  // (creating ~/.config/brushrouter is itself a write).
  if (!dry) {
    try {
      mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
    } catch {}
  }

  // ---- Phase 1: Probe image generation capability ----
  log(paint(C.bold, "1. Checking image generation backends..."));

  let probes = await probeAll(cfg);
  let ready = probes.filter((p) => p.available && p.enabled);

  for (const p of probes) {
    if (p.available && p.enabled) {
      log(`  ${ok("✓")} ${paint(C.bold, p.id.padEnd(14))} — ${p.label} ${dim(`(${p.kind})`)}`);
      if (p.detail) log(`      ${dim(redact(p.detail))}`);
    } else if (p.available && !p.enabled) {
      log(`  ${warn("○")} ${paint(C.bold, p.id.padEnd(14))} — ${p.label} ${warn("(disabled in routes)")}`);
    }
  }

  if (ready.length > 0) {
    log(ok(`\n  ${ready.length} backend(s) ready to generate images immediately!`));
  } else {
    log(warn("\n  No image generation backends detected yet."));
  }

  // ---- Phase 2: Onboard missing credentials if needed ----
  if (ready.length === 0) {
    if (!interactive) {
      log(dim(dry ? "\nDry run: would offer sign-in or API key setup in an interactive terminal." : "\nNon-interactive session. To enable image generation:"));
      log(dim("  1. Sign in with ChatGPT:       brushrouter login"));
      log(dim("  2. Or set OpenRouter API key:  export BRUSHROUTER_OPENROUTER_KEY=sk-or-..."));
      log(dim("  3. Or set fal.ai API key:      export BRUSHROUTER_FAL_KEY=..."));
      log(dim("  4. Or run 'brushrouter setup' interactively in a terminal."));
    } else {
      log(dim("\nLet's connect your first backend (pick any):"));
      log(`  ${paint(C.bold, "1)")} Sign in with ChatGPT ${ok("[Recommended]")} — browser login (no API key needed)`);
      log(`  ${paint(C.bold, "2)")} Add an OpenRouter API key — access to FLUX, Gemini, Recraft, SD`);
      log(`  ${paint(C.bold, "3)")} Add a fal.ai API key — fast hosted FLUX and SD models`);
      log(`  ${paint(C.bold, "4)")} Skip for now (configure later)`);

      const choice = await prompt("\nSelect [1-4] (default 1): ");
      const picked = choice.trim() === "" ? "1" : choice.trim();

      if (picked === "1") {
        log(dim("\nOpening browser for ChatGPT OAuth sign-in..."));
        // Resolved here, not at module scope: BRUSHROUTER_* may point elsewhere.
        const { runLogin } = await import("../src/oauth.js");
        try {
          const { path, plan, accountId } = await runLogin({
            configDir: getConfigDir(),
            log: (l) => log(dim(l)),
          });
          log(ok(`\n✓ Logged into ChatGPT (plan: ${plan || "active"}, account: ${accountId})`));
          log(dim(`  Credentials saved to ${path} (mode 0600)`));
          const freeNote = applyFreePlanRouting(plan);
          if (freeNote) log(ok(`✓ ${freeNote}`));
          cfg = loadConfig({ cwd });
          probes = await probeAll(cfg);
          ready = probes.filter((p) => p.available && p.enabled);
        } catch (e) {
          log(bad(`\nLogin failed: ${redact(e.message)}`));
          log(dim("You can retry anytime with: brushrouter login"));
        }
      } else if (picked === "2" || picked === "3") {
        const provider = picked === "2" ? "openrouter" : "fal";
        const label = picked === "2" ? "OpenRouter" : "fal.ai";
        const key = await prompt(`Paste your ${label} key (input hidden): `, { hidden: true });
        if (key) {
          try {
            const path = saveKey(provider, key);
            setRouteEnabled(provider, true);
            log(ok(`✓ Saved ${label} key to ${path} (mode 0600)`));
            log(ok(`✓ ${provider} enabled for auto-routing`));
            cfg = loadConfig({ cwd });
            probes = await probeAll(cfg);
            ready = probes.filter((p) => p.available && p.enabled);
          } catch (e) {
            log(bad(`Failed to store key: ${redact(e.message)}`));
          }
        }
      } else {
        log(dim("Skipped provider setup for now."));
      }
    }
  }

  // ---- Phase 3: Check CLI / PATH availability ----
  log(paint(C.bold, "\n2. Checking CLI availability in PATH..."));
  const onPath = isOnPath("brushrouter");
  if (onPath) {
    log(`  ${ok("✓")} 'brushrouter' (and shorthand 'br') command available on your PATH`);
  } else {
    log(`  ${warn("○")} 'brushrouter' is not currently in your PATH`);
    const inPackage = existsSync(join(cwd, "package.json"));
    if (inPackage && dry) {
      // --dry-run must not spawn npm link, which writes into the global prefix.
      log(dim("  Dry run: would run 'npm link' to add 'brushrouter' and 'br' to your PATH"));
    } else if (inPackage && interactive && !dry) {
      const wantLink = await prompt("  Run 'npm link' now to make 'brushrouter' available globally? [Y/n] ");
      if (!/^n/i.test(wantLink)) {
        try {
          const res = spawnSync("npm", ["link"], { stdio: "pipe", timeout: NPM_LINK_TIMEOUT_MS, killSignal: "SIGKILL" });
          if (res.status === 0 && isOnPath("brushrouter")) {
            log(`  ${ok("✓")} Successfully linked! 'brushrouter' and 'br' are now available globally`);
          } else {
            log(warn(`  npm link did not make brushrouter available${res.error ? `: ${redact(res.error.message)}` : ` (exit ${res.status ?? res.signal ?? "unknown"})`}`));
          }
        } catch {
          log(dim("  Tip: Run 'npm link' manually or add this folder's bin/ to your PATH."));
        }
      }
    } else {
      log(dim("  Tip: Run 'npm link' or add ~/.local/bin to PATH to use 'brushrouter' from any directory."));
    }
  }

  // ---- Phase 4: AI Agent MCP Integrations ----
  if (!skipMcp) {
    log(paint(C.bold, "\n3. Checking AI agent MCP integrations..."));
    const detectedAgents = detectInstalledAgents().filter((a) => a.isInstalled && !a.optInOnly);
    const unconfiguredAgents = detectedAgents.filter((a) => !a.hasBrushrouter);

    if (detectedAgents.length === 0) {
      log(dim("  No supported AI agent installations detected on this machine."));
      log(dim("  (Supported: Claude Code, Claude Desktop, Cursor, Oh-My-Pi, Pi, Windsurf, OpenCode, Cline, Roo Code)"));
    } else {
      const names = detectedAgents.map((a) => a.name).join(", ");
      log(`  Found ${detectedAgents.length} AI agent(s): ${names}`);

      let doInstall = false;
      if (unconfiguredAgents.length === 0) {
        log(`  ${ok("✓")} All detected agents already have brushrouter configured!`);
      } else if (!interactive) {
        doInstall = yes || dry;
        if (!doInstall) log(dim("  Skipping MCP changes without --yes."));
      } else {
        const promptText = `  Wire brushrouter MCP into ${unconfiguredAgents.map((a) => a.name).join(", ")}? [Y/n] `;
        const answer = await prompt(promptText);
        doInstall = !/^n/i.test(answer);
      }

      if (doInstall && unconfiguredAgents.length > 0) {
        const entry = getBrushrouterMcpEntry();
        for (const agent of unconfiguredAgents) {
          const res = installMcpToAgent(agent, entry, { dry });
          if (res.status === "updated" || res.status === "created") {
            log(`  ${ok("✓")} ${agent.name.padEnd(14)} — configured brushrouter MCP`);
          } else if (dry && res.status.startsWith("would-")) {
            log(dim(`  Dry run: ${res.status} ${redact(res.path)}`));
          } else if (res.status === "error") {
            log(`  ${bad("!")} ${agent.name.padEnd(14)} — ${bad(res.error)}`);
          }
        }
        if (!dry) {
          log(dim("  Restart your agents or reload MCP servers to pick up the new tools."));
        }
      }
    }
  }

  // ---- Phase 4: Coding Tool Rules Injection ----
  log(paint(C.bold, "\n4. Checking AI coding tool rules (AGENTS.md, CLAUDE.md, .cursorrules)..."));
  const detectedRules = detectRuleFiles().filter((r) => r.exists);
  const unconfiguredRules = detectedRules.filter((r) => !r.hasRule);

  if (detectedRules.length === 0) {
    log(dim("  No existing rule files found (AGENTS.md, CLAUDE.md, .cursorrules)."));
    log(dim("  Tip: Run `brushrouter rules --create` anytime to generate a project rule file."));
  } else {
    const fileNames = detectedRules.map((r) => r.name).join(", ");
    log(`  Found ${detectedRules.length} coding tool rule file(s): ${fileNames}`);

    let doInject = false;
    if (unconfiguredRules.length > 0) {
      if (interactive && !dry) {
        const wantRules = await prompt(`  Inject clean brushrouter guidance into ${unconfiguredRules.length} rule file(s)? (~60 tokens) [Y/n] `);
        doInject = !/^n/i.test(wantRules);
      } else {
        doInject = yes || dry;
        if (!doInject) log(dim("  Skipping rules changes without --yes."));
      }
    } else {
      log(`  ${ok("✓")} All detected coding tool rule files already contain brushrouter guidance.`);
    }

    if (doInject && unconfiguredRules.length > 0) {
      for (const rule of unconfiguredRules) {
        const res = injectRuleToFile(rule.path, { dry });
        if (res.status === "updated" || res.status === "created") {
          log(`  ${ok("✓")} ${rule.name.padEnd(25)} — injected clean rule block`);
        } else if (dry && res.status.startsWith("would-")) {
          log(dim(`  Dry run: ${res.status} ${redact(res.path)}`));
        } else if (res.status === "error") {
          log(`  ${bad("!")} ${rule.name.padEnd(25)} — ${bad(res.error)}`);
        }
      }
    }
  }

  // ---- Phase 5: Verification Smoke Test ----
  if (ready.length > 0 && !skipTest && interactive && !dry) {
    log(paint(C.bold, "\n5. Verifying with test generation..."));
    const wantTest = await prompt("  Generate a quick test image to verify everything works? [y/N] ");
    if (/^y/i.test(wantTest)) {
      const testPrompt = "a tiny cute robot holding a paintbrush";
      const testOut = join(homedir(), "brushrouter-test.png");
      process.stdout.write(`  Generating with ${ready[0].id}... `);
      const start = Date.now();
      try {
        const { generate } = await import("../src/router.js");
        // generate(opts, cfgIn) — the arguments were once swapped here, so the
        // smoke test threw `Cannot read properties of undefined (reading
        // 'filter')` from attemptOrder() and blamed the user's setup.
        // The real return shape is { buffer, meta, provider, attempts }
        // (see src/router.js generate()); `out` is passed through to the
        // provider but the CLI writes the file itself, so do that here too.
        const res = await generate(
          { prompt: testPrompt, out: testOut, provider: ready[0].id, cwd },
          cfg,
        );
        if (!res || !Buffer.isBuffer(res.buffer) || res.buffer.length === 0) {
          throw new Error(`${res?.provider || ready[0].id} returned no image data`);
        }
        const saved = saveImage(testOut, res.buffer, cwd, { force: true, matchExtension: true });
        const sec = ((Date.now() - start) / 1000).toFixed(1);
        const kb = Math.round(res.buffer.length / 1024);
        const mime = detectImageMime(res.buffer) || "image/png";
        log(ok(`✓ done in ${sec}s!`));
        log(ok(`  Saved: ${saved.savedPath} (${mime}, ${kb} KB via ${res.provider}${res.meta?.model ? `/${res.meta.model}` : ""})`));
      } catch (e) {
        log(bad(`failed: ${redact(e.message)}`));
        if (e.attempts?.length) {
          log(dim(`  attempts: ${e.attempts.map((a) => `${a.provider}=${a.outcome}`).join(" → ")}`));
        }
        log(dim("  Setup itself is fine — run `brushrouter doctor` to check this provider."));
      }
    }
  }

  // ---- Phase 6: Cheatsheet / Completion ----
  if (ready.length === 0) {
    log(bad("\nSetup did not find a usable provider — run `brushrouter doctor` for details."));
    return finish({ ok: false, ready: 0, providers: probes });
  }
  log(paint(C.bold, "\n🎉 brushrouter is ready!\n"));
  log("  CLI:     brushrouter gen \"a red fox in snow\" -o fox.png  (or shorthand: br gen ...)");
  log("  MCP:     Ask your AI agent to create or edit an image");
  log("  Rules:   br rules (sync clean ~60-token guidance into coding tools)");
  log("  Update:  br update (keep backends and prompt library current)");
  log("  Help:    br doctor | br prompts | br --help\n");

  // Exit explicitly. Every prompt pauses stdin and closes its readline
  // interface, but on Node a readline interface created with `terminal: true`
  // still leaves the stdin socket ref'd, so the process sat there after
  // "brushrouter is ready!". Flushing first also keeps a piped `setup` from
  // truncating.
  return finish({ ok: true, ready: ready.length, providers: probes });
}

async function main() {
  const argv = process.argv.slice(2);
  // A leading flag must not swallow the command. `brushrouter --json providers`
  // used to treat the ENTIRE argv as options, so `command` was null and the
  // process printed help and exited 0 — a successful-looking no-op. Walk past
  // leading flags (and the value of a flag that takes one) to find the command
  // token, then hand parseArgs the remaining flags plus that token, so it still
  // sees `--json` exactly once.
  const command = firstPositional(argv);
  // Everything that is a flag, plus the command token itself: parseArgs keeps
  // positionals, so the command survives for the subcommand to ignore.
  const rest = command.index === -1 ? argv : argv.filter((_, i) => i !== command.index);
  const args = parse(rest);
  if (args.error) {
    // Print+flush rather than exiting from parse(): a usage message on a pipe
    // must not be truncated by process.exit().
    console.error(bad(`error: ${args.error}`));
    console.error(dim("run `brushrouter --help` for usage"));
    return exitAfterFlush(2);
  }

  if (args.values.version || command.token === "version") {
    console.log(`brushrouter v${PKG.version}`);
    return exitAfterFlush(0);
  }

  if (!command.token || command.token === "help" || args.values.help) {
    console.log(help());
    return exitAfterFlush(0);
  }
  try {
  switch (command.token) {
    case "generate":
    case "gen":
      await cmdGenerate(args);
      break;
    case "batch":
      await cmdBatch(args);
      break;
    case "history":
    case "hist":
      await cmdHistory(args);
      break;
    case "replay":
      await cmdReplay(args);
      break;
    case "stats":
    case "usage":
      await cmdStats(args);
      break;
    case "providers":
    case "list":
      await cmdProviders(args);
      break;
    case "doctor":
      await cmdDoctor(args);
      break;
    case "models":
      await cmdModels(args);
      break;
    case "recipes":
      await cmdRecipes(args);
      break;
    case "prompts":
    case "prompt":
    case "inspire":
      await cmdPrompts(args);
      break;
    case "routes":
    case "route":
      await cmdRoutes(args);
      break;
    case "vendor": {
      const { installSidecar } = await import("../src/providers/gptweb2api.js");
      try {
        const bin = await installSidecar({ onLog: (l) => console.log(l) });
        console.log(`✓ installed: ${bin}`);
        console.log(`try: brushrouter routes enable gptweb2api && brushrouter gen "test" -p gptweb2api -o /tmp/t.png`);
      } catch (e) {
        console.error(`vendor failed: ${redact(e.message)}`);
        console.error(dim("release assets preferred when upstream cuts them; otherwise building needs: git + Go ≥1.24 on PATH"));
        return exitAfterFlush(1);
      }
      return;
    }
    case "login": {
      const { getConfigDir } = await import("../src/config.js");
      const { runLogin } = await import("../src/oauth.js");
      try {
        const { path, plan, accountId } = await runLogin({ configDir: getConfigDir(), log: (l) => console.log(l) });
        console.log(`✓ logged in — plan ${plan || "unknown"}, account ${accountId}`);
        console.log(`credentials: ${path}`);
        if (applyFreePlanRouting(plan)) {
          console.log(`✓ free plan detected — enabled gptweb2api route`);
          console.log(`try: brushrouter vendor && brushrouter gen "test" -p gptweb2api -o /tmp/t.png`);
        } else {
          console.log(`try: brushrouter gen "test" --provider codex -o /tmp/t.png`);
        }
      } catch (e) {
        // OAuth failures quote request/response bodies, which can carry a token
        // or client secret — every sibling branch redacts, and this one did not.
        console.error(bad(`login failed: ${redact(e.message)}`));
        return exitAfterFlush(1);
      }
      return;
    }
    case "init":
      await cmdInit(args);
      break;
    case "setup":
      await cmdSetup(args);
      break;
    case "install":
      await cmdInstall(args);
      break;
    case "rules":
      await cmdRules(args);
      break;
    case "update":
      await cmdUpdate(args);
      break;
    case "serve":
    case "mcp":
      return (await import("../src/mcp.js")).serveMcp({ cwd: process.cwd() });
    default:
      console.error(bad(`unknown command: ${command.token}`));
      console.error(dim("run `brushrouter --help` for usage"));
      return exitAfterFlush(2);
  }
  } finally {
    // The gptweb2api sidecar's open pipes pin the event loop; stop it once the
    // command is done (within one CLI run it stays warm for batch reuse).
    try { (await import("../src/providers/gptweb2api.js")).shutdownSidecar(); } catch {}
  }
}

main().catch((e) => {
  // A bad config or route name is the user's typo, not a crash: show the message
  // without a stack, the same way an invalid flag is reported.
  const detail = e.code === "BAD_CONFIG" ? e.message : e.stack || e.message;
  console.error(bad(`fatal: ${redact(detail)}`));
  return exitAfterFlush(1);
});
