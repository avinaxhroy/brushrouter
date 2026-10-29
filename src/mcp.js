// Minimal stdio MCP server (JSON-RPC 2.0, newline-delimited) — no dependencies.
//
// Exposes two tools: `generate_image`, which any MCP-capable agent can call, and
// `find_image_prompts`, which hands the agent a proven prompt to build from. The
// generate tool description advertises which providers are currently connected
// so the calling agent can make an informed choice (or let auto-routing decide).

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { generate, probeAll, batchGenerate } from "./router.js";
import { loadConfig } from "./config.js";
import { saveImage, detectImageMime, batchVariantPath, batchItemPath } from "./util/common.js";
import { redact, redactValue, safeParseMessage, OPAQUE_BYTES } from "./util/redact.js";
import { findRecipes, renderResult, categoryIds, recipeCounts, publicRecipe, listCategories } from "./library.js";

const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return pkg.version || "0.2.0";
  } catch {
    return "0.2.0";
  }
})();

export const TOOL_NAME = "generate_image";
export const PROMPT_TOOL_NAME = "find_image_prompts";
export const JOB_TOOL_NAME = "image_result";
export const BATCH_TOOL_NAME = "batch_generate_images";

const TOOL_SCHEMA = {
  name: TOOL_NAME,
  description:
    "Generate an image from a text prompt using the best available provider. " +
    "Supports automatic routing across multiple backends (ChatGPT subscription, " +
    "ChatGPT web session, Gemini, OpenRouter, fal.ai, custom HTTP) with fallback. " +
    "Generations are slow (often 1-2 minutes), so prefer async:true: it returns a jobId " +
    "immediately and you collect the image later with image_result, leaving you free to " +
    "do other work instead of blocking this call.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Text description of the image to generate." },
      provider: {
        type: "string",
        description:
          "Optional explicit provider id. Omit to auto-route. Use `brushrouter providers` to list connected providers.",
      },
      model: {
        type: "string",
        description:
          "Optional explicit model id for the chosen provider (e.g. x-ai/grok-imagine-image-2.0 for openrouter). Use `brushrouter models` to list ids. When set, the provider will not substitute a different model.",
      },
      fallback: { type: "boolean", description: "When an explicit provider is given, allow falling back to others if it fails." },
      size: { type: "string", description: "Image size, e.g. 1024x1024, 1536x1024, or auto." },
      quality: { type: "string", description: "Quality hint, e.g. low | medium | high | auto." },
      background: {
        type: "string",
        enum: ["opaque", "transparent"],
        description: "Background of the output. Pass \"transparent\" for stickers, icons or cutouts; you get an RGBA PNG (codex route) or a prompt-prompted transparent background elsewhere. Default opaque.",
      },
      out: { type: "string", description: "Output file path, relative to the working directory (an absolute path is written as given). Defaults to ./brushrouter-<timestamp>.png. Existing files are not overwritten: a new -v2/-v3 name is used instead." },
      images: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional reference image paths (for image-to-image / editing). Each file is read from the local filesystem and sent to the chosen provider, so only pass paths the user has agreed to upload.",
      },
      async: {
        type: "boolean",
        description:
          "Return a jobId immediately instead of waiting for the image. Recommended: generation takes 1-2 minutes. Poll image_result with the jobId when you are ready to collect it.",
      },
      count: {
        type: "integer",
        description:
          "Number of image variations to generate (default: 1, max 8). Each variation is saved to its own file (out.png -> out-1.png, out-2.png, ...) and returned as a separate image block, with a text summary listing every saved path. Variations are generated in parallel up to `concurrency`.",
      },
      concurrency: {
        type: "integer",
        description: "Optional maximum concurrency across providers when count > 1. Defaults to count.",
      },
    },
    required: ["prompt"],
  },
};
const BATCH_TOOL_SCHEMA = {
  name: BATCH_TOOL_NAME,
  description:
    "Generate multiple images in a batch from a list of prompts. Automatically routes and distributes " +
    "work across available backends in parallel (ChatGPT subscription, Gemini CLI, OpenRouter, etc.) " +
    "with per-provider concurrency limits and rate-limit circuit breaking so no backend is bottlenecked. " +
    "Generations can take several minutes, so async:true is strongly recommended.",
  inputSchema: {
    type: "object",
    properties: {
      prompts: {
        type: "array",
        items: { type: "string" },
        description: "List of prompt strings to generate.",
      },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            out: { type: "string" },
            size: { type: "string" },
            quality: { type: "string" },
            background: { type: "string", enum: ["opaque", "transparent"] },
            model: { type: "string" },
          },
          required: ["prompt"],
        },
        description: "List of items with per-item options (e.g. prompt, out, size, quality, model).",
      },
      outDir: {
        type: "string",
        description: "Directory to save generated images. Defaults to ./brushrouter-batch-<timestamp>.",
      },
      concurrency: {
        type: "integer",
        description: "Maximum concurrency across all providers.",
      },
      provider: {
        type: "string",
        description: "Optional explicit provider id. Omit to auto-distribute across all ready backends.",
      },
      fallback: {
        type: "boolean",
        description: "Allow fallback to other backends if explicit provider fails.",
      },
      embedImages: {
        type: "boolean",
        description:
          "Whether to embed base64 image data in the tool response. Defaults to true for <= 3 images, false for larger batches to conserve memory and agent context (images are always written to outDir).",
      },
      async: {
        type: "boolean",
        description: "Return a jobId immediately instead of blocking (strongly recommended for batches).",
      },
    },
  },
};

