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
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadConfig, CONFIG_DIR, USER_CONFIG_PATH, DEFAULT_CONFIG } from "../src/config.js";
import { generate, probeAll, listProviderIds, setRouteEnabled, planAttemptOrder, PROVIDERS, batchGenerate, DEFAULT_PROVIDER_CONCURRENCY } from "../src/router.js";
import { saveImage, detectImageMime, assertImageFile, batchItemPath, pngSize } from "../src/util/common.js";
import { redact, redactValue, registerSecret } from "../src/util/redact.js";
import { discoverKey, saveKey, describeKey } from "../src/util/keys.js";
import { KEYS_PATH } from "../src/config.js";
import { findCodexCli, findGoogleClis, isOnPath } from "../src/util/discover.js";
import { findRecipes, renderResult, listCategories, publicRecipe, RECIPES_DIR, STYLES_FILE, recipeCounts } from "../src/library.js";
import { getKnownAgentConfigs, detectInstalledAgents, getBrushrouterMcpEntry, installMcpToAgent } from "../src/util/mcp-install.js";
import { detectRuleFiles, injectRuleToFile } from "../src/util/rules.js";
// NOTE: ../src/mcp.js is imported dynamically in the `serve` case below. A static
// import dragged the whole recipe library (and its ~1 MB of styles.json) into
// every command, including `--help`.

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Fails loudly: a corrupted package.json is a broken install, not a soft error.
const PKG = (() => {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
  } catch (e) {
    console.error(`fatal: cannot read brushrouter's own package.json: ${e.message}`);
    process.exit(1);
  }
})();

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

function parse(argv) {
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
      json: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      help: { type: "boolean", short: "h", default: false },
      verbose: { type: "boolean", short: "v", default: false },
      category: { type: "string", short: "c" },
      kind: { type: "string" },
      mode: { type: "string" },
      limit: { type: "string", short: "n" },
      full: { type: "boolean", default: false },
      "prompt-only": { type: "boolean", default: false },
      raw: { type: "boolean", default: false },
      id: { type: "string" },
      seed: { type: "string" },
      input: { type: "string" },
      shape: { type: "string" },
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
      version: { type: "boolean", short: "V", default: false },
    },
  });
  return { values, positionals };
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
  setup                    Auto-connect: detect what's here, ask only if needed
  login                    Sign in to ChatGPT for the codex route (browser OAuth,
                           no API key — nothing else needs to be installed)
  vendor gptweb2api        Install the browserless ChatGPT-web gateway binary
                           (release asset verified by SHA256SUMS, or built from
                           a pinned source commit with the local Go toolchain)
  generate, gen <prompt>   Generate an image (auto-routes across providers)
  batch <prompts...|file>  Batch generate multiple prompts in parallel across backends
  providers                List providers + connection status
  routes [enable|disable]  Show or toggle which routes auto-routing may use
  doctor                   Diagnose every provider's connectivity
  models [provider]        List available models (live, when the provider can)
  prompts [query]          Find a prompt recipe or a look to build an image from
  init [--force]           Write a starter config to ${dim(USER_CONFIG_PATH)}
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
      --json               Machine-readable output
  -c, --category <id>      Recipes: restrict to one category
      --kind <k>           Recipes: job (a layout we wrote, ${LIB_COUNTS.job}) | look
                           (a vendored visual system, ${LIB_COUNTS.look}). Omit for both
      --mode <m>           Recipes: categories | related (default) | one
  -n, --limit <n>          Recipes: how many to return (default 4, max 10)
      --prompt <text>      Prompt to generate (repeatable for multiple prompts in gen/batch)
      --concurrency <n>    Batch: max concurrent requests across providers
      --input <kind>       Recipes: text (default) | image — use image if you
                           already have a reference photo
      --shape <s>          Recipes: single | grid | sheet | document
      --id <id>            Recipes: fetch one exact recipe
      --set k=v            Recipes: fill a slot (repeatable; e.g. --set text=ACME)
      --full               Recipes: return the whole skeleton, not a preview
      --prompt-only, --raw Recipes: output only the filled prompt text (pipeable)
      --seed <n>           Recipes: vary the pick for a vague query
      --dry-run            gen: show the route it would take, send nothing.
                           routes/install: show what would change, apply nothing
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
  brushrouter gen "logo" -s 1024x1024 -q high
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
  Keys live in the environment or in ${dim(KEYS_PATH)} (mode 0600), never in
  logs, --json output, or MCP responses.
