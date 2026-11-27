// Generation history, manifest log, prompt/seed replay, and usage/latency stats.
//
// Zero dependencies. Append-only JSONL stored at ~/.config/brushrouter/history.jsonl
// (overridable via BRUSHROUTER_HISTORY_PATH or BRUSHROUTER_CONFIG_DIR).
//
// SECURITY: every record passes through redactValue() before serialization, and
// the history file is written with 0600 permissions inside a 0700 directory so
// prompts and local paths stay private to the user.

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { getHistoryPath } from "./config.js";
import { redact, redactValue } from "./util/redact.js";

export const HISTORY_SCHEMA_VERSION = 1;

// Providers backed by an existing subscription / local OAuth login rather than
// per-request API billing.
export const SUBSCRIPTION_PROVIDERS = new Set([
  "codex-cli",
  "codex",
  "gemini",
  "gptweb2api",
]);

// Conservative per-image USD estimates used ONLY when a metered provider does
// not return an explicit cost and the user has not configured `pricing`.
// Always tagged `costSource: "estimated"` so stats distinguish exact vs estimated.
export const DEFAULT_MODEL_PRICING_USD = {
  "fal-ai/flux/schnell": 0.003,
  "fal-ai/flux/dev": 0.025,
  "fal-ai/flux-pro": 0.05,
  "fal-ai/flux-pro/v1.1": 0.04,
  "fal-ai/flux-pro/v1.1-ultra": 0.06,
  "fal-ai/recraft-v3": 0.04,
  "fal-ai/ideogram/v2": 0.08,
  "fal-ai/stable-diffusion-v35-large": 0.065,
  "google/gemini-3.1-flash-image": 0.039,
  "google/gemini-3-pro-image": 0.06,
  "google/gemini-2.5-flash-image": 0.039,
  "google/gemini-2.5-flash-image-preview": 0.039,
  "openai/gpt-image-1": 0.04,
  "openai/gpt-image-1.5": 0.04,
  "x-ai/grok-imagine-image-2.0": 0.07,
  "black-forest-labs/flux.2-pro": 0.05,
  "black-forest-labs/flux.2-flex": 0.06,
  "meta/muse-image": 0.04,
};

export function generateHistoryId() {
  return `gen_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}

export function generateBatchId() {
  return `batch_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}

export function isHistoryDisabled(cfg = null) {
  if (cfg?.history?.enabled === false) return true;
  const noHist = process.env.BRUSHROUTER_NO_HISTORY;
  if (noHist && /^(1|true|yes)$/i.test(noHist.trim())) return true;
  const histEnv = process.env.BRUSHROUTER_HISTORY;
  if (histEnv !== undefined) {
    const val = histEnv.trim().toLowerCase();
    if (val === "0" || val === "false" || val === "no" || val === "off") return true;
  }
  return false;
}

// Parse a relative window ("30m", "24h", "7d", "4w", "1y") or ISO timestamp into
// epoch milliseconds. Returns null when input is null/undefined/"".
export function parseSince(since, now = Date.now()) {
  if (since == null || String(since).trim() === "") return null;
  const raw = String(since).trim();
  const rel = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w|y)$/i.exec(raw);
  if (rel) {
    const amount = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const mult = {
      s: 1000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
      w: 7 * 86_400_000,
      y: 365 * 86_400_000,
    }[unit];
    if (!Number.isFinite(amount) || amount < 0) {
      const e = new Error(`invalid --since value "${raw}"`);
      e.code = "BAD_SINCE";
      throw e;
    }
    return Math.round(now - amount * mult);
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    const e = new Error(`invalid --since value "${raw}" (use e.g. 24h, 7d, 30d, or an ISO date)`);
    e.code = "BAD_SINCE";
    throw e;
  }
  return parsed;
}

function roundUsd(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1_000_000) / 1_000_000;
}

export function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const promptTokens = Number(raw.promptTokens ?? raw.prompt_tokens ?? raw.input_tokens);
  const completionTokens = Number(raw.completionTokens ?? raw.completion_tokens ?? raw.output_tokens);
  const totalTokens = Number(raw.totalTokens ?? raw.total_tokens);
  const out = {};
  if (Number.isFinite(promptTokens) && promptTokens >= 0) out.promptTokens = promptTokens;
  if (Number.isFinite(completionTokens) && completionTokens >= 0) out.completionTokens = completionTokens;
  if (Number.isFinite(totalTokens) && totalTokens >= 0) {
    out.totalTokens = totalTokens;
  } else if (out.promptTokens != null || out.completionTokens != null) {
    out.totalTokens = (out.promptTokens || 0) + (out.completionTokens || 0);
  }
  return Object.keys(out).length ? out : null;
}