// The poll half of async generation. MCP has no standard "result arrives later"
// reply to a tools/call, so the lazy portable contract is: generate_image
// {async:true} hands back a jobId, and this tool collects it. Works with every
// client today, no capability negotiation.
const JOB_TOOL_SCHEMA = {
  name: JOB_TOOL_NAME,
  description:
    "Collect the image from an async generate_image call. Call it with the jobId returned by " +
    "generate_image {async:true}. While the job is still working it returns a status and you " +
    "should do other work and poll again; once complete it returns the saved path and the image " +
    "itself. Jobs live only for this server session.",
  inputSchema: {
    type: "object",
    properties: {
      jobId: { type: "string", description: "The jobId returned by generate_image with async:true." },
    },
    required: ["jobId"],
  },
};

function defaultOut() {
  return `brushrouter-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
}

// ---------------------------------------------------------------------------
// Async jobs.
//
// A blocking tools/call holds the agent's turn open for the whole generation.
// The job map lets generate_image return a jobId at once, so the agent can keep
// working and poll `image_result`. It is in-memory and per-server-process:
// ponytail: in-process Map, 1h TTL. Move to a file/dir if jobs must survive a
// server restart or be shared across concurrent MCP connections.
// ---------------------------------------------------------------------------
const jobs = new Map();
// How long a completed job stays pollable, and how many bytes of base64 payload
// stay cached. Env-overridable so a deployment can trade memory against how long
// a poll still finds its payload cached. A missing or nonsensical value falls
// back to the default: a NaN budget would make the comparison in evictPayloads()
// false for every job and silently evict them all.
function positiveEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const JOB_TTL_MS = positiveEnv("BRUSHROUTER_JOB_TTL_MS", 3600_000);
// Ceiling for a job that never reaches a terminal state. The TTL above is
// measured from *completion*, so a provider whose promise never settles (a
// socket that opens and then stalls, a CLI that never exits) would pin its job
// record — and its place in the Map — for the life of the process. Six hours is
// far beyond any real render: the slowest provider call is capped at ~5 minutes
// and a multi-provider fallback chain or a long batch still finishes well
// inside an hour, so nothing legitimate is ever cut short. An expired job is
// marked failed with the reason below rather than silently dropped, so a poll
// says what happened instead of "unknown jobId". Overridable like the other
// retention knobs (a test uses a few hundred ms to observe the sweep).
const MAX_WORKING_JOB_MS = positiveEnv("BRUSHROUTER_JOB_MAX_WORKING_MS", 6 * 3600_000);
// A completed job's image is already on disk, so its base64 payload is a cache,
// not the source of truth. Keeping every payload for the full TTL made a long
// agent session grow by one base64 image per generation with no limit. The
// budget keeps memory flat; an evicted payload is re-read from the file on the
// next poll, so nothing is lost — the cap only trades a ~2ms read for the bytes.
const MAX_RETAINED_BYTES = positiveEnv("BRUSHROUTER_JOB_MAX_BYTES", 32 * 1024 * 1024);
// Where runGenerate records the path it saved to. A symbol, so it never reaches
// the wire, and the async job can rebuild its payload after eviction.
const SAVED_PATH = Symbol("brushrouter.savedPath");

// "6h" / "300ms" — the working-job bound is env-overridable, including in tests
// that use a few hundred milliseconds, so the message must not assume hours.
function formatDuration(ms) {
  if (ms >= 3600_000) return `${Math.round(ms / 3600_000)}h`;
  if (ms >= 1000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms)}ms`;
}

function pruneJobs() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    // Age from completion, not creation: a render that took longer than the TTL
    // used to be deleted in the .finally() that ran the instant it finished, so
    // the image was on disk but image_result reported "unknown jobId".
    const endedAt = j.completedAt ?? j.createdAt;
    if (j.status !== "working") {
      if (now - endedAt > JOB_TTL_MS) jobs.delete(id);
      continue;
    }
    // A working job has no completion to measure from, so bound it by absolute
    // age and fail it explicitly — a hung provider must not pin memory forever.
    if (now - j.createdAt > MAX_WORKING_JOB_MS) {
      j.status = "failed";
      j.completedAt = now;
      j.error = j.error || `job did not finish within ${formatDuration(MAX_WORKING_JOB_MS)} and was pruned`;
      j.content = null;
    }
  }
  for (const j of evictPayloads([...jobs.values()])) j.content = null;
}