`;
}

async function cmdGenerate(args) {
  const { values, positionals } = args;
  if (values.prompt && values.prompt.length > 1) {
    return cmdBatch(args);
  }
  const prompt = values.prompt?.[0] || positionals.join(" ").trim();
  if (!prompt) {
    console.error(bad("error: no prompt given"));
    console.error(dim('usage: brushrouter gen "your prompt" [-o out.png]'));
    process.exit(2);
  }
  const cwd = process.cwd();
  const cfg = loadConfig({ cwd });
  const out = values.out || `brushrouter-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  // Reference images: validate before spending a request, and never let a route
  // silently drop them (they used to be accepted and ignored on 4 of 7 routes).
  const imagePaths = values.images || [];
  for (const p of imagePaths) {
    try {
      // Header-only: this loop only needs to reject a bad reference before a
      // request is spent. Encoding the file to base64 here just to discard it
      // cost a full read + encode per image on every generate.
      assertImageFile(p, cwd);
    } catch (e) {
      console.error(bad(`error: --images ${redact(e.message)}`));
      process.exit(2);
    }
  }
  if (values.background && values.background !== "transparent" && values.background !== "opaque") {
    console.error(bad("error: --background must be opaque or transparent"));
    process.exit(2);
  }
  if (imagePaths.length && values.provider) {
    // `supportsImages` is a static capability flag, not a health check. This used
    // to call probeAll() — spawning the Codex CLI and hitting the OpenRouter API
    // — to read a constant. An unknown id is left for generate() to reject.
    const p = PROVIDERS[values.provider];
    if (p && p.supportsImages === false) {
      const capable = Object.entries(PROVIDERS).filter(([, v]) => v.supportsImages !== false).map(([id]) => id);
      console.error(bad(`error: ${values.provider} cannot take reference images`));
      console.error(dim(`  --images is supported by: ${capable.join(", ")}`));
      process.exit(2);
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
      order = await planAttemptOrder(cfg, { provider: values.provider, fallback: values.fallback });
    } catch (e) {
      console.error(bad(`error: ${redact(e.message)}`));
      process.exit(1);
    }
    const rows = await probeAll(cfg);
    const byId = new Map(rows.map((r) => [r.id, r]));
    if (values.json) {
      console.log(JSON.stringify(redactValue({ dryRun: true, prompt, out, provider: values.provider || null, model: values.model || null, images: imagePaths, wouldTry: order.map((id) => ({ id, ready: Boolean(byId.get(id)?.available), detail: byId.get(id)?.detail || null })) }), null, 2));
      return;
    }
    console.log(paint(C.bold, "Dry run") + dim(" — no request sent, no quota used\n"));
    console.log(`  prompt:   ${prompt}`);
    console.log(`  out:      ${out}`);
    if (values.model) console.log(`  model:    ${values.model}`);
    if (imagePaths.length) console.log(`  images:   ${imagePaths.join(", ")}`);
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
        size: values.size,
        quality: values.quality,
        background: values.background || undefined,
        images: imagePaths,
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
    if (values.json) {
      console.log(JSON.stringify(redactValue({ ok: false, error: msg, code: e.code, attempts: e.attempts }), null, 2));
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
    process.exit(1);
  }

  let saved;
  try {
    saved = saveImage(out, result.buffer, cwd, { force: values.force });
  } catch (e) {
    if (values.json) {
      console.log(JSON.stringify(redactValue({ ok: false, error: e.message, code: "SAVE_FAILED" }), null, 2));
    } else {
      console.error(bad(`error: failed to save image to "${out}": ${e.message}`));
    }
    process.exit(1);
  }
  if (values.json) {
    console.log(
      JSON.stringify(
        redactValue({
          ok: true,
          provider: result.provider,
          model: result.meta?.model || null,
          path: saved.savedPath,
          bytes: result.buffer.length,
          attempts: result.attempts,
        }),
        null,
        2,
      ),
    );
  } else {
    const mime = detectImageMime(result.buffer) || "image/png";
    const dims = pngSize(result.buffer);
    const dimText = dims ? `, ${dims.width}x${dims.height}` : "";
    console.log(`${ok("✓")} generated with ${paint(C.cyan, result.provider)}${result.meta?.model ? dim(` (${result.meta.model})`) : ""}`);
    console.log(`  ${saved.savedPath} ${dim(`(${mime}${dimText}, ${(result.buffer.length / 1024).toFixed(0)} KB)`)}${saved.versioned ? warn("  [not overwritten — saved as new version]") : ""}`);
    if (result.attempts?.length > 1) {
      console.log(dim(`  routing: ${result.attempts.map((a) => `${a.provider}=${a.outcome}`).join(" → ")}`));
    }
    if (imagePaths.length && result.meta?.imagesUsed === false) {
      console.error(warn(`  warning: ${result.provider} ignored the ${imagePaths.length} reference image(s) you passed`));
    }
  }
}