export function estimateCost({ provider, model, usage, costUsd, pricing = null } = {}) {
  const explicit = costUsd ?? usage?.cost;
  if (explicit != null && Number.isFinite(Number(explicit)) && Number(explicit) >= 0) {
    return { costUsd: roundUsd(Number(explicit)), costSource: "provider" };
  }
  if (pricing && typeof pricing === "object") {
    const candidates = [
      provider && model ? `${provider}/${model}` : null,
      model || null,
      provider || null,
    ].filter(Boolean);
    for (const key of candidates) {
      if (Object.hasOwn(pricing, key)) {
        const v = Number(pricing[key]);
        if (Number.isFinite(v) && v >= 0) {
          return { costUsd: roundUsd(v), costSource: "configured" };
        }
      }
    }
  }
  if (provider && SUBSCRIPTION_PROVIDERS.has(provider)) {
    return { costUsd: 0, costSource: "subscription" };
  }
  if (model && typeof model === "string") {
    const clean = model.trim().toLowerCase();
    if (Object.hasOwn(DEFAULT_MODEL_PRICING_USD, clean)) {
      return { costUsd: DEFAULT_MODEL_PRICING_USD[clean], costSource: "estimated" };
    }
    // Prefix match for dated/variant model ids (e.g. google/gemini-2.5-flash-image:free)
    const stripped = clean.split(":")[0];
    if (Object.hasOwn(DEFAULT_MODEL_PRICING_USD, stripped)) {
      return { costUsd: DEFAULT_MODEL_PRICING_USD[stripped], costSource: "estimated" };
    }
    for (const [key, price] of Object.entries(DEFAULT_MODEL_PRICING_USD)) {
      if (stripped.startsWith(`${key}/`) || stripped.startsWith(`${key}-`)) {
        return { costUsd: price, costSource: "estimated" };
      }
    }
  }
  return { costUsd: null, costSource: "unknown" };
}

function normalizeAttempts(attempts) {
  if (!Array.isArray(attempts)) return [];
  return attempts.map((a) => {
    const item = {
      provider: a.provider || null,
      outcome: a.outcome || "unknown",
    };
    if (a.model) item.model = a.model;
    if (a.reason) item.reason = redact(String(a.reason));
    if (a.code) item.code = String(a.code);
    if (Number.isFinite(a.durationMs) && a.durationMs >= 0) item.durationMs = Math.round(a.durationMs);
    return item;
  });
}

function normalizeSeed(seed) {
  if (seed === undefined || seed === null || seed === "") return null;
  const n = Number(seed);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

export function buildHistoryRecord(entry, { cfg = null, cwd = process.cwd() } = {}) {
  const provider = entry.provider || null;
  const model = entry.model || null;
  const usage = normalizeUsage(entry.usage);
  const ok = Boolean(entry.ok);
  const cost = ok
    ? estimateCost({
        provider,
        model,
        usage: entry.usage,
        costUsd: entry.costUsd,
        pricing: cfg?.pricing || entry.pricing || null,
      })
    : {
        costUsd: entry.costUsd != null && Number.isFinite(Number(entry.costUsd)) ? roundUsd(Number(entry.costUsd)) : 0,
        costSource: entry.costUsd != null ? "provider" : "none",
      };

  const record = {
    v: HISTORY_SCHEMA_VERSION,
    id: entry.id || generateHistoryId(),
    ts: entry.ts || new Date().toISOString(),
    source: entry.source || "api",
    ok,
    prompt: typeof entry.prompt === "string" ? entry.prompt : "",
    provider,
    requestedProvider: entry.requestedProvider || null,
    model,
    requestedModel: entry.requestedModel || null,
    size: entry.size || null,
    actualSize: entry.actualSize || null,
    quality: entry.quality || null,
    background: entry.background || null,
    seed: normalizeSeed(entry.seed),
    images: Array.isArray(entry.images)
      ? entry.images
          .filter((s) => typeof s === "string" && s.length > 0)
          .map((s) => (isAbsolute(s) ? s : resolve(cwd, s)))
      : [],
    imagesUsed: Boolean(entry.imagesUsed),
    recipe: entry.recipe || null,
    look: entry.look || null,
    values: entry.values && typeof entry.values === "object" && !Array.isArray(entry.values) ? entry.values : null,
    twist: entry.twist || null,
    out: entry.out || null,
    bytes: Number.isFinite(entry.bytes) && entry.bytes >= 0 ? entry.bytes : null,
    mime: entry.mime || null,
    durationMs: Number.isFinite(entry.durationMs) && entry.durationMs >= 0 ? Math.round(entry.durationMs) : null,
    attempts: normalizeAttempts(entry.attempts),
    usage,
    costUsd: cost.costUsd,
    costSource: entry.costSource || cost.costSource,
    replayOf: entry.replayOf || null,
    batchId: entry.batchId || null,
    error: entry.error ? redact(String(entry.error)) : null,
    errorCode: entry.errorCode || null,
  };
  return redactValue(record);
}

function ensureHistoryDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function lockPermissions(filePath) {
  try {
    chmodSync(filePath, 0o600);
  } catch {}
}

export function recordHistory(entry, { path = getHistoryPath(), cfg = null, cwd = process.cwd() } = {}) {
  if (isHistoryDisabled(cfg)) return null;
  const record = buildHistoryRecord(entry, { cfg, cwd });
  ensureHistoryDir(path);
  appendFileSync(path, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
  lockPermissions(path);
  return record;
}

let warnedHistoryWrite = false;
export function tryRecordHistory(entry, opts = {}) {
  try {
    return recordHistory(entry, opts);
  } catch (e) {
    if (!warnedHistoryWrite) {
      warnedHistoryWrite = true;
      process.stderr.write(`brushrouter: warning: could not write history log: ${redact(e.message)}\n`);
    }
    return null;
  }
}

export function readHistory({ path = getHistoryPath() } = {}) {
  if (!existsSync(path)) return { entries: [], corruptLines: 0, path };
  const raw = readFileSync(path, "utf8");
  const lines = raw.split(/\r?\n/);
  const entries = [];
  let corruptLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        entries.push(parsed);
      } else {
        corruptLines++;
      }
    } catch {
      corruptLines++;
    }
  }
  return { entries, corruptLines, path };
}