// Which completed jobs must give up their retained payload to stay within
// `maxBytes`. Newest-first, so a burst of polls on recent jobs keeps the fast
// path and only the older ones fall back to reading the saved file.
export function evictPayloads(entries, maxBytes = MAX_RETAINED_BYTES) {
  const evict = [];
  let budget = maxBytes;
  const withPayload = entries
    .filter((j) => j.status === "completed" && j.content)
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const j of withPayload) {
    if (budget - j.bytes >= 0) budget -= j.bytes;
    else evict.push(j);
  }
  return evict;
}

// `count` was advertised in the schema but never read, so `count:5` produced one
// image and reported success. It is implemented here rather than removed: the
// schema is the contract an agent plans against, and "how many variations" is a
// real thing providers can do. The cap keeps one call from fanning out into an
// unbounded number of paid generations.
const MAX_COUNT = 8;

// Positive integer or an error. A nonsensical value must not silently become
// one variation — that is the same lie as ignoring the parameter.
function positiveInt(value, name, { max } = {}) {
  if (value === undefined || value === null) return 1;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer (got ${JSON.stringify(value)})`);
  }
  if (max && n > max) throw new Error(`${name} must be at most ${max} (got ${n})`);
  return n;
}

// Run `fn` over `items` with at most `limit` in flight, preserving result order.
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Runs the generation and returns the exact tools/call content the agent would
// have received from a blocking call. Shared by the sync and async paths so the
// two can never drift.
async function runGenerate(args, ctx, onProgress) {
  const { cwd = process.cwd() } = ctx;
  const cfg = loadConfig({ cwd });
  const out = args.out || defaultOut();
  const count = positiveInt(args.count, "count", { max: MAX_COUNT });
  const concurrency = args.concurrency == null ? count : positiveInt(args.concurrency, "concurrency");
  if (count === 1) {
    const result = await generate({ ...args, out, cwd, fallback: args.fallback === true, onProgress }, cfg);
    const saved = saveImage(out, result.buffer, cwd);
    // SECURITY: every string handed back to the calling model passes through the
    // redactor, so a credential can never ride along inside a provider's message.
    const text = redact(
      [
        `Image generated successfully.`,
        `provider: ${result.provider}${result.meta?.model ? ` (${result.meta.model})` : ""}`,
        `saved: ${saved.savedPath}`,
        result.attempts?.length ? `attempts: ${result.attempts.map((a) => `${a.provider}=${a.outcome}`).join(", ")}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const block = imageBlock(result);
    result.buffer = null;
    const content = {
      content: [{ type: "text", text }, block],
      isError: false,
    };
    content[SAVED_PATH] = saved.savedPath;
    return content;
  }

  // Several variations: each needs its own file. batchVariantPath suffixes the
  // index before the extension (fox.png -> fox-1.png), and saveImage still
  // refuses to overwrite, so two callers cannot collide.
  const targets = Array.from({ length: count }, (_, i) => batchVariantPath(out, i + 1, count));
  const settled = await mapLimited(targets, concurrency, async (target, i) => {
    onProgress?.(`variation ${i + 1}/${count}...`, Math.round(((i + 1) / count) * 90));
    try {
      const result = await generate(
        { ...args, out: target, count: undefined, cwd, fallback: args.fallback === true },
        cfg,
      );
      const saved = saveImage(target, result.buffer, cwd);
      const block = imageBlock(result);
      result.buffer = null;
      return { ok: true, savedPath: saved.savedPath, provider: result.provider, model: result.meta?.model, block };
    } catch (e) {
      return { ok: false, error: redact(String(e?.message || e)) };
    }
  });

  const good = settled.filter((r) => r.ok);
  const textLines = [
    `Generated ${good.length}/${count} image variation(s).`,
    ...settled.map((r, i) =>
      r.ok ? `✓ [${i + 1}] ${r.provider}${r.model ? ` (${r.model})` : ""} -> ${r.savedPath}` : `✗ [${i + 1}] failed: ${r.error}`,
    ),
  ];
  const content = {
    content: [{ type: "text", text: redact(textLines.join("\n")) }, ...good.map((r) => r.block)],
    // Zero images means the call failed; a partial set is still a usable answer.
    isError: good.length === 0,
  };
  content[SAVED_PATH] = good.map((r) => r.savedPath).join("; ");
  return content;
}