function loadBatchItems(filePath, cwd) {
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

  const trimmed = content.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => (typeof item === "string" ? { prompt: item } : item)).filter((it) => it && it.prompt);
      }
    } catch {}
  }

  const lines = trimmed.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const items = [];
  for (const line of lines) {
    if (line.startsWith("{") && line.endsWith("}")) {
      try {
        const obj = JSON.parse(line);
        if (obj && obj.prompt) {
          items.push(obj);
          continue;
        }
      } catch {}
    }
    items.push({ prompt: line });
  }
  return items;
}

async function cmdBatch(args) {
  const { values, positionals } = args;
  const cwd = process.cwd();
  const cfg = loadConfig({ cwd });

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
      process.exit(1);
    }
    rawItems = [{ prompt: arg }];
  } else {
    const inputArg = positionals[0] || (process.stdin.isTTY ? null : "-");
    if (!inputArg) {
      console.error(bad("error: no prompts or batch file provided"));
      console.error(dim('usage: brushrouter batch "prompt 1" "prompt 2" ... [-o ./out-dir]'));
      console.error(dim("       brushrouter batch prompts.txt [-o ./out-dir]"));
      console.error(dim("       cat prompts.txt | brushrouter batch [-o ./out-dir]"));
      process.exit(2);
    }
    try {
      rawItems = loadBatchItems(inputArg, cwd);
    } catch (e) {
      console.error(bad(`error: ${redact(e.message)}`));
      process.exit(1);
    }
  }

  if (!rawItems.length) {
    console.error(bad("error: batch input contains no prompts"));
    process.exit(2);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve(cwd, values.out || `brushrouter-batch-${timestamp}`);

  const items = rawItems.map((item, idx) => ({
    ...item,
    size: item.size || values.size,
    quality: item.quality || values.quality,
    background: item.background || values.background,
    model: item.model || values.model,
    images: item.images || values.images || [],
    out: item.out ? resolve(outDir, item.out) : batchItemPath(outDir, idx + 1, rawItems.length, item.prompt),
  }));

  const onProgress = values.verbose
    ? (msg) => process.stderr.write(dim(`  · ${redact(msg)}\n`))
    : null;

  if (values["dry-run"]) {
    const probes = await probeAll(cfg);
    const readyProbes = probes.filter((p) => p.enabled && p.available);
    const concurrency = values.concurrency
      ? Number(values.concurrency)
      : readyProbes.reduce((sum, p) => sum + (DEFAULT_PROVIDER_CONCURRENCY[p.id] || 1), 0);

    if (values.json) {
      console.log(
        JSON.stringify(
          redactValue({
            dryRun: true,
            totalItems: items.length,
            outDir,
            concurrency,
            readyProviders: readyProbes.map((p) => ({ id: p.id, concurrency: DEFAULT_PROVIDER_CONCURRENCY[p.id] || 1 })),
            items: items.map((it, idx) => ({ index: idx + 1, prompt: it.prompt, out: it.out })),
          }),
          null,
          2,
        ),
      );
      return;
    }

    console.log(paint(C.bold, "Batch Dry Run") + dim(` — ${items.length} item(s), no requests sent, no quota used\n`));
    console.log(`  out directory:  ${outDir}`);
    console.log(`  concurrency:    ${concurrency} worker(s) across ready backends`);
    console.log(dim("  ready backends:"));
    for (const p of readyProbes) {
      console.log(`    ${p.id.padEnd(12)} (concurrency limit: ${DEFAULT_PROVIDER_CONCURRENCY[p.id] || 1})`);
    }
    console.log(dim("\n  items to process:"));
    for (let i = 0; i < Math.min(items.length, 10); i++) {
      console.log(`    ${String(i + 1).padStart(2, " ")}. "${items[i].prompt.slice(0, 50)}" -> ${items[i].out}`);
    }
    if (items.length > 10) console.log(dim(`    ... and ${items.length - 10} more`));
    console.log("");
    return;
  }

  mkdirSync(outDir, { recursive: true });
  const manifestPath = join(outDir, "manifest.jsonl");

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
          const record = {
            ok: true,
            index: res.index + 1,
            prompt: res.item.prompt,
            savedPath: res.savedPath,
            provider: res.provider,
            model: res.meta?.model || null,
            attempts: res.attempts,
          };
          appendFileSync(manifestPath, JSON.stringify(redactValue(record)) + "\n");
          if (!values.json) {
            console.log(ok(`✓ [${res.index + 1}/${items.length}] ${res.provider} -> ${res.savedPath}`));
          }
        },
        onItemFail: (fail) => {
          const record = {
            ok: false,
            index: fail.index + 1,
            prompt: fail.item.prompt,
            error: redact(fail.error),
            code: fail.code,
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
    process.exit(1);
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
    process.exit(1);
  }
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
    console.log(`  ${r.id.padEnd(width)}  ${badge}  ${dim(r.label)}${r.supportsImages ? "" : dim("  (no reference images)")}`);
    if (r.detail) console.log(`  ${" ".repeat(width)}  ${dim(redact(r.detail))}`);
  }
  console.log(dim(`\nAuto-routing order: ${cfg.priority.join(" → ")}`));
}