function matchesFilters(entry, filters, sinceMs, untilMs) {
  if (filters.provider && entry.provider !== filters.provider) {
    const inAttempts = Array.isArray(entry.attempts) && entry.attempts.some((a) => a.provider === filters.provider && a.outcome !== "skipped");
    if (!inAttempts) return false;
  }
  if (filters.model) {
    const m = String(filters.model).toLowerCase();
    const em = String(entry.model || "").toLowerCase();
    if (em !== m && !em.includes(m)) return false;
  }
  if (filters.status === "ok" && !entry.ok) return false;
  if (filters.status === "failed" && entry.ok) return false;
  if (filters.source && entry.source !== filters.source) return false;
  if (filters.batchId && entry.batchId !== filters.batchId) return false;
  if (filters.replayOf && entry.replayOf !== filters.replayOf) return false;
  if (sinceMs != null || untilMs != null) {
    const t = Date.parse(entry.ts);
    if (!Number.isFinite(t)) return false;
    if (sinceMs != null && t < sinceMs) return false;
    if (untilMs != null && t > untilMs) return false;
  }
  if (filters.query) {
    const q = String(filters.query).toLowerCase();
    const hay = [
      entry.id,
      entry.prompt,
      entry.provider,
      entry.model,
      entry.out,
      entry.recipe,
      entry.look,
      entry.error,
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export function listHistory(filters = {}, { path = getHistoryPath(), now = Date.now() } = {}) {
  const { entries: all, corruptLines } = readHistory({ path });
  const sinceMs = parseSince(filters.since, now);
  const untilMs = parseSince(filters.until, now);

  let filtered = all.filter((e) => matchesFilters(e, filters, sinceMs, untilMs));
  const order = filters.order === "asc" ? "asc" : "desc";
  if (order === "desc") filtered = [...filtered].reverse();

  const offset = filters.offset == null ? 0 : Math.max(0, Number(filters.offset) || 0);
  const limit = filters.limit === 0 ? filtered.length : filters.limit == null ? 20 : Math.max(1, Number(filters.limit) || 20);
  const page = filtered.slice(offset, offset + limit);

  return {
    entries: page,
    total: all.length,
    matched: filtered.length,
    limit,
    offset,
    hasMore: offset + page.length < filtered.length,
    corruptLines,
    path,
  };
}

export function getHistoryEntry(selector, { path = getHistoryPath(), cwd = process.cwd() } = {}) {
  if (!selector || typeof selector !== "string" || !selector.trim()) {
    const e = new Error("history selector is required (an id, prefix, 'last', '~N', or saved file path)");
    e.code = "BAD_SELECTOR";
    throw e;
  }
  const raw = selector.trim();
  const { entries } = readHistory({ path });
  if (!entries.length) {
    const e = new Error("generation history is empty");
    e.code = "NOT_FOUND";
    throw e;
  }

  // Relative selectors: last, latest, ~1 (most recent), ~2 (2nd most recent), ...
  if (raw === "last" || raw === "latest" || raw === "~1" || raw === "~0") {
    return entries[entries.length - 1];
  }
  const tilde = /^~(\d+)$/.exec(raw);
  if (tilde) {
    const idx = Number(tilde[1]);
    if (idx < 1 || idx > entries.length) {
      const e = new Error(`history entry ${raw} out of range (${entries.length} entry/entries recorded)`);
      e.code = "NOT_FOUND";
      throw e;
    }
    return entries[entries.length - idx];
  }

  // Exact ID match (search newest first)
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].id === raw) return entries[i];
  }

  // Unique ID prefix match
  const prefixMatches = entries.filter((e) => typeof e.id === "string" && e.id.startsWith(raw));
  if (prefixMatches.length === 1) return prefixMatches[0];
  if (prefixMatches.length > 1) {
    const e = new Error(
      `ambiguous history id prefix "${raw}" matches ${prefixMatches.length} entries: ${prefixMatches
        .slice(-5)
        .map((m) => m.id)
        .join(", ")}`,
    );
    e.code = "AMBIGUOUS_ID";
    throw e;
  }

  // Output file path match (exact or resolved relative to cwd)
  const resolvedPath = isAbsolute(raw) ? raw : resolve(cwd, raw);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].out === raw || entries[i].out === resolvedPath) return entries[i];
  }

  const e = new Error(`no history entry found matching "${raw}"`);
  e.code = "NOT_FOUND";
  throw e;
}