// The image content block. `data` is base64 we produced from the provider's own
// bytes, so it is marked OPAQUE_BYTES and redactValue() passes it through
// instead of regex-scanning megabytes of it on every response. `mimeType` comes
// from the provider, so it stays on the normal redaction path.
function imageBlock(result) {
  const block = {
    type: "image",
    data: result.buffer.toString("base64"),
    mimeType: result.meta?.mime || detectImageMime(result.buffer) || "image/png",
  };
  block[OPAQUE_BYTES] = true;
  return block;
}

async function runBatchGenerate(args, ctx, onProgress) {
  const { cwd = process.cwd() } = ctx;
  const cfg = loadConfig({ cwd });

  let rawItems = [];
  if (Array.isArray(args.items) && args.items.length) {
    rawItems = args.items;
  } else if (Array.isArray(args.prompts) && args.prompts.length) {
    rawItems = args.prompts.map((p) => (typeof p === "string" ? { prompt: p } : p));
  } else {
    throw new Error("batch_generate_images requires 'prompts' or 'items' array");
  }

  // The schema declares `prompt` required, but MCP clients are not obliged to
  // validate against it. Sending an empty prompt to a provider costs a real
  // request and reports "✓" for a blank image, so reject it here and name the
  // offending index. A bare string entry is a prompt, not an object to spread —
  // spreading "a red fox" gave {0:'a',1:' ',...} and lost the prompt entirely.
  rawItems = rawItems.map((item, idx) => {
    const normalised = typeof item === "string" ? { prompt: item } : item;
    if (!normalised || typeof normalised !== "object" || Array.isArray(normalised)) {
      throw new Error(`batch_generate_images items[${idx}] must be a prompt string or an object with a prompt`);
    }
    if (typeof normalised.prompt !== "string" || normalised.prompt.trim() === "") {
      throw new Error(`batch_generate_images items[${idx}] is missing a non-empty "prompt"`);
    }
    return normalised;
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve(cwd, args.outDir || `brushrouter-batch-${timestamp}`);
  mkdirSync(outDir, { recursive: true });

  const items = rawItems.map((item, idx) => ({
    ...item,
    out: item.out ? resolve(outDir, item.out) : batchItemPath(outDir, idx + 1, rawItems.length, item.prompt),
  }));

  const shouldEmbed = args.embedImages === true || (!("embedImages" in args) && rawItems.length <= 3);
  const batchRes = await batchGenerate(
    {
      items,
      outDir,
      cwd,
      concurrency: args.concurrency == null ? undefined : positiveInt(args.concurrency, "concurrency"),
      provider: args.provider,
      fallback: args.fallback === true,
      retainBuffers: shouldEmbed,
      onProgress,
    },
    cfg,
  );

  const completedResults = batchRes.results.filter((r) => r.ok);
  const blocks = shouldEmbed
    ? completedResults
        .map((r) => {
          const buf = r.buffer || (r.savedPath && existsSync(r.savedPath) ? readFileSync(r.savedPath) : null);
          r.buffer = null;
          return buf ? imageBlock({ buffer: buf, meta: r.meta }) : null;
        })
        .filter(Boolean)
    : [];
  const textLines = [
    `Batch generation finished: ${batchRes.completed}/${batchRes.total} completed (${batchRes.failed} failed).`,
    `Directory: ${outDir}`,
    ...batchRes.results.map((r, i) =>
      r.ok ? `✓ [${i + 1}] ${r.provider} -> ${r.savedPath}` : `✗ [${i + 1}] failed: ${redact(r.error)}`,
    ),
  ];
  if (!shouldEmbed && completedResults.length > 0) {
    textLines.push(`(Image files written to ${outDir}; pass embedImages:true to include base64 payload in response)`);
  }
  const content = {
    content: [{ type: "text", text: redact(textLines.join("\n")) }, ...blocks],
    isError: batchRes.completed === 0 && batchRes.total > 0,
  };
  content[SAVED_PATH] = completedResults.map((r) => r.savedPath).join("; ");
  return content;
}


function startJob(argsIn, ctx, runner = runGenerate) {
  pruneJobs();
  const args = { ...argsIn, out: argsIn.out || defaultOut() };
  const job = { id: `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, status: "working", createdAt: Date.now(), out: args.out };
  jobs.set(job.id, job);

  const onProgress = (message, pct) => {
    job.message = message;
    job.progress = pct;
    // Progress notifications are only valid in reply to a request that sent a
    // progressToken, so stay silent when the client did not ask for them.
    if (ctx.progressToken == null) return;
    ctx.notify?.("notifications/progress", {
      progressToken: ctx.progressToken,
      progress: Number(pct) || 0,
      total: 100,
      message: redact(String(message)),
    });
  };

  runner(args, ctx, onProgress)
    .then((content) => {
      job.status = "completed";
      job.content = content;
      // Everything needed to rebuild the payload if pruneJobs() evicts it.
      job.savedPath = content[SAVED_PATH];
      job.bytes = content.content.filter((c) => c.type === "image").reduce((sum, img) => sum + (img.data?.length || 0), 0);
      job.summary = content.content.find((c) => c.type === "text")?.text;
      job.mimeType = content.content.find((c) => c.type === "image")?.mimeType;
      // The retention clock starts when the job finishes, not when it was
      // created: JOB_TTL_MS is how long a *collected* result stays pollable.
      job.completedAt = Date.now();
    })
    .catch((e) => {
      job.status = "failed";
      job.error = redact(String(e?.message || e));
      job.completedAt = Date.now();
    })
    .finally(() => {
      // A job whose promise settles late still needs a completion stamp for the
      // prune above; .then()/.catch() set it first, so this only fills gaps.
      job.completedAt = job.completedAt || Date.now();
      job.updatedAt = Date.now();
      pruneJobs();
      // Best-effort wake-up. The spec says requestors MUST NOT rely on this and
      // SHOULD keep polling, so `image_result` remains the real contract.
      ctx.notify?.("notifications/tasks/status", {
        taskId: job.id,
        status: job.status,
        ...(job.error ? { statusMessage: job.error } : {}),
      });
    });
  return job;
}

// The payload was evicted to bound memory. The image we wrote is the source of
// truth, so re-read it rather than dropping the result the agent asked for.
// The rebuilt payload is cached back onto the job: every poll used to re-read
// and re-base64 the whole file, which for a multi-megabyte image is far more
// expensive than the eviction it was recovering from.
function rebuildContent(job) {
  let paths = [];
  try {
    paths = (job.savedPath || "").split("; ").map((p) => p.trim()).filter(Boolean);
    const blocks = [];
    const missing = [];
    for (const p of paths) {
      if (!existsSync(p)) {
        missing.push(p);
        continue;
      }
      const buf = readFileSync(p);
      const block = {
        type: "image",
        data: buf.toString("base64"),
        mimeType: detectImageMime(buf) || "image/png",
      };
      block[OPAQUE_BYTES] = true;
      blocks.push(block);
    }
    // A success report with zero image blocks is a lie: the agent gets
    // "Image generated successfully." and no image, and cannot tell that the
    // payload was lost. The common cause is the file being deleted or the job
    // outliving its output, so name the path(s) that went missing.
    if (blocks.length === 0) {
      const where = missing.length ? ` (missing: ${missing.join(", ")})` : paths.length ? "" : " (no saved path was recorded)";
      const content = {
        content: [
          {
            type: "text",
            text: `Image job ${job.id} completed, but its image is no longer available${where}. Re-run the generation to write it again.`,
          },
        ],
        isError: true,
      };
      job.content = content;
      return content;
    }
    const content = {
      content: [{ type: "text", text: job.summary || `Image job ${job.id} completed.` }, ...blocks],
      isError: false,
    };
    job.content = content;
    job.bytes = blocks.reduce((sum, img) => sum + (img.data?.length || 0), 0);
    return content;
  } catch (e) {
    return {
      content: [{ type: "text", text: `Image job ${job.id} completed, but its saved image(s) could not be re-read (${e?.code || e?.message || e}).` }],
      isError: true,
    };
  }
}

function jobContent(job) {
  if (job.status === "completed") return job.content || rebuildContent(job);
  const elapsed = Math.round((Date.now() - job.createdAt) / 1000);
  if (job.status === "failed") {
    return { content: [{ type: "text", text: `Image job ${job.id} failed after ${elapsed}s: ${job.error}` }], isError: true };
  }
  return {
    content: [
      {
        type: "text",
        text: `Image job ${job.id} is still working (${elapsed}s elapsed${job.message ? `; ${job.message}` : ""}). Do other work and poll image_result again with this jobId.`,
      },
    ],
    isError: false,
  };
}

// The second tool, and the reason brushrouter is agent-first rather than just a
// pipe: it hands the calling model a proven prompt to build from instead of
// letting it invent one. The description is written to be read by a model, so it
// states when to call the tool, what to do with the result, and — most
// importantly — that having no reference photo is never a blocker.
//
// Two kinds of asset come back, and the distinction matters to the caller:
//   kind "job"  a layout to fill in  (ours)
//   kind "look" a fixed visual system to borrow, filled with your content
// Built on first use rather than at import: the tool description embeds live
// counts from the recipe library, and importing this module used to parse ~1 MB
// of JSON for every CLI command that never speaks MCP. Memoized, so the MCP
// server still pays for it exactly once.
let promptToolSchemaCache = null;
function promptToolSchema() {
  if (promptToolSchemaCache) return promptToolSchemaCache;
  const counts = recipeCounts();
  const JOB_COUNT = counts.job;
  const LOOK_COUNT = counts.look;
  const cats = categoryIds();
  const LOOK_NOTE = LOOK_COUNT ? `, plus ${LOOK_COUNT} vendored 'looks' (fixed visual systems you supply content for)` : "";
  promptToolSchemaCache = {
    name: PROMPT_TOOL_NAME,
    description:
      "Get a proven image prompt before calling generate_image. Call this when the request is vague ('a nice product shot', 'make me a logo', 'a character sheet') or when you want a reliable composition/lighting/layout structure. " +
      `Returns two kinds: kind:"job" — ${JOB_COUNT} recipes we wrote, each a layout with fillable slots${LOOK_NOTE}. ` +
      "Every entry works from text alone, so call it even when the user has no photo. " +
      `Modes: mode:"categories" (call first if you don't know what to ask for — lists the ${cats.length} categories and what each is good for); mode:"related" (default — best match plus similar); mode:"one" (exactly one). ` +
      "Pass input:\"image\" only if the user already has a reference image — it returns entries that know how to use one (what to accept, what to preserve) without ever making the image mandatory. " +
      "Results are previews by default. To get the finished prompt, re-call with full:true, id:\"<id>\", and values:{...}. " +
      "When full:true, the finished prompt is ready to pass to generate_image as `prompt` (STYLE LOCK and DO NOT REPRODUCE are already included automatically in the prompt body). " +
      "Set format:\"json\" to get structured JSON with publicRecipe objects, slotOptions, and clean prompt fields for programmatic agent access.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What the image should be, in the user's words. E.g. 'product hero shot on marble', 'character turnaround sheet', 'flyer for a music festival'." },
        category: { type: "string", description: `Restrict to one category. One of: ${cats.join(", ")}.` },
        kind: { type: "string", enum: ["job", "look"], description: "'job' = a layout to fill in (a product shot, a character sheet). 'look' = a fixed visual system to borrow (a specific editorial or poster style). Omit to search both." },
        input: { type: "string", enum: ["text", "image"], description: "What the user brings. 'text' (default) = an idea only, everything applies. 'image' = they already have a reference photo, so return only entries that can use one." },
        shape: { type: "string", enum: ["single", "grid", "sheet", "document"], description: "What you want back: one image, one image of several panels, a reference sheet, or a designed page." },
        mode: { type: "string", enum: ["categories", "related", "one"], description: "categories = the map of what exists; related = one best match + similar (default); one = exactly one." },
        limit: { type: "integer", minimum: 0, maximum: 10, description: "Rows in `related` mode, including the best match. Default 4, max 10. 0 means one row. Values above 10 are clamped; negative or non-integer values are rejected." },
        offset: { type: "integer", minimum: 0, description: "Rows to skip before the page, so results past the 10-row page cap are reachable. Default 0. Check `hasMore` in the response to tell whether another page exists." },
        full: { type: "boolean", description: "Return the finished prompt skeleton instead of a preview. Use it once you have picked an id." },
        id: { type: "string", description: "Fetch one exact entry by its id (returned on every result). Overrides query/mode." },
        format: { type: "string", enum: ["text", "json"], description: "Output format: 'text' (default human/terminal preview) or 'json' (structured JSON with publicRecipe objects, slotOptions, and clean prompt fields for programmatic agent access)." },
        values: {
          type: "object",
          description: "Slot values to substitute into the skeleton, e.g. {\"ratio\":\"16:9\",\"text\":\"NORTHWIND\"}. Anything not supplied keeps its default, except the free slots ({subject}, {text}, {location}, ...), which you must provide.",
          additionalProperties: { type: "string" },
        },
        seed: { type: "number", description: "Change this to get a different pick when the query is vague or empty. Same seed + same query = same result." },
      },
    },
  };
  return promptToolSchemaCache;
}