async function cmdDoctor(args) {
  const cwd = process.cwd();
  const cfg = loadConfig({ cwd });
  const rows = await probeAll(cfg);
  const installedAgents = detectInstalledAgents().filter((a) => a.isInstalled);
  if (args.values.json) {
    console.log(
      JSON.stringify(
        redactValue({
          config: { user: USER_CONFIG_PATH, exists: existsSync(USER_CONFIG_PATH) },
          providers: rows,
          agents: installedAgents,
        }),
        null,
        2
      )
    );
    return;
  }
  console.log(paint(C.bold, "brushrouter doctor\n"));
  let usable = 0;
  for (const r of rows) {
    const mark = !r.enabled ? warn("○") : r.available ? ok("●") : bad("○");
    console.log(`${mark} ${paint(C.bold, r.id)} ${dim(`(${r.kind})`)}`);
    console.log(`    ${r.label}`);
    console.log(`    status: ${r.available ? ok("ready") : r.enabled ? bad(r.auth || "unavailable") : warn("disabled")}`);
    if (r.detail) console.log(`    ${dim(redact(r.detail))}`);
    if (r.expires) console.log(`    token expires: ${dim(r.expires)}`);
    if (r.note) console.log(`    ${dim("note: " + r.note)}`);
    console.log("");
    if (r.available && r.enabled) usable++;
  }
  console.log(usable > 0 ? ok(`\n${usable} provider(s) ready.`) : bad("\nNo providers ready — run `brushrouter setup` to connect one."));

  if (installedAgents.length > 0) {
    console.log(paint(C.bold, "\nMCP Agent Integrations:"));
    for (const a of installedAgents) {
      const mark = a.hasBrushrouter ? ok("●") : warn("○");
      const status = a.hasBrushrouter ? ok("configured") : warn("detected, MCP not wired (run `brushrouter install`)");
      console.log(`  ${mark} ${paint(C.bold, a.name.padEnd(16))} ${status} ${dim(a.path)}`);
    }
  }

  if (!existsSync(USER_CONFIG_PATH)) {
    console.log(dim(`\nTip: run \`brushrouter setup\` to configure your environment and agents.`));
  }
}