export function buildReplayRequest(entry, overrides = {}) {
  if (!entry || typeof entry !== "object") {
    const e = new Error("invalid history entry for replay");
    e.code = "BAD_ENTRY";
    throw e;
  }
  const prompt = overrides.prompt != null && String(overrides.prompt).trim() !== ""
    ? String(overrides.prompt)
    : overrides.twist && String(overrides.twist).trim() !== ""
      ? `${entry.prompt} ${String(overrides.twist).trim()}`.trim()
      : entry.prompt;
  if (!prompt || !String(prompt).trim()) {
    const e = new Error(`history entry ${entry.id} has no prompt to replay`);
    e.code = "BAD_ENTRY";
    throw e;
  }

  const seed = overrides.seed !== undefined
    ? normalizeSeed(overrides.seed)
    : normalizeSeed(entry.seed);

  const images = overrides.noImages
    ? []
    : Array.isArray(overrides.images) && overrides.images.length
      ? overrides.images
      : Array.isArray(entry.images)
        ? [...entry.images]
        : [];

  // On a succeeded generation (including fallback), replay targets the provider/model
  // that actually produced the image rather than a failed requestedProvider.
  const entryProvider = entry.ok
    ? entry.provider || entry.requestedProvider || undefined
    : entry.requestedProvider || entry.provider || undefined;
  const entryModel = entry.ok
    ? entry.model || entry.requestedModel || undefined
    : entry.requestedModel || entry.model || undefined;

  const provider = overrides.provider !== undefined
    ? overrides.provider || undefined
    : entryProvider;

  const model = overrides.model !== undefined
    ? overrides.model || undefined
    : overrides.provider && overrides.provider !== entryProvider
      ? undefined
      : entryModel;

  return {
    prompt,
    size: overrides.size !== undefined ? overrides.size : entry.size || undefined,
    quality: overrides.quality !== undefined ? overrides.quality : entry.quality || undefined,
    background: overrides.background !== undefined ? overrides.background : entry.background || undefined,
    seed: seed ?? undefined,
    images,
    provider,
    model,
    fallback: overrides.fallback === true,
    out: overrides.out || undefined,
    replayOf: entry.id,
    recipe: entry.recipe || null,
    look: entry.look || null,
    values: entry.values || null,
    twist: overrides.twist || entry.twist || null,
  };
}

function writeHistoryAtomic(filePath, entries) {
  ensureHistoryDir(filePath);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const body = entries.map((e) => JSON.stringify(redactValue(e))).join("\n") + (entries.length ? "\n" : "");
  writeFileSync(tmpPath, body, { encoding: "utf8", mode: 0o600 });
  renameSync(tmpPath, filePath);
  lockPermissions(filePath);
}

export function pruneHistory({ keep = null, beforeDays = null, dryRun = false, path = getHistoryPath(), now = Date.now() } = {}) {
  const { entries } = readHistory({ path });
  let kept = entries;
  if (beforeDays != null) {
    const days = Number(beforeDays);
    if (!Number.isFinite(days) || days < 0) {
      const e = new Error(`invalid beforeDays value: ${beforeDays}`);
      e.code = "BAD_ARGS";
      throw e;
    }
    const cutoff = now - days * 86_400_000;
    kept = kept.filter((entry) => {
      const t = Date.parse(entry.ts);
      return Number.isFinite(t) && t >= cutoff;
    });
  }
  if (keep != null) {
    const k = Number(keep);
    if (!Number.isInteger(k) || k < 0) {
      const e = new Error(`invalid keep value: ${keep} (expected non-negative integer)`);
      e.code = "BAD_ARGS";
      throw e;
    }
    if (kept.length > k) kept = kept.slice(kept.length - k);
  }
  const removed = entries.length - kept.length;
  if (!dryRun && removed > 0) {
    writeHistoryAtomic(path, kept);
  }
  return { before: entries.length, after: kept.length, removed, dryRun, path };
}