export async function handlePromptToolCall(args = {}) {
  const result = findRecipes({
    query: args.query,
    category: args.category,
    kind: args.kind,
    input: args.input || "text",
    shape: args.shape,
    mode: args.mode || "related",
    limit: args.limit,
    offset: args.offset,
    id: args.id,
    seed: Number(args.seed) || 0,
  });
  const values = args.values && typeof args.values === "object" ? args.values : {};
  if (args.format === "json") {
    const payload = result.mode === "categories"
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
          limit: result.limit,
          offset: result.offset,
          hasMore: result.hasMore,
          recipes: result.rows.map((r) => publicRecipe(r, { full: args.full === true, values, input: result.input })),
        };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      isError: false,
    };
  }
  return {
    content: [{ type: "text", text: renderResult(result, { full: args.full === true, values, input: result.input }) }],
    isError: false,
  };
}

export async function handleToolCall(name, args, ctx = {}) {
  if (name === PROMPT_TOOL_NAME) return handlePromptToolCall(args);
  if (name === JOB_TOOL_NAME) {
    pruneJobs();
    const job = jobs.get(String(args.jobId || ""));
    if (!job) {
      return { content: [{ type: "text", text: `unknown jobId "${args.jobId}" — jobs live only for this server session.` }], isError: true };
    }
    return jobContent(job);
  }
  if (name === BATCH_TOOL_NAME) {
    if (args.async === true) {
      const job = startJob(args, ctx, runBatchGenerate);
      return {
        content: [
          {
            type: "text",
            text: `Batch image generation started as job ${job.id}. Do not wait — continue with other work and call ${JOB_TOOL_NAME} with {"jobId":"${job.id}"} to collect the images when ready.`,
          },
        ],
        isError: false,
      };
    }
    return runBatchGenerate(args, ctx);
  }
  if (name !== TOOL_NAME) throw new Error(`unknown tool: ${name}`);
  if (args.async === true) {
    const job = startJob(args, ctx);
    return {
      content: [
        {
          type: "text",
          text: `Image generation started as job ${job.id} (out: ${job.out}). Do not wait — continue with other work and call ${JOB_TOOL_NAME} with {"jobId":"${job.id}"} to collect the image when it is ready.`,
        },
      ],
      isError: false,
    };
  }
  return runGenerate(args, ctx);
}