async function cmdModels(args) {
  const cfg = loadConfig({ cwd: process.cwd() });
  const only = args.positionals?.[0] || null;
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
    fal: ["fal-ai/flux/schnell", "fal-ai/flux/dev", "fal-ai/flux-pro/v1.1"],
    "custom-http": ["(from your config)"],
  };
  // OpenRouter is the one provider with a live catalogue — fetch it so the user
  // sees exactly what THEIR key can reach (image-only models included).
  let live = null;
  if (!only || only === "openrouter") {
    try {
      const { openrouterListModels } = await import("../src/providers/http.js");
      live = await openrouterListModels(cfg.providers?.openrouter || {});
    } catch {
      live = null;
    }
  }
  if (live?.length) known.openrouter = live.map((m) => `${m.id}${dim(`  [${m.endpoint}]`)}`);
  else if (!only || only === "openrouter") known.openrouter = ["(could not list — run `brushrouter doctor` to check the key)"];

  const entries = Object.entries(known).filter(([id]) => !only || id === only);
  if (args.values.json) {
    const out = {};
    for (const [id, list] of entries) out[id] = { configured: cfg.providers?.[id]?.model || null, models: list.map((s) => String(s).replace(/\u001b\[[0-9;]*m/g, "")) };
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(paint(C.bold, "Models per provider") + dim(only ? ` (${only})` : "") + "\n");
  for (const [id, list] of entries) {
    const cur = cfg.providers?.[id]?.model;
    const enabled = cfg.providers?.[id]?.enabled !== false;
    console.log(`${paint(C.bold, id)}${enabled ? "" : warn(" (disabled)")}${cur ? dim(`  (pinned: ${cur})`) : ""}`);
    for (const m of list) console.log(`  ${m}`);
    console.log("");
  }
  if (!only) console.log(dim("Pin one with: brushrouter gen \"...\" -p openrouter -m <model-id>"));
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
  if (!["categories", "related", "one"].includes(mode)) {
    console.error(bad(`unknown --mode "${mode}" (use: categories | related | one)`));
    process.exit(2);
  }

  // --set ratio=16:9 --set text=ACME fills slots in the returned skeleton.
  const slotValues = {};
  for (const pair of values.set || []) {
    const eq = pair.indexOf("=");
    if (eq < 1) {
      console.error(bad(`--set expects key=value, got "${pair}"`));
      process.exit(2);
    }
    slotValues[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
  }

  // Reject a typo'd number instead of coercing it to NaN, which used to make a
  // matching query report "Nothing matched".
  for (const [flag, raw] of [["--limit", values.limit], ["--seed", values.seed]]) {
    if (raw !== undefined && !Number.isFinite(Number(raw))) {
      console.error(bad(`error: ${flag} expects a number, got "${raw}"`));
      process.exit(2);
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
      limit: values.limit ? Number(values.limit) : undefined,
      id: values.id,
      seed: values.seed ? Number(values.seed) : 0,
    });
  } catch (e) {
    console.error(bad(`error: ${e.message}`));
    process.exit(1);
  }
  if (values["prompt-only"] || values.raw) {
    if (!result.rows.length) {
      console.error(bad(result.matched ? `no recipes returned (limit ${result.limit})` : `nothing matched "${result.query || values.id || ""}"`));
      process.exit(1);
    }
    const pub = publicRecipe(result.rows[0], { full: true, values: slotValues, input: result.input });
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
              available: result.available,
              recipes: result.rows.map((r) => publicRecipe(r, { full: values.full, values: slotValues, input: result.input })),
            },
        null,
        2,
      ),
    );
    return;
  }
  console.log(renderResult(result, { full: values.full, values: slotValues, input: result.input }));
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
    process.exit(2);
  }
  if (action && !names.length) {
    console.error(bad("no route given"));
    console.error(dim(`known routes: ${listProviderIds().join(", ")}`));
    process.exit(2);
  }
  if (action) {
    const enable = action === "enable" || action === "on";
    const dry = args.values["dry-run"];
    let path = null;
    for (const name of names) {
      if (!listProviderIds().includes(name)) {
        console.error(bad(`error: unknown route "${name}" (known: ${listProviderIds().join(", ")})`));
        process.exit(2);
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
        process.exit(1);
      }
    }
    if (dry) {
      console.log(warn(`\nDry run: ${names.length} route(s) would change. Re-run without --dry-run to apply.`));
      return;
    }
    console.log(dim(`\nwritten to ${path}`));
    console.log(dim("A disabled route is skipped by auto-routing; --provider <id> still forces it."));
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

async function cmdUpdate(args) {
  console.log(paint(C.bold, `brushrouter update (current version: v${PKG.version})\n`));
  const isGit = existsSync(join(PACKAGE_ROOT, ".git"));

  const dry = args.values["dry-run"];
  if (dry) {
    if (isGit) {
      console.log(`Dry run: would run 'git pull --rebase' in ${PACKAGE_ROOT}`);
    } else {
      console.log("Dry run: would run 'npm install -g brushrouter@latest'");
    }
    return;
  }

  if (isGit) {
    console.log(`Checking for updates via git (${dim(PACKAGE_ROOT)})...`);
    const pullRes = spawnSync("git", ["pull", "--rebase"], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      timeout: 30000,
    });
    if (pullRes.status === 0) {
      const out = (pullRes.stdout || "").trim();
      console.log(out.includes("Already up to date") ? dim(`  ${out}`) : ok(`  ${out}`));
    } else {
      console.error(bad(`  git pull failed: ${(pullRes.stderr || pullRes.stdout || "").trim()}`));
    }

    try {
      spawnSync("npm", ["link"], { cwd: PACKAGE_ROOT, stdio: "ignore" });
    } catch {}
  } else {
    console.log("Checking for updates via npm global...");
    const npmRes = spawnSync("npm", ["install", "-g", "brushrouter@latest"], {
      encoding: "utf8",
      timeout: 60000,
    });
    if (npmRes.status === 0) {
      console.log(ok("  Updated brushrouter via npm install -g brushrouter@latest"));
    } else {
      console.log(dim("  To update manually, run: npm install -g brushrouter@latest"));
      console.log(dim("  Or re-run the one-liner: curl -fsSL https://raw.githubusercontent.com/OWNER/brushrouter/main/install.sh | bash"));
    }
  }

  try {
    const updatedPkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
    console.log(`\n${ok("✓")} Current version: ${paint(C.bold, `v${updatedPkg.version}`)}`);
  } catch {}

  console.log("\nVerifying providers and routing after update:");
  await cmdDoctor({ values: { json: false } });
}