export function clearHistory({ path = getHistoryPath() } = {}) {
  const { entries } = readHistory({ path });
  if (existsSync(path)) {
    writeHistoryAtomic(path, []);
  }
  return { removed: entries.length, path };
}

// Nearest-rank percentile on a pre-sorted ascending numeric array.
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const idx = Math.max(0, Math.min(sorted.length - 1, rank));
  return sorted[idx];
}

function summarizeLatencies(values) {
  const nums = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (!nums.length) {
    return { avg: null, p50: null, p95: null, min: null, max: null, samples: 0 };
  }
  const sum = nums.reduce((acc, n) => acc + n, 0);
  return {
    avg: Math.round(sum / nums.length),
    p50: Math.round(percentile(nums, 50)),
    p95: Math.round(percentile(nums, 95)),
    min: Math.round(nums[0]),
    max: Math.round(nums[nums.length - 1]),
    samples: nums.length,
  };
}

export function computeStats(filters = {}, { path = getHistoryPath(), now = Date.now() } = {}) {
  const { entries: all, corruptLines } = readHistory({ path });
  const sinceMs = parseSince(filters.since, now);
  const untilMs = parseSince(filters.until, now);
  const entries = all.filter((e) => matchesFilters(e, filters, sinceMs, untilMs));

  let succeeded = 0;
  let failed = 0;
  let totalBytes = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let providerUsd = 0;
  let configuredUsd = 0;
  let estimatedUsd = 0;
  let subscriptionCount = 0;
  let unknownCostCount = 0;
  const totalDurations = [];

  const providerMap = new Map();
  const modelMap = new Map();
  const dailyMap = new Map();

  const getProviderBucket = (id) => {
    const key = id || "unknown";
    if (!providerMap.has(key)) {
      providerMap.set(key, {
        provider: key,
        generations: 0,
        succeeded: 0,
        failed: 0,
        attempts: 0,
        attemptOk: 0,
        attemptFailed: 0,
        skipped: 0,
        durations: [],
        spendUsd: 0,
        costSources: {},
        models: new Set(),
        errors: new Map(),
      });
    }
    return providerMap.get(key);
  };

  let firstTs = null;
  let lastTs = null;

  for (const e of entries) {
    if (e.ts) {
      if (!firstTs || e.ts < firstTs) firstTs = e.ts;
      if (!lastTs || e.ts > lastTs) lastTs = e.ts;
    }
    if (e.ok) succeeded++;
    else failed++;

    if (Number.isFinite(e.bytes) && e.bytes > 0) totalBytes += e.bytes;
    if (Number.isFinite(e.durationMs) && e.durationMs >= 0) totalDurations.push(e.durationMs);

    if (e.usage) {
      if (Number.isFinite(e.usage.promptTokens)) promptTokens += e.usage.promptTokens;
      if (Number.isFinite(e.usage.completionTokens)) completionTokens += e.usage.completionTokens;
      if (Number.isFinite(e.usage.totalTokens)) totalTokens += e.usage.totalTokens;
    }

    const costVal = Number.isFinite(e.costUsd) && e.costUsd >= 0 ? e.costUsd : null;
    if (e.ok) {
      if (e.costSource === "provider" && costVal != null) providerUsd += costVal;
      else if (e.costSource === "configured" && costVal != null) configuredUsd += costVal;
      else if (e.costSource === "estimated" && costVal != null) estimatedUsd += costVal;
      else if (e.costSource === "subscription") subscriptionCount++;
      else if (costVal == null) unknownCostCount++;
    }

    // Per-provider final generation accounting
    const finalProv = e.provider || (e.attempts?.findLast?.((a) => a.outcome !== "skipped")?.provider) || e.requestedProvider || "unknown";
    if (!filters.provider || finalProv === filters.provider) {
      const pb = getProviderBucket(finalProv);
      pb.generations++;
      if (e.ok) pb.succeeded++;
      else pb.failed++;
      if (e.model) pb.models.add(e.model);
      if (e.ok && costVal != null) pb.spendUsd += costVal;
      if (e.ok && e.costSource) pb.costSources[e.costSource] = (pb.costSources[e.costSource] || 0) + 1;
      // If attempts don't carry per-attempt durations (e.g. legacy/synthetic records), fall back to entry durationMs.
      const hasAttemptDurations = Array.isArray(e.attempts) && e.attempts.some((a) => a.provider === finalProv && Number.isFinite(a.durationMs));
      if (!hasAttemptDurations && Number.isFinite(e.durationMs) && e.durationMs >= 0) {
        pb.durations.push(e.durationMs);
      }
      if (!e.ok && (!Array.isArray(e.attempts) || e.attempts.length === 0)) {
        const errKey = e.errorCode || "FAILED";
        pb.errors.set(errKey, (pb.errors.get(errKey) || 0) + 1);
      }
    }

    // Per-attempt telemetry across every provider tried in fallback chains
    if (Array.isArray(e.attempts)) {
      for (const a of e.attempts) {
        if (!a.provider) continue;
        if (filters.provider && a.provider !== filters.provider) continue;
        const pb = getProviderBucket(a.provider);
        if (a.outcome === "skipped") {
          pb.skipped++;
          continue;
        }
        pb.attempts++;
        if (a.outcome === "ok") pb.attemptOk++;
        else {
          pb.attemptFailed++;
          const errKey = a.code || "FAILED";
          pb.errors.set(errKey, (pb.errors.get(errKey) || 0) + 1);
        }
        if (a.model) pb.models.add(a.model);
        if (Number.isFinite(a.durationMs) && a.durationMs >= 0) pb.durations.push(a.durationMs);
      }
    }

    // Per-model breakdown (for entries that have a model)
    if (e.model) {
      const mKey = `${finalProv}::${e.model}`;
      if (!modelMap.has(mKey)) {
        modelMap.set(mKey, {
          provider: finalProv,
          model: e.model,
          count: 0,
          succeeded: 0,
          failed: 0,
          durations: [],
          spendUsd: 0,
        });
      }
      const mb = modelMap.get(mKey);
      mb.count++;
      if (e.ok) mb.succeeded++;
      else mb.failed++;
      if (Number.isFinite(e.durationMs) && e.durationMs >= 0) mb.durations.push(e.durationMs);
      if (e.ok && costVal != null) mb.spendUsd += costVal;
    }

    // Daily trend
    const day = typeof e.ts === "string" && e.ts.length >= 10 ? e.ts.slice(0, 10) : "unknown";
    if (!dailyMap.has(day)) {
      dailyMap.set(day, { date: day, total: 0, succeeded: 0, failed: 0, durations: [], spendUsd: 0 });
    }
    const db = dailyMap.get(day);
    db.total++;
    if (e.ok) db.succeeded++;
    else db.failed++;
    if (Number.isFinite(e.durationMs) && e.durationMs >= 0) db.durations.push(e.durationMs);
    if (e.ok && costVal != null) db.spendUsd += costVal;
  }

  const total = entries.length;
  const totalUsd = roundUsd(providerUsd + configuredUsd + estimatedUsd);

  const providers = [...providerMap.values()]
    .map((pb) => {
      const topErrors = [...pb.errors.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([code, count]) => ({ code, count }));
      return {
        provider: pb.provider,
        generations: pb.generations,
        succeeded: pb.succeeded,
        failed: pb.failed,
        successRate: pb.generations ? roundRate(pb.succeeded / pb.generations) : null,
        attempts: pb.attempts,
        attemptOk: pb.attemptOk,
        attemptFailed: pb.attemptFailed,
        attemptSuccessRate: pb.attempts ? roundRate(pb.attemptOk / pb.attempts) : null,
        skipped: pb.skipped,
        latencyMs: summarizeLatencies(pb.durations),
        spendUsd: roundUsd(pb.spendUsd),
        costSources: pb.costSources,
        models: [...pb.models].sort(),
        topErrors,
      };
    })
    .sort((a, b) => (b.attempts || b.generations) - (a.attempts || a.generations) || a.provider.localeCompare(b.provider));

  const models = [...modelMap.values()]
    .map((mb) => {
      const lat = summarizeLatencies(mb.durations);
      return {
        provider: mb.provider,
        model: mb.model,
        count: mb.count,
        succeeded: mb.succeeded,
        failed: mb.failed,
        successRate: mb.count ? roundRate(mb.succeeded / mb.count) : null,
        avgLatencyMs: lat.avg,
        p95LatencyMs: lat.p95,
        spendUsd: roundUsd(mb.spendUsd),
      };
    })
    .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));

  const daily = [...dailyMap.values()]
    .map((db) => {
      const lat = summarizeLatencies(db.durations);
      return {
        date: db.date,
        total: db.total,
        succeeded: db.succeeded,
        failed: db.failed,
        successRate: db.total ? roundRate(db.succeeded / db.total) : null,
        avgLatencyMs: lat.avg,
        spendUsd: roundUsd(db.spendUsd),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    summary: {
      total,
      succeeded,
      failed,
      successRate: total ? roundRate(succeeded / total) : null,
      latencyMs: summarizeLatencies(totalDurations),
      spend: {
        totalUsd,
        providerUsd: roundUsd(providerUsd),
        configuredUsd: roundUsd(configuredUsd),
        estimatedUsd: roundUsd(estimatedUsd),
        subscriptionCount,
        unknownCostCount,
      },
      tokens: {
        prompt: promptTokens,
        completion: completionTokens,
        total: totalTokens,
      },
      bytes: totalBytes,
      window: { firstTs, lastTs },
    },
    providers,
    models,
    daily,
    corruptLines,
    path,
  };
}

function roundRate(r) {
  return Math.round(r * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Formatting helpers shared by CLI and MCP text output
// ---------------------------------------------------------------------------

export function formatDurationMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m${String(secs).padStart(2, "0")}s`;
}

export function formatUsd(usd, source = null) {
  if (source === "subscription") return "$0 (sub)";
  if (usd == null || !Number.isFinite(usd)) return "—";
  const prefix = source === "estimated" ? "~$" : "$";
  if (usd === 0) return `${prefix}0.00`;
  if (usd < 0.01) return `${prefix}${usd.toFixed(4)}`;
  return `${prefix}${usd.toFixed(2)}`;
}

export function formatPct(rate) {
  if (rate == null || !Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function sanitizeTerminalText(value) {
  if (value == null) return "";
  return String(value)
    // Strip OSC sequences (e.g. ESC ] ... BEL or ESC \)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // Strip CSI / ANSI escape sequences
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // Strip remaining 2-byte ESC sequences
    .replace(/\x1b[@-Z\\-_]/g, "")
    // Strip C0 and C1 control characters (preserving spaces, normalizing \r/\n/\t to space)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

export function renderHistoryList(result) {
  if (!result.entries.length) {
    return result.total === 0
      ? "No generation history yet. Generate an image with `brushrouter gen` or MCP `generate_image`."
      : `No history entries matched your filters (${result.total} total recorded).`;
  }
  const lines = [
    `Generation history (${result.entries.length} of ${result.matched} matched; ${result.total} total):`,
  ];
  for (const e of result.entries) {
    const status = e.ok ? "✓" : "✗";
    const ts = e.ts ? e.ts.replace("T", " ").slice(0, 19) : "unknown";
    const prov = sanitizeTerminalText(e.provider || e.requestedProvider || "—");
    const model = e.model ? `/${sanitizeTerminalText(e.model)}` : "";
    const dur = formatDurationMs(e.durationMs);
    const cost = e.ok ? formatUsd(e.costUsd, e.costSource) : sanitizeTerminalText(e.errorCode || "failed");
    const seed = e.seed != null ? ` seed=${e.seed}` : "";
    const cleanPrompt = sanitizeTerminalText(e.prompt || "");
    const snippet = cleanPrompt.slice(0, 64);
    const more = cleanPrompt.length > 64 ? "…" : "";
    lines.push(`${status} ${sanitizeTerminalText(e.id)}  ${ts}  ${prov}${model}  ${dur}  ${cost}${seed}`);
    lines.push(`    "${snippet}${more}"${e.out ? ` -> ${sanitizeTerminalText(e.out)}` : ""}`);
  }
  if (result.hasMore) {
    lines.push(`(showing ${result.offset + 1}-${result.offset + result.entries.length} of ${result.matched}; pass offset=${result.offset + result.entries.length} for more)`);
  }
  return lines.join("\n");
}

export function renderHistoryDetail(entry) {
  const lines = [
    `Generation ${entry.id} (${entry.ok ? "succeeded" : "failed"})`,
    `  time:       ${entry.ts || "—"}`,
    `  source:     ${entry.source || "—"}`,
    `  provider:   ${entry.provider || "—"}${entry.requestedProvider ? ` (requested: ${entry.requestedProvider})` : ""}`,
    `  model:      ${entry.model || "—"}${entry.requestedModel ? ` (requested: ${entry.requestedModel})` : ""}`,
    `  duration:   ${formatDurationMs(entry.durationMs)}`,
    `  cost:       ${formatUsd(entry.costUsd, entry.costSource)}${entry.costSource ? ` [${entry.costSource}]` : ""}`,
  ];
  if (entry.size || entry.actualSize) {
    lines.push(`  size:       ${entry.size || "auto"}${entry.actualSize ? ` (actual: ${entry.actualSize})` : ""}`);
  }
  if (entry.quality) lines.push(`  quality:    ${entry.quality}`);
  if (entry.background) lines.push(`  background: ${entry.background}`);
  if (entry.seed != null) lines.push(`  seed:       ${entry.seed}`);
  if (entry.recipe || entry.look) {
    lines.push(`  library:    ${[entry.recipe ? `recipe=${entry.recipe}` : null, entry.look ? `look=${entry.look}` : null].filter(Boolean).join(", ")}`);
  }
  if (entry.images?.length) {
    lines.push(`  images:     ${entry.images.join(", ")} (used: ${entry.imagesUsed ? "yes" : "no"})`);
  }
  if (entry.out) {
    const kb = entry.bytes != null ? ` (${Math.round(entry.bytes / 1024)} KB${entry.mime ? `, ${entry.mime}` : ""})` : "";
    lines.push(`  output:     ${entry.out}${kb}`);
  }
  if (entry.replayOf) lines.push(`  replay of:  ${entry.replayOf}`);
  if (entry.batchId) lines.push(`  batch:      ${entry.batchId}`);
  if (entry.usage) {
    lines.push(`  tokens:     prompt=${entry.usage.promptTokens ?? 0}, completion=${entry.usage.completionTokens ?? 0}, total=${entry.usage.totalTokens ?? 0}`);
  }
  if (entry.error) lines.push(`  error:      ${sanitizeTerminalText(entry.error)}${entry.errorCode ? ` [${sanitizeTerminalText(entry.errorCode)}]` : ""}`);
  lines.push(`  prompt:     ${sanitizeTerminalText(entry.prompt)}`);
  if (entry.attempts?.length) {
    lines.push("  attempts:");
    for (const a of entry.attempts) {
      const dur = a.durationMs != null ? ` (${formatDurationMs(a.durationMs)})` : "";
      const reason = a.reason ? ` — ${sanitizeTerminalText(a.reason)}` : "";
      lines.push(`    - ${sanitizeTerminalText(a.provider)}: ${sanitizeTerminalText(a.outcome)}${a.model ? ` [${sanitizeTerminalText(a.model)}]` : ""}${dur}${reason}`);
    }
  }
  lines.push(`  replay:     brushrouter replay ${entry.id}`);
  return lines.join("\n");
}

export function renderStats(stats) {
  const s = stats.summary;
  if (s.total === 0) {
    return "No generation stats yet. Generate an image with `brushrouter gen` or MCP `generate_image`.";
  }
  const lines = [
    `Usage & Performance Stats (${s.total} generation(s): ${s.succeeded} ok, ${s.failed} failed, ${formatPct(s.successRate)} success)`,
    `  Latency:  avg ${formatDurationMs(s.latencyMs.avg)} | p50 ${formatDurationMs(s.latencyMs.p50)} | p95 ${formatDurationMs(s.latencyMs.p95)} | min ${formatDurationMs(s.latencyMs.min)} | max ${formatDurationMs(s.latencyMs.max)}`,
    `  Spend:    ${formatUsd(s.spend.totalUsd)} total (reported: ${formatUsd(s.spend.providerUsd)}, configured: ${formatUsd(s.spend.configuredUsd)}, estimated: ${formatUsd(s.spend.estimatedUsd)})`,
  ];
  if (s.spend.subscriptionCount > 0 || s.spend.unknownCostCount > 0) {
    lines.push(`  Billing:  ${s.spend.subscriptionCount} subscription-backed, ${s.spend.unknownCostCount} unpriced`);
  }
  if (s.tokens.total > 0) {
    lines.push(`  Tokens:   ${s.tokens.total.toLocaleString("en-US")} total (${s.tokens.prompt.toLocaleString("en-US")} prompt, ${s.tokens.completion.toLocaleString("en-US")} completion)`);
  }
  if (s.window.firstTs && s.window.lastTs) {
    lines.push(`  Window:   ${s.window.firstTs.slice(0, 19).replace("T", " ")} -> ${s.window.lastTs.slice(0, 19).replace("T", " ")}`);
  }

  if (stats.providers.length) {
    lines.push("");
    lines.push("By provider:");
    for (const p of stats.providers) {
      const rate = p.attempts ? formatPct(p.attemptSuccessRate) : formatPct(p.successRate);
      const countLabel = p.attempts ? `${p.attemptOk}/${p.attempts} attempts` : `${p.succeeded}/${p.generations}`;
      lines.push(
        `  ${p.provider.padEnd(13)} ${countLabel.padEnd(16)} ${rate.padStart(6)}  avg ${formatDurationMs(p.latencyMs.avg).padStart(6)}  p95 ${formatDurationMs(p.latencyMs.p95).padStart(6)}  spend ${formatUsd(p.spendUsd)}`,
      );
      if (p.topErrors.length) {
        lines.push(`    errors: ${p.topErrors.map((e) => `${e.code}×${e.count}`).join(", ")}`);
      }
    }
  }

  if (stats.models.length) {
    lines.push("");
    lines.push("By model:");
    for (const m of stats.models.slice(0, 15)) {
      lines.push(
        `  ${(`${m.provider}/${m.model}`).padEnd(42)} ${String(m.count).padStart(4)}  ${formatPct(m.successRate).padStart(6)}  avg ${formatDurationMs(m.avgLatencyMs).padStart(6)}  spend ${formatUsd(m.spendUsd)}`,
      );
    }
  }

  if (stats.corruptLines > 0) {
    lines.push("");
    lines.push(`Note: skipped ${stats.corruptLines} corrupt line(s) in ${stats.path}`);
  }
  return lines.join("\n");
}