export async function handleRequest(msg, ctx) {
  // JSON-RPC 2.0: a message with no `id` is a notification, and a notification
  // MUST NOT get a response — the client has nothing to match one against.
  // (`id: null` is a request, a discouraged one the spec still answers.)
  // The check belongs here, not in the `default:` branch: a notification-form
  // tools/call used to run the tool AND emit an id-less frame, which is invalid
  // JSON-RPC. The work still runs for notifications that have side effects.
  const isNotification = msg.id === undefined;
  const response = await dispatchRequest(msg, ctx);
  return isNotification ? null : response;
}

async function dispatchRequest(msg, ctx) {
  const { id, method, params } = msg;
  pruneJobs();
  switch (method) {
    case "initialize": {
      const cfg = loadConfig({ cwd: ctx?.cwd });
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "brushrouter", version: PKG_VERSION },
          // Session-start guidance: tells the model when to reach for
          // brushrouter. Configurable (config `instructions`, or
          // BRUSHROUTER_INSTRUCTIONS); "" sends nothing.
          ...(cfg.instructions ? { instructions: cfg.instructions } : {}),
        },
      };
    }
    case "notifications/initialized":
      return null;
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: [TOOL_SCHEMA, BATCH_TOOL_SCHEMA, promptToolSchema(), JOB_TOOL_SCHEMA] } };
    case "tools/call": {
      try {
        const result = await handleToolCall(params?.name, params?.arguments || {}, {
          ...ctx,
          progressToken: params?._meta?.progressToken,
        });
        return { jsonrpc: "2.0", id, result };
      } catch (e) {
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: redact(`Failed: ${e.message}`) }], isError: true },
        };
      }
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    default:
      // A request (id present) for an unknown method gets the standard error; a
      // notification was already short-circuited to null by handleRequest.
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
  }
}