function cmdInit(args) {
  if (existsSync(USER_CONFIG_PATH) && !args.values.force) {
    console.error(warn(`config already exists: ${USER_CONFIG_PATH}`));
    console.error(dim("use `brushrouter init --force` to overwrite"));
    process.exit(1);
  }
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(USER_CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  console.log(`${ok("✓")} wrote ${USER_CONFIG_PATH}`);
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
//     exactly what to set and exit 0.
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

function prompt(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (hidden && stdin.isTTY) stdin.setRawMode(true);
    let val = "";
    const onData = (chunk) => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\n" || ch === "\r" || ch === "\u0004") {
          if (hidden && stdin.isTTY) stdin.setRawMode(wasRaw);
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          return resolve(val.trim());
        }
        if (ch === "\u0003") {
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          val = val.slice(0, -1);
          continue;
        }
        val += ch;
      }
    };
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function cmdSetup(args) {
  const cwd = process.cwd();
  let cfg = loadConfig({ cwd });
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !args.values.yes;
  const dry = args.values["dry-run"];
  const skipMcp = args.values["skip-mcp"];
  const skipTest = args.values["skip-test"];

  console.log(paint(C.bold, "brushrouter setup — auto-connect backends & AI agent MCP wiring\n"));

  // Ensure user config directory exists with safe permissions
  try {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  } catch {}

  // ---- Phase 1: Probe image generation capability ----
  console.log(paint(C.bold, "1. Checking image generation backends..."));

  let probes = await probeAll(cfg);
  let ready = probes.filter((p) => p.available && p.enabled);

  for (const p of probes) {
    if (p.available && p.enabled) {
      console.log(`  ${ok("✓")} ${paint(C.bold, p.id.padEnd(14))} — ${p.label} ${dim(`(${p.kind})`)}`);
      if (p.detail) console.log(`      ${dim(redact(p.detail))}`);
    } else if (p.available && !p.enabled) {
      console.log(`  ${warn("○")} ${paint(C.bold, p.id.padEnd(14))} — ${p.label} ${warn("(disabled in routes)")}`);
    }
  }

  if (ready.length > 0) {
    console.log(ok(`\n  ${ready.length} backend(s) ready to generate images immediately!`));
  } else {
    console.log(warn("\n  No image generation backends detected yet."));
  }

  // ---- Phase 2: Onboard missing credentials if needed ----
  if (ready.length === 0) {
    if (!interactive) {
      console.log(dim("\nNon-interactive session. To enable image generation:"));
      console.log(dim("  1. Sign in with ChatGPT:       brushrouter login"));
      console.log(dim("  2. Or set OpenRouter API key:  export BRUSHROUTER_OPENROUTER_KEY=sk-or-..."));
      console.log(dim("  3. Or set fal.ai API key:      export BRUSHROUTER_FAL_KEY=..."));
      console.log(dim("  4. Or run 'brushrouter setup' interactively in a terminal."));
    } else {
      console.log(dim("\nLet's connect your first backend (pick any):"));
      console.log(`  ${paint(C.bold, "1)")} Sign in with ChatGPT ${ok("[Recommended]")} — browser login (no API key needed)`);
      console.log(`  ${paint(C.bold, "2)")} Add an OpenRouter API key — access to FLUX, Gemini, Recraft, SD`);
      console.log(`  ${paint(C.bold, "3)")} Add a fal.ai API key — fast hosted FLUX and SD models`);
      console.log(`  ${paint(C.bold, "4)")} Skip for now (configure later)`);

      const choice = await prompt("\nSelect [1-4] (default 1): ");
      const picked = choice.trim() === "" ? "1" : choice.trim();

      if (picked === "1") {
        console.log(dim("\nOpening browser for ChatGPT OAuth sign-in..."));
        const { getConfigDir } = await import("../src/config.js");
        const { runLogin } = await import("../src/oauth.js");
        try {
          const { path, plan, accountId } = await runLogin({
            configDir: getConfigDir(),
            log: (l) => console.log(dim(l)),
          });
          console.log(ok(`\n✓ Logged into ChatGPT (plan: ${plan || "active"}, account: ${accountId})`));
          console.log(dim(`  Credentials saved to ${path} (mode 0600)`));
          const freeNote = applyFreePlanRouting(plan);
          if (freeNote) console.log(ok(`✓ ${freeNote}`));
          cfg = loadConfig({ cwd });
          probes = await probeAll(cfg);
          ready = probes.filter((p) => p.available && p.enabled);
        } catch (e) {
          console.log(bad(`\nLogin failed: ${redact(e.message)}`));
          console.log(dim("You can retry anytime with: brushrouter login"));
        }
      } else if (picked === "2") {
        const key = await prompt("Paste your OpenRouter key (input hidden): ", { hidden: true });
        if (key) {
          try {
            const path = saveKey("openrouter", key);
            setRouteEnabled("openrouter", true);
            console.log(ok(`✓ Saved OpenRouter key to ${path} (mode 0600)`));
            console.log(ok("✓ openrouter enabled for auto-routing"));
            cfg = loadConfig({ cwd });
            probes = await probeAll(cfg);
            ready = probes.filter((p) => p.available && p.enabled);
          } catch (e) {
            console.log(bad(`Failed to store key: ${redact(e.message)}`));
          }
        }
      } else if (picked === "3") {
        const key = await prompt("Paste your fal.ai key (input hidden): ", { hidden: true });
        if (key) {
          try {
            const path = saveKey("fal", key);
            setRouteEnabled("fal", true);
            console.log(ok(`✓ Saved fal.ai key to ${path} (mode 0600)`));
            console.log(ok("✓ fal enabled for auto-routing"));
            cfg = loadConfig({ cwd });
            probes = await probeAll(cfg);
            ready = probes.filter((p) => p.available && p.enabled);
          } catch (e) {
            console.log(bad(`Failed to store key: ${redact(e.message)}`));
          }
        }
      } else {
        console.log(dim("Skipped provider setup for now."));
      }
    }
  }

  // ---- Phase 3: Check CLI / PATH availability ----
  console.log(paint(C.bold, "\n2. Checking CLI availability in PATH..."));
  const onPath = isOnPath("brushrouter");
  if (onPath) {
    console.log(`  ${ok("✓")} 'brushrouter' (and shorthand 'br') command available on your PATH`);
  } else {
    console.log(`  ${warn("○")} 'brushrouter' is not currently in your PATH`);
    const inPackage = existsSync(join(cwd, "package.json"));
    if (inPackage && interactive && !dry) {
      const wantLink = await prompt("  Run 'npm link' now to make 'brushrouter' available globally? [Y/n] ");
      if (!/^n/i.test(wantLink)) {
        try {
          const res = spawnSync("npm", ["link"], { stdio: "pipe" });
          if (res.status === 0 && isOnPath("brushrouter")) {
            console.log(`  ${ok("✓")} Successfully linked! 'brushrouter' and 'br' are now available globally`);
          } else {
            console.log(dim("  npm link finished. If not found, ensure your npm global bin is in PATH."));
          }
        } catch {
          console.log(dim("  Tip: Run 'npm link' manually or add this folder's bin/ to your PATH."));
        }
      }
    } else {
      console.log(dim("  Tip: Run 'npm link' or add ~/.local/bin to PATH to use 'brushrouter' from any directory."));
    }
  }

  // ---- Phase 4: AI Agent MCP Integrations ----
  if (!skipMcp) {
    console.log(paint(C.bold, "\n3. Checking AI agent MCP integrations..."));
    const detectedAgents = detectInstalledAgents().filter((a) => a.isInstalled && !a.optInOnly);
    const unconfiguredAgents = detectedAgents.filter((a) => !a.hasBrushrouter);

    if (detectedAgents.length === 0) {
      console.log(dim("  No supported AI agent installations detected on this machine."));
      console.log(dim("  (Supported: Claude Code, Claude Desktop, Cursor, Oh-My-Pi, Pi, Windsurf, OpenCode, Cline, Roo Code)"));
    } else {
      const names = detectedAgents.map((a) => a.name).join(", ");
      console.log(`  Found ${detectedAgents.length} AI agent(s): ${names}`);

      let doInstall = false;
      if (unconfiguredAgents.length === 0) {
        console.log(`  ${ok("✓")} All detected agents already have brushrouter configured!`);
      } else if (!interactive) {
        doInstall = true;
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
            console.log(`  ${ok("✓")} ${agent.name.padEnd(14)} — configured brushrouter MCP`);
          } else if (res.status === "error") {
            console.log(`  ${bad("!")} ${agent.name.padEnd(14)} — ${bad(res.error)}`);
          }
        }
        if (!dry) {
          console.log(dim("  Restart your agents or reload MCP servers to pick up the new tools."));
        }
      }
    }
  }

  // ---- Phase 4: Coding Tool Rules Injection ----
  console.log(paint(C.bold, "\n4. Checking AI coding tool rules (AGENTS.md, CLAUDE.md, .cursorrules)..."));
  const detectedRules = detectRuleFiles().filter((r) => r.exists);
  const unconfiguredRules = detectedRules.filter((r) => !r.hasRule);

  if (detectedRules.length === 0) {
    console.log(dim("  No existing rule files found (AGENTS.md, CLAUDE.md, .cursorrules)."));
    console.log(dim("  Tip: Run `brushrouter rules --create` anytime to generate a project rule file."));
  } else {
    const fileNames = detectedRules.map((r) => r.name).join(", ");
    console.log(`  Found ${detectedRules.length} coding tool rule file(s): ${fileNames}`);

    let doInject = false;
    if (unconfiguredRules.length > 0) {
      if (interactive && !dry) {
        const wantRules = await prompt(`  Inject clean brushrouter guidance into ${unconfiguredRules.length} rule file(s)? (~60 tokens) [Y/n] `);
        doInject = !/^n/i.test(wantRules);
      } else {
        doInject = true;
      }
    } else {
      console.log(`  ${ok("✓")} All detected coding tool rule files already contain brushrouter guidance.`);
    }

    if (doInject && unconfiguredRules.length > 0) {
      for (const rule of unconfiguredRules) {
        const res = injectRuleToFile(rule.path, { dry });
        if (res.status === "updated" || res.status === "created") {
          console.log(`  ${ok("✓")} ${rule.name.padEnd(25)} — injected clean rule block`);
        } else if (res.status === "error") {
          console.log(`  ${bad("!")} ${rule.name.padEnd(25)} — ${bad(res.error)}`);
        }
      }
    }
  }

  // ---- Phase 5: Verification Smoke Test ----
  if (ready.length > 0 && !skipTest && interactive && !dry) {
    console.log(paint(C.bold, "\n5. Verifying with test generation..."));
    const wantTest = await prompt("  Generate a quick test image to verify everything works? [y/N] ");
    if (/^y/i.test(wantTest)) {
      const testPrompt = "a tiny cute robot holding a paintbrush";
      const testOut = join(homedir(), "brushrouter-test.png");
      process.stdout.write(`  Generating with ${ready[0].id}... `);
      const start = Date.now();
      try {
        const { generate } = await import("../src/router.js");
        const res = await generate(cfg, { prompt: testPrompt, out: testOut });
        const sec = ((Date.now() - start) / 1000).toFixed(1);
        const kb = Math.round(res.bytes.length / 1024);
        console.log(ok(`✓ done in ${sec}s!`));
        console.log(ok(`  Saved: ${res.savedPath} (${res.mime}, ${kb} KB)`));
      } catch (e) {
        console.log(bad(`failed: ${redact(e.message)}`));
      }
    }
  }

  // ---- Phase 6: Cheatsheet / Completion ----
  console.log(paint(C.bold, "\n🎉 brushrouter is ready!\n"));
  console.log("  CLI:     brushrouter gen \"a red fox in snow\" -o fox.png  (or shorthand: br gen ...)");
  console.log("  MCP:     Ask your AI agent to create or edit an image");
  console.log("  Rules:   br rules (sync clean ~60-token guidance into coding tools)");
  console.log("  Update:  br update (keep backends and prompt library current)");
  console.log("  Help:    br doctor | br prompts | br --help\n");
}

async function main() {
  const argv = process.argv.slice(2);
  // If the first token is a flag (e.g. `brushrouter --help` or `-h`), treat the
  // whole argv as options rather than mistaking the flag for a command name.
  const firstIsFlag = argv[0]?.startsWith("-");
  const command = firstIsFlag ? null : argv[0];
  const rest = firstIsFlag ? argv : argv.slice(1);
  const args = parse(rest);

  if (args.values.version || command === "version" || (!command && (args.values.version || rest[0] === "-V"))) {
    console.log(`brushrouter v${PKG.version}`);
    process.exit(0);
  }

  if (!command || command === "help" || args.values.help) {
    console.log(help());
    process.exit(0);
  }
  try {
  switch (command) {
    case "generate":
    case "gen":
      await cmdGenerate(args);
      break;
    case "batch":
      await cmdBatch(args);
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
        process.exit(1);
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
        console.log(`try: brushrouter gen "test" --provider codex -o /tmp/t.png`);
      } catch (e) {
        console.error(`login failed: ${e.message}`);
        process.exit(1);
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
      console.error(bad(`unknown command: ${command}`));
      console.error(dim("run `brushrouter --help` for usage"));
      process.exit(2);
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
  process.exit(1);
});