export function serveMcp({ cwd = process.cwd() } = {}) {
  let buf = "";
  // Cap the buffered request line: inputs are paths and prompts, not image bytes.
  // The cap is in BYTES; String.length would let multi-byte input through at up
  // to 3x the intended memory.
  const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
  const byteLength = (s) => Buffer.byteLength(s, "utf8");
  let pending = 0;
  let stdinEnded = false;

  const maybeExit = () => {
    // Only finish once every in-flight request has produced its response.
    // Never process.exit() here: stdout to a pipe is ASYNC, so exiting after
    // process.stdout.write() discards whatever has not been flushed yet (a
    // multi-megabyte base64 image is truncated at the 64 KB pipe buffer). Set
    // the exit code and let the event loop drain stdout, then exit naturally.
    if (stdinEnded && pending === 0) {
      process.exitCode = 0;
      process.stdin.pause();
    }
  };

  process.stdout.on("error", (err) => {
    if (err.code === "EPIPE") process.exit(0);
  });

  // Redact only the payload, never the envelope. JSON-RPC requires the client's
  // `id` echoed byte-for-byte or the response can never be matched to its
  // request, and a progressToken must likewise round-trip verbatim. The
  // producers of `result` already redact their own text (runGenerate,
  // handleToolCall), so this is a backstop for fields assembled elsewhere, not a
  // rewriter of the protocol frame.
  const redactPayload = (obj) => {
    // A batch reply is an array of responses: redact each element, or the whole
    // batch bypasses the backstop and returns payloads verbatim.
    if (Array.isArray(obj)) return obj.map(redactPayload);
    if (!obj || typeof obj !== "object") return obj;
    const out = { ...obj };
    if ("result" in out) out.result = redactValue(out.result);
    if (out.error && typeof out.error === "object") {
      const err = { ...out.error };
      if (typeof err.message === "string") err.message = redact(err.message);
      out.error = err;
    }
    // Notifications carry no result/error, but their message fields are
    // human-readable text built at the call site. Redact those two, and leave
    // progressToken and every structural field untouched.
    if (out.params && typeof out.params === "object" && !Array.isArray(out.params)) {
      const params = { ...out.params };
      for (const k of ["message", "statusMessage"]) {
        if (typeof params[k] === "string") params[k] = redact(params[k]);
      }
      out.params = params;
    }
    return out;
  };

  const send = (obj) => {
    try {
      process.stdout.write(JSON.stringify(redactPayload(obj)) + "\n");
    } catch (err) {
      if (err.code === "EPIPE") process.exit(0);
      throw err;
    }
  };

  const notify = (methodOrObj, params) => {
    if (typeof methodOrObj === "object" && methodOrObj !== null) {
      send(methodOrObj);
    } else {
      send({ jsonrpc: "2.0", method: methodOrObj, params });
    }
  };

  // One request object -> at most one response object. Batching is handled by
  // the caller (a JSON-RPC batch is an array of these, answered with an array).
  const respondTo = async (msg) => {
    pending++;
    try {
      // `notify` lets an async job push notifications (progress, task status)
      // out-of-band; the JSON-RPC response itself is sent below.
      return await handleRequest(msg, { cwd, notify });
    } catch (e) {
      // Only a request gets an error reply; a notification has no id to answer.
      if (msg?.id === undefined) return null;
      return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32603, message: redact(String(e?.message || e)) } };
    } finally {
      pending--;
      maybeExit();
    }
  };

  const handleLine = async (line) => {
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      // V8 quotes the offending slice of input back at us — `Unexpected token
      // 'S', "SECRETSETTING" is not valid JSON` — which is the caller's raw
      // bytes echoed to its own output/log. safeParseMessage() drops the quoted
      // fragment and keeps the useful part.
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${safeParseMessage(e)}` } });
      return;
    }
    // JSON-RPC 2.0 batch: an array of requests, answered with an array holding
    // one response per non-notification element (order not significant). An
    // empty array is itself invalid, so it gets a -32600. A batch of nothing but
    // notifications gets no reply at all.
    if (Array.isArray(msg)) {
      const isRequest = (m) => m != null && typeof m === "object" && !Array.isArray(m);
      if (msg.length === 0 || !msg.some(isRequest)) {
        // Not a batch of Requests at all (an array of strings, numbers, nested
        // arrays...). Answering it once is clearer to the client than a pile of
        // per-element -32600s, and the spec only defines a batch as an array of
        // Request objects.
        send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: expected a JSON object or an array of request objects" } });
        return;
      }
      const results = await Promise.all(
        msg.map((m) =>
          isRequest(m)
            ? respondTo(m)
            : { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: expected a JSON object" } },
        ),
      );
      const replies = results.filter(Boolean);
      if (replies.length > 0) send(replies);
      return;
    }
    if (!msg || typeof msg !== "object") {
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: expected a JSON object" } });
      return;
    }
    const res = await respondTo(msg);
    if (res) send(res);
  };

  process.stdin.setEncoding("utf8");
  let discarding = false; // skipping the tail of an abandoned oversized line
  const oversizeError = () =>
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: request exceeds the ${MAX_REQUEST_BYTES / 1048576}MB input limit` } });
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    if (discarding) {
      // Look ahead only for the newline that ends the abandoned line, then fall
      // through so whatever follows it is processed as normal requests.
      const nlIdx = buf.indexOf("\n");
      if (nlIdx < 0) {
        buf = "";
        return;
      }
      buf = buf.slice(nlIdx + 1);
      discarding = false;
    }
    // Measure BYTES, not UTF-16 code units: String.length counts a 3-byte
    // character as 1, so a multi-byte line was admitted at up to ~3x the cap.
    if (byteLength(buf) > MAX_REQUEST_BYTES && !buf.includes("\n")) {
      // A request line has grown past the cap unfinished. Requests carry paths
      // and prompts, never byte payloads, so this cannot be an actionable
      // request: drop it and answer the client once.
      buf = "";
      discarding = true;
      oversizeError();
      return;
    }
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = idx + 1 < buf.length ? buf.slice(idx + 1) : "";
      if (byteLength(line) > MAX_REQUEST_BYTES) {
        oversizeError();
        continue;
      }
      void handleLine(line);
    }
  });
  process.stdin.on("end", () => {
    stdinEnded = true;
    // Flush any trailing line without a newline.
    const rest = buf.trim();
    buf = "";
    if (rest) void handleLine(rest).then(maybeExit);
    else maybeExit();
  });
}

// Exported for tests / `brushrouter providers` enrichment.
export { probeAll };
