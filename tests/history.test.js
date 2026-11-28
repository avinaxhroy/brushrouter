import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  recordHistory,
  tryRecordHistory,
  readHistory,
  listHistory,
  getHistoryEntry,
  buildReplayRequest,
  pruneHistory,
  clearHistory,
  computeStats,
  estimateCost,
  normalizeUsage,
  percentile,
  parseSince,
  isHistoryDisabled,
  renderHistoryList,
  renderHistoryDetail,
  renderStats,
} from "../src/history.js";
import { getHistoryPath, loadConfig } from "../src/config.js";
import { generate, PROVIDERS } from "../src/router.js";
import { httpImageGenerate } from "../src/providers/http.js";
import { registerSecret } from "../src/util/redact.js";
import {
  handleRequest,
  handleToolCall,
  HISTORY_TOOL_NAME,
  REPLAY_TOOL_NAME,
  STATS_TOOL_NAME,
  TOOL_NAME,
} from "../src/mcp.js";

const BIN = fileURLToPath(new URL("../bin/brushrouter.js", import.meta.url));
// Minimal valid 1x1 PNG bytes
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
    "0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

function makeTempDir(prefix = "br-hist-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, NO_COLOR: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("history: recordHistory writes 0700 dir + 0600 file, redacts secrets, and tolerates corrupt lines", () => {
  const dir = makeTempDir();
  const histPath = join(dir, "sub", "history.jsonl");
  const secretVal = "sk-or-v1-supersecretvalue1234567890abcdef";
  registerSecret(secretVal);

  try {
    const rec = recordHistory(
      {
        source: "cli",
        ok: true,
        prompt: `logo for Acme using key ${secretVal}`,
        provider: "openrouter",
        model: "google/gemini-3.1-flash-image",
        size: "1024x1024",
        seed: 42,
        out: join(dir, "logo.png"),
        bytes: 12345,
        durationMs: 2400,
        attempts: [{ provider: "openrouter", outcome: "ok", durationMs: 2400 }],
      },
      { path: histPath },
    );

    assert.ok(rec.id.startsWith("gen_"));
    assert.equal(rec.seed, 42);
    assert.equal(rec.costSource, "estimated");
    assert.ok(rec.costUsd > 0);
    assert.ok(!rec.prompt.includes(secretVal), "secret leaked into returned record");

    const raw = readFileSync(histPath, "utf8");
    assert.ok(!raw.includes(secretVal), "secret leaked into history.jsonl");
    if (process.platform !== "win32") {
      assert.equal(statSync(join(dir, "sub")).mode & 0o777, 0o700);
      assert.equal(statSync(histPath).mode & 0o777, 0o600);
    }

    // Append a corrupt line and verify readHistory skips it and counts it
    writeFileSync(histPath, raw + "{not-valid-json\n", "utf8");
    const { entries, corruptLines } = readHistory({ path: histPath });
    assert.equal(entries.length, 1);
    assert.equal(corruptLines, 1);
    assert.equal(entries[0].id, rec.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("history: isHistoryDisabled respects env vars and config", () => {
  const prevNo = process.env.BRUSHROUTER_NO_HISTORY;
  const prevHist = process.env.BRUSHROUTER_HISTORY;
  try {
    delete process.env.BRUSHROUTER_NO_HISTORY;
    delete process.env.BRUSHROUTER_HISTORY;
    assert.equal(isHistoryDisabled({ history: { enabled: true } }), false);
    assert.equal(isHistoryDisabled({ history: { enabled: false } }), true);

    process.env.BRUSHROUTER_NO_HISTORY = "1";
    assert.equal(isHistoryDisabled({ history: { enabled: true } }), true);
    delete process.env.BRUSHROUTER_NO_HISTORY;

    process.env.BRUSHROUTER_HISTORY = "0";
    assert.equal(isHistoryDisabled({ history: { enabled: true } }), true);
    process.env.BRUSHROUTER_HISTORY = "true";
    assert.equal(isHistoryDisabled({ history: { enabled: true } }), false);
  } finally {
    if (prevNo === undefined) delete process.env.BRUSHROUTER_NO_HISTORY;
    else process.env.BRUSHROUTER_NO_HISTORY = prevNo;
    if (prevHist === undefined) delete process.env.BRUSHROUTER_HISTORY;
    else process.env.BRUSHROUTER_HISTORY = prevHist;
  }
});

test("history: listHistory filtering, pagination, pruneHistory, and clearHistory", () => {
  const dir = makeTempDir();
  const histPath = join(dir, "history.jsonl");
  const now = Date.UTC(2026, 5, 15, 12, 0, 0);

  try {
    const entries = [
      { id: "gen_a1", ts: new Date(now - 10 * 86400_000).toISOString(), source: "cli", ok: true, prompt: "red fox in snow", provider: "codex", model: "gpt-image-1", durationMs: 1200 },
      { id: "gen_b2", ts: new Date(now - 2 * 86400_000).toISOString(), source: "mcp", ok: false, prompt: "blue whale", provider: "openrouter", model: "openai/gpt-image-1", durationMs: 500, error: "rate limit", errorCode: "RATE_LIMIT" },
      { id: "gen_c3", ts: new Date(now - 3600_000).toISOString(), source: "cli", ok: true, prompt: "red fox wearing glasses", provider: "fal", model: "fal-ai/flux/schnell", seed: 77, durationMs: 800 },
    ];
    for (const e of entries) recordHistory(e, { path: histPath });

    // Newest first
    const all = listHistory({}, { path: histPath, now });
    assert.equal(all.total, 3);
    assert.deepEqual(all.entries.map((e) => e.id), ["gen_c3", "gen_b2", "gen_a1"]);

    // Filters
    assert.equal(listHistory({ provider: "fal" }, { path: histPath, now }).matched, 1);
    assert.equal(listHistory({ status: "failed" }, { path: histPath, now }).matched, 1);
    assert.equal(listHistory({ source: "mcp" }, { path: histPath, now }).matched, 1);
    assert.equal(listHistory({ query: "red fox" }, { path: histPath, now }).matched, 2);
    assert.equal(listHistory({ since: "3d" }, { path: histPath, now }).matched, 2);

    // Pagination
    const page1 = listHistory({ limit: 2, offset: 0 }, { path: histPath, now });
    assert.equal(page1.entries.length, 2);
    assert.equal(page1.hasMore, true);
    const page2 = listHistory({ limit: 2, offset: 2 }, { path: histPath, now });
    assert.equal(page2.entries.length, 1);
    assert.equal(page2.hasMore, false);

    // Prune dry-run does not modify
    const dry = pruneHistory({ keep: 2, dryRun: true, path: histPath, now });
    assert.equal(dry.removed, 1);
    assert.equal(readHistory({ path: histPath }).entries.length, 3);

    // Prune by beforeDays
    const pruned = pruneHistory({ beforeDays: 5, path: histPath, now });
    assert.equal(pruned.removed, 1);
    assert.equal(pruned.after, 2);
    assert.deepEqual(readHistory({ path: histPath }).entries.map((e) => e.id), ["gen_b2", "gen_c3"]);

    // Clear
    const cleared = clearHistory({ path: histPath });
    assert.equal(cleared.removed, 2);
    assert.equal(readHistory({ path: histPath }).entries.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("history: getHistoryEntry selectors (exact, prefix, last, ~N, file path) and buildReplayRequest", () => {
  const dir = makeTempDir();
  const histPath = join(dir, "history.jsonl");
  const out1 = join(dir, "first.png");
  const out2 = join(dir, "second.png");

  try {
    recordHistory(
      {
        id: "gen_abc111",
        ts: "2026-06-01T10:00:00.000Z",
        source: "cli",
        ok: true,
        prompt: "isometric coffee shop",
        provider: "fal",
        model: "fal-ai/flux/schnell",
        size: "1024x1024",
        seed: 12345,
        images: [join(dir, "ref.png")],
        out: out1,
      },
      { path: histPath },
    );
    recordHistory(
      {
        id: "gen_abc222",
        ts: "2026-06-01T11:00:00.000Z",
        source: "cli",
        ok: true,
        prompt: "minimalist mountain logo",
        provider: "openrouter",
        model: "openai/gpt-image-1",
        size: "1536x1024",
        seed: 999,
        out: out2,
      },
      { path: histPath },
    );

    assert.equal(getHistoryEntry("last", { path: histPath }).id, "gen_abc222");
    assert.equal(getHistoryEntry("~1", { path: histPath }).id, "gen_abc222");
    assert.equal(getHistoryEntry("~2", { path: histPath }).id, "gen_abc111");
    assert.equal(getHistoryEntry("gen_abc1", { path: histPath }).id, "gen_abc111");
    assert.equal(getHistoryEntry(out1, { path: histPath, cwd: dir }).id, "gen_abc111");

    // Ambiguous prefix throws
    assert.throws(() => getHistoryEntry("gen_abc", { path: histPath }), /ambiguous/i);
    // Out of range throws
    assert.throws(() => getHistoryEntry("~9", { path: histPath }), /out of range/i);

    const base = getHistoryEntry("gen_abc111", { path: histPath });
    const exactReplay = buildReplayRequest(base);
    assert.equal(exactReplay.prompt, "isometric coffee shop");
    assert.equal(exactReplay.seed, 12345);
    assert.equal(exactReplay.provider, "fal");
    assert.equal(exactReplay.model, "fal-ai/flux/schnell");
    assert.equal(exactReplay.replayOf, "gen_abc111");
    assert.equal(exactReplay.images.length, 1);

    const overridden = buildReplayRequest(base, {
      provider: "openrouter",
      seed: 555,
      twist: "at sunset",
      noImages: true,
    });
    assert.equal(overridden.provider, "openrouter");
    assert.equal(overridden.model, undefined, "switching provider drops incompatible model unless explicitly overridden");
    assert.equal(overridden.seed, 555);
    assert.equal(overridden.prompt, "isometric coffee shop at sunset");
    assert.deepEqual(overridden.images, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cost & stats: estimateCost precedence, percentile math, and computeStats aggregation", () => {
  // Cost precedence: provider-reported > configured > subscription > estimated > unknown
  assert.deepEqual(estimateCost({ provider: "openrouter", model: "openai/gpt-image-1", costUsd: 0.042 }), {
    costUsd: 0.042,
    costSource: "provider",
  });
  assert.deepEqual(
    estimateCost({ provider: "openrouter", model: "custom/model", pricing: { "openrouter/custom/model": 0.12 } }),
    { costUsd: 0.12, costSource: "configured" },
  );
  assert.deepEqual(estimateCost({ provider: "codex-cli", model: "gpt-image-1" }), {
    costUsd: 0,
    costSource: "subscription",
  });
  const est = estimateCost({ provider: "fal", model: "fal-ai/flux/schnell" });
  assert.equal(est.costSource, "estimated");
  assert.ok(est.costUsd > 0);
  assert.deepEqual(estimateCost({ provider: "custom-http", model: "unknown-x" }), {
    costUsd: null,
    costSource: "unknown",
  });

  // normalizeUsage
  assert.deepEqual(normalizeUsage({ prompt_tokens: 100, completion_tokens: 50 }), {
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
  });

  // Percentiles
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([42], 95), 42);
  assert.equal(percentile([100, 200, 300, 400, 500], 50), 300);
  assert.equal(percentile([100, 200, 300, 400, 500], 95), 500);

  // Full stats aggregation
  const dir = makeTempDir();
  const histPath = join(dir, "history.jsonl");
  try {
    recordHistory(
      {
        ts: "2026-06-10T10:00:00.000Z",
        source: "cli",
        ok: true,
        prompt: "p1",
        provider: "openrouter",
        model: "google/gemini-3.1-flash-image",
        durationMs: 1000,
        bytes: 5000,
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        costUsd: 0.04,
        attempts: [
          { provider: "codex", outcome: "error", code: "RATE_LIMIT", durationMs: 200 },
          { provider: "openrouter", outcome: "ok", durationMs: 800 },
        ],
      },
      { path: histPath },
    );
    recordHistory(
      {
        ts: "2026-06-10T11:00:00.000Z",
        source: "mcp",
        ok: true,
        prompt: "p2",
        provider: "codex",
        model: "gpt-image-1",
        durationMs: 3000,
        bytes: 8000,
        attempts: [{ provider: "codex", outcome: "ok", durationMs: 3000 }],
      },
      { path: histPath },
    );
    recordHistory(
      {
        ts: "2026-06-11T09:00:00.000Z",
        source: "cli",
        ok: false,
        prompt: "p3",
        provider: "fal",
        model: "fal-ai/flux/schnell",
        durationMs: 400,
        error: "timeout",
        errorCode: "TIMEOUT",
        attempts: [{ provider: "fal", outcome: "error", code: "TIMEOUT", durationMs: 400 }],
      },
      { path: histPath },
    );

    const stats = computeStats({}, { path: histPath });
    assert.equal(stats.summary.total, 3);
    assert.equal(stats.summary.succeeded, 2);
    assert.equal(stats.summary.failed, 1);
    assert.ok(Math.abs(stats.summary.successRate - 2 / 3) < 0.002);
    assert.equal(stats.summary.latencyMs.min, 400);
    assert.equal(stats.summary.latencyMs.max, 3000);
    assert.equal(stats.summary.latencyMs.p50, 1000);
    assert.equal(stats.summary.spend.providerUsd, 0.04);
    assert.equal(stats.summary.spend.subscriptionCount, 1);
    assert.equal(stats.summary.tokens.total, 30);
    assert.equal(stats.summary.bytes, 13000);
    assert.equal(stats.daily.length, 2);

    const codexRow = stats.providers.find((p) => p.provider === "codex");
    assert.equal(codexRow.attempts, 2);
    assert.equal(codexRow.attemptOk, 1);
    assert.equal(codexRow.attemptFailed, 1);
    assert.equal(codexRow.attemptSuccessRate, 0.5);
    assert.equal(codexRow.topErrors[0].code, "RATE_LIMIT");

    const renderedStats = renderStats(stats, { color: false });
    assert.match(renderedStats, /Usage & Performance Stats/i);
    assert.match(renderedStats, /By provider/i);
    assert.match(renderedStats, /openrouter/);

    const listText = renderHistoryList(listHistory({}, { path: histPath }), { color: false });
    assert.match(listText, /History/i);
    const detailText = renderHistoryDetail(getHistoryEntry("last", { path: histPath }), { color: false });
    assert.match(detailText, /brushrouter replay/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("router & http: generate records durationMs, attempts latency, seed, and optional history", async () => {
  const dir = makeTempDir();
  const histPath = join(dir, "history.jsonl");
  const prevHistPath = process.env.BRUSHROUTER_HISTORY_PATH;
  process.env.BRUSHROUTER_HISTORY_PATH = histPath;

  const mockProvider = {
    id: "__mock_obs",
    label: "Mock Obs",
    kind: "api",
    async probe() {
      return { ok: true, detail: "mock" };
    },
    async generate({ prompt, seed }) {
      return {
        buffer: TINY_PNG,
        meta: {
          model: "mock-v1",
          seed,
          usage: { prompt_tokens: 12, completion_tokens: 8 },
          costUsd: 0.015,
        },
      };
    },
  };
  PROVIDERS.__mock_obs = mockProvider;

  try {
    const cfg = loadConfig({ cwd: dir });
    const res = await generate(
      {
        prompt: "geometric crane",
        provider: "__mock_obs",
        seed: 777,
        out: join(dir, "crane.png"),
        cwd: dir,
        history: { source: "api" },
      },
      cfg,
    );

    assert.equal(res.provider, "__mock_obs");
    assert.equal(res.meta.seed, 777);
    assert.equal(typeof res.durationMs, "number");
    assert.equal(typeof res.attempts[0].durationMs, "number");
    assert.ok(res.historyId?.startsWith("gen_"));

    const { entries } = readHistory({ path: histPath });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].seed, 777);
    assert.equal(entries[0].costUsd, 0.015);
    assert.equal(entries[0].costSource, "provider");
    assert.equal(entries[0].usage.totalTokens, 20);
  } finally {
    delete PROVIDERS.__mock_obs;
    if (prevHistPath === undefined) delete process.env.BRUSHROUTER_HISTORY_PATH;
    else process.env.BRUSHROUTER_HISTORY_PATH = prevHistPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("httpImageGenerate forwards seed and extracts usage + costUsd from JSON response", async () => {
  const prevFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    const payload = {
      images: [{ url: `data:image/png;base64,${TINY_PNG.toString("base64")}` }],
      seed: 31415,
      usage: { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20, cost: 0.008 },
    };
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      async json() {
        return payload;
      },
      async text() {
        return JSON.stringify(payload);
      },
    };
  };

  try {
    const res = await httpImageGenerate(
      { prompt: "neon owl", seed: 31415 },
      { apiKey: "fal-test-key" },
      {
        name: "fal",
        url: "https://fal.run/fal-ai/flux/schnell",
        headers: {},
        buildBody: ({ prompt, seed }) => ({ prompt, ...(seed != null ? { seed } : {}) }),
        responsePath: "images.0.url",
      },
    );
    assert.equal(capturedBody.seed, 31415);
    assert.equal(res.meta.seed, 31415);
    assert.equal(res.meta.costUsd, 0.008);
    assert.equal(res.meta.usage.total_tokens, 20);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("CLI: history, replay --dry-run, stats, and --seed validation", async () => {
  const dir = makeTempDir();
  const histPath = join(dir, "history.jsonl");
  const env = { BRUSHROUTER_HISTORY_PATH: histPath, BRUSHROUTER_CONFIG_DIR: dir };

  try {
    recordHistory(
      {
        id: "gen_cli1",
        ts: "2026-06-12T10:00:00.000Z",
        source: "cli",
        ok: true,
        prompt: "vintage travel poster",
        provider: "codex",
        model: "gpt-image-1",
        size: "1024x1536",
        seed: 2026,
        durationMs: 2500,
        out: join(dir, "poster.png"),
      },
      { path: histPath },
    );
    recordHistory(
      {
        id: "gen_cli2",
        ts: "2026-06-12T11:00:00.000Z",
        source: "cli",
        ok: false,
        prompt: "broken test",
        provider: "openrouter",
        model: "openai/gpt-image-1",
        durationMs: 300,
        error: "quota exceeded",
        errorCode: "RATE_LIMIT",
      },
      { path: histPath },
    );

    const histJson = await runCli(["history", "--json"], env);
    assert.equal(histJson.code, 0, histJson.stderr);
    const histData = JSON.parse(histJson.stdout);
    assert.equal(histData.total, 2);

    const showJson = await runCli(["history", "show", "gen_cli1", "--json"], env);
    assert.equal(showJson.code, 0, showJson.stderr);
    assert.equal(JSON.parse(showJson.stdout).seed, 2026);

    const statsJson = await runCli(["stats", "--json"], env);
    assert.equal(statsJson.code, 0, statsJson.stderr);
    const statsData = JSON.parse(statsJson.stdout);
    assert.equal(statsData.summary.total, 2);
    assert.equal(statsData.summary.succeeded, 1);
    assert.equal(statsData.summary.failed, 1);

    const replayDry = await runCli(["replay", "gen_cli1", "--dry-run", "--twist", "in rain", "--json"], env);
    assert.equal(replayDry.code, 0, replayDry.stderr);
    const replayData = JSON.parse(replayDry.stdout);
    assert.equal(replayData.dryRun, true);
    assert.equal(replayData.replayOf, "gen_cli1");
    assert.equal(replayData.seed, 2026);
    assert.equal(replayData.prompt, "vintage travel poster in rain");

    const badSeed = await runCli(["gen", "cat", "--seed", "abc"], env);
    assert.equal(badSeed.code, 2);
    assert.match(badSeed.stderr, /--seed expects an integer/);

    const clearNoYes = await runCli(["history", "clear"], env);
    assert.equal(clearNoYes.code, 2);

    const clearYes = await runCli(["history", "clear", "--yes", "--json"], env);
    assert.equal(clearYes.code, 0, clearYes.stderr);
    assert.equal(JSON.parse(clearYes.stdout).removed, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("history detail strips terminal control characters from recorded paths", () => {
  const path = (name) => `fixtures/\x1b[32m${name}\x1b[0m.png`;
  const detail = renderHistoryDetail({
    id: "test",
    ok: true,
    images: [path("base")],
    mask: path("mask"),
    out: path("output"),
  });
  assert.doesNotMatch(detail, /\x1b/);
  for (const name of ["base", "mask", "output"]) assert.ok(detail.includes(`fixtures/${name}.png`));
});

test("masked history replays the original mask across working directories", async (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const historyPath = join(dir, "history.jsonl");
  const previous = process.env.BRUSHROUTER_HISTORY_PATH;
  process.env.BRUSHROUTER_HISTORY_PATH = historyPath;
  t.after(() => {
    if (previous === undefined) delete process.env.BRUSHROUTER_HISTORY_PATH;
    else process.env.BRUSHROUTER_HISTORY_PATH = previous;
  });
  const maskPath = join(dir, "mask.png");
  const basePath = join(dir, "base.png");
  for (const file of [basePath, maskPath]) writeFileSync(file, TINY_PNG);
  const seen = [];
  t.mock.method(PROVIDERS.fal, "generate", async ({ images, mask }) => {
    seen.push({ images, mask });
    return { buffer: TINY_PNG, meta: { model: "fixture" } };
  });
  await handleToolCall(TOOL_NAME, {
    prompt: "edit", provider: "fal", images: ["base.png"], mask: "mask.png", out: "original.png",
  }, { cwd: dir });
  const entry = getHistoryEntry("last");
  assert.equal(entry.mask, maskPath);
  assert.deepEqual(entry.images, [basePath]);
  const dry = await runCli(["replay", entry.id, "--dry-run", "--json"], { BRUSHROUTER_HISTORY_PATH: historyPath });
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).mask, maskPath);
  await handleToolCall(REPLAY_TOOL_NAME, { id: entry.id, out: join(dir, "replayed.png") }, { cwd: tmpdir() });
  assert.deepEqual(seen.at(-1), { images: [basePath], mask: maskPath });

  rmSync(maskPath);
  const missing = await runCli(["replay", entry.id, "--dry-run"], { BRUSHROUTER_HISTORY_PATH: historyPath });
  assert.equal(missing.code, 2, missing.stderr);
  assert.match(missing.stderr, /mask.*unavailable/i);
  await assert.rejects(() => handleToolCall(REPLAY_TOOL_NAME, { id: entry.id }, { cwd: dir }), /mask.*unavailable/i);
  assert.equal(seen.length, 2);
  assert.equal(buildReplayRequest(entry, { noImages: true }).mask, undefined);
});

test("MCP batch records successful masked items in history", async (t) => {
  const cwd = makeTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, "history.jsonl");
  const previous = process.env.BRUSHROUTER_HISTORY_PATH;
  process.env.BRUSHROUTER_HISTORY_PATH = path;
  t.after(() => {
    if (previous === undefined) delete process.env.BRUSHROUTER_HISTORY_PATH;
    else process.env.BRUSHROUTER_HISTORY_PATH = previous;
  });
  t.mock.method(PROVIDERS.fal, "generate", async () => ({ buffer: TINY_PNG, meta: { model: "fixture" } }));
  const result = await handleToolCall("batch_generate_images", {
    provider: "fal",
    items: [{ prompt: "masked edit", images: ["base.png"], mask: "mask.png" }],
  }, { cwd });
  assert.equal(result.isError, false, result.content[0].text);
  const { entries } = readHistory({ path });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].ok, true);
  assert.equal(entries[0].source, "mcp");
  assert.equal(entries[0].mask, join(cwd, "mask.png"));
  assert.deepEqual(entries[0].images, [join(cwd, "base.png")]);
});

test("MCP: generation_history, usage_stats, replay_generation, and history/stats resources", async () => {
  const dir = makeTempDir();
  const histPath = join(dir, "history.jsonl");
  const prevHistPath = process.env.BRUSHROUTER_HISTORY_PATH;
  process.env.BRUSHROUTER_HISTORY_PATH = histPath;

  let lastSeenPrompt = null;
  let lastSeenSeed = null;
  PROVIDERS.__mock_mcp = {
    id: "__mock_mcp",
    label: "Mock MCP",
    kind: "api",
    async probe() {
      return { ok: true, detail: "mock" };
    },
    async generate({ prompt, seed }) {
      lastSeenPrompt = prompt;
      lastSeenSeed = seed;
      return { buffer: TINY_PNG, meta: { model: "mock-mcp-1", seed } };
    },
  };

  try {
    // 1. generate_image records history with seed
    const genRes = await handleToolCall(
      TOOL_NAME,
      { prompt: "origami fox", provider: "__mock_mcp", seed: 88, out: join(dir, "origami.png") },
      { cwd: dir },
    );
    assert.equal(genRes.isError, false);
    assert.match(genRes.content[0].text, /id: gen_/);
    assert.equal(lastSeenSeed, 88);

    // 2. generation_history lists it
    const histRes = await handleToolCall(HISTORY_TOOL_NAME, { format: "json" }, { cwd: dir });
    const histJson = JSON.parse(histRes.content[0].text);
    assert.equal(histJson.total, 1);
    const origId = histJson.entries[0].id;
    assert.equal(histJson.entries[0].seed, 88);

    // 3. replay_generation replays with seed preserved and twist applied
    const replayRes = await handleToolCall(
      REPLAY_TOOL_NAME,
      { id: origId, twist: "gold foil paper", out: join(dir, "origami-replay.png") },
      { cwd: dir },
    );
    assert.equal(replayRes.isError, false);
    assert.equal(lastSeenPrompt, "origami fox gold foil paper");
    assert.equal(lastSeenSeed, 88);

    const histAfter = JSON.parse((await handleToolCall(HISTORY_TOOL_NAME, { format: "json" }, { cwd: dir })).content[0].text);
    assert.equal(histAfter.total, 2);
    assert.equal(histAfter.entries[0].source, "replay");
    assert.equal(histAfter.entries[0].replayOf, origId);

    // 4. usage_stats tool
    const statsRes = await handleToolCall(STATS_TOOL_NAME, { format: "json" }, { cwd: dir });
    const statsJson = JSON.parse(statsRes.content[0].text);
    assert.equal(statsJson.summary.total, 2);
    assert.equal(statsJson.summary.succeeded, 2);

    // 5. MCP resources brushrouter://history and brushrouter://stats
    const resList = await handleRequest({ jsonrpc: "2.0", id: 10, method: "resources/list" }, { cwd: dir });
    const uris = resList.result.resources.map((r) => r.uri);
    assert.ok(uris.includes("brushrouter://history"));
    assert.ok(uris.includes("brushrouter://stats"));

    const histResource = await handleRequest(
      { jsonrpc: "2.0", id: 11, method: "resources/read", params: { uri: "brushrouter://history" } },
      { cwd: dir },
    );
    assert.equal(JSON.parse(histResource.result.contents[0].text).total, 2);

    const statsResource = await handleRequest(
      { jsonrpc: "2.0", id: 12, method: "resources/read", params: { uri: "brushrouter://stats" } },
      { cwd: dir },
    );
    assert.equal(JSON.parse(statsResource.result.contents[0].text).summary.total, 2);

    // 6. Invalid seed rejected
    await assert.rejects(
      () => handleToolCall(TOOL_NAME, { prompt: "cat", seed: 1.5 }, { cwd: dir }),
      /seed must be an integer/,
    );
  } finally {
    delete PROVIDERS.__mock_mcp;
    if (prevHistPath === undefined) delete process.env.BRUSHROUTER_HISTORY_PATH;
    else process.env.BRUSHROUTER_HISTORY_PATH = prevHistPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseSince parses relative durations and ISO dates, rejecting garbage", () => {
  const now = Date.UTC(2026, 5, 15, 12, 0, 0);
  assert.equal(parseSince("24h", now), now - 24 * 3600_000);
  assert.equal(parseSince("7d", now), now - 7 * 86400_000);
  assert.equal(parseSince("2w", now), now - 14 * 86400_000);
  assert.equal(parseSince("2026-06-01T00:00:00Z", now), Date.UTC(2026, 5, 1, 0, 0, 0));
  assert.throws(() => parseSince("not-a-date", now), /invalid --since/);
});

test("review fixes: terminal sanitization, configured pricing on subscription, fallback replay, relative images, provider-filtered stats, and omitted {seed} template", async () => {
  const dir = mkdtempSync(join(tmpdir(), "br-rev-"));
  const histPath = join(dir, "history.jsonl");
  try {
    // 1. Terminal escape sequences are stripped in list & detail rendering
    const dirty = recordHistory(
      {
        ok: false,
        prompt: "hello \x1b]0;pwned\x07\x1b[31mworld\x1b[0m",
        provider: "fal",
        error: "boom \x1b[2J\x1b[H\r\nfake",
        attempts: [{ provider: "fal", outcome: "failed", reason: "err \x1b[31mred\x1b[0m" }],
      },
      { path: histPath },
    );
    const listText = renderHistoryList(listHistory({ path: histPath }));
    const detailText = renderHistoryDetail(dirty);
    assert.ok(!listText.includes("\x1b"), "list output should not contain ESC");
    assert.ok(!detailText.includes("\x1b"), "detail output should not contain ESC");
    assert.ok(detailText.includes("hello world"));

    // 2. Configured pricing overrides subscription $0 default
    const subConfigured = estimateCost({ provider: "codex", pricing: { codex: 0.02 } });
    assert.equal(subConfigured.costUsd, 0.02);
    assert.equal(subConfigured.costSource, "configured");

    // 3. Fallback replay targets the winning provider/model, not the failed requested one
    const fbEntry = recordHistory(
      {
        ok: true,
        prompt: "mountain sunrise",
        provider: "openrouter",
        requestedProvider: "codex",
        model: "google/gemini-3.1-flash-image",
        requestedModel: "gpt-image-1",
        costUsd: 0.039,
        attempts: [
          { provider: "codex", outcome: "failed", code: "RATE_LIMIT", durationMs: 200 },
          { provider: "openrouter", outcome: "ok", model: "google/gemini-3.1-flash-image", durationMs: 900 },
        ],
      },
      { path: histPath },
    );
    const replayReq = buildReplayRequest(fbEntry);
    assert.equal(replayReq.provider, "openrouter");
    assert.equal(replayReq.model, "google/gemini-3.1-flash-image");

    // 4. Relative reference image paths are resolved against cwd when recorded
    const projCwd = join(dir, "proj");
    const absImg = join(dir, "abs", "b.png");
    const imgRec = recordHistory(
      { ok: true, prompt: "edit ref", provider: "fal", images: ["refs/a.png", absImg] },
      { path: histPath, cwd: projCwd },
    );
    assert.deepEqual(imgRec.images, [resolve(projCwd, "refs/a.png"), absImg]);

    // 5. Provider-filtered stats do not count another provider's spend/results
    const codexStats = computeStats({ provider: "codex" }, { path: histPath });
    assert.equal(codexStats.summary.total, 0);
    assert.equal(codexStats.summary.spend.totalUsd, 0);
    assert.equal(codexStats.providers.length, 1);
    assert.equal(codexStats.providers[0].provider, "codex");
    assert.equal(codexStats.providers[0].attempts, 1);
    assert.equal(codexStats.providers[0].attemptFailed, 1);

    // 6. Custom HTTP unquoted {seed} placeholder serializes as JSON null when omitted
    const prevFetch = globalThis.fetch;
    let rawBody = null;
    globalThis.fetch = async (_url, opts) => {
      rawBody = opts.body;
      const payload = { images: [{ url: `data:image/png;base64,${TINY_PNG.toString("base64")}` }] };
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        async json() { return payload; },
        async text() { return JSON.stringify(payload); },
      };
    };
    try {
      await httpImageGenerate(
        { prompt: "seedless cat" },
        { apiKey: "test-key" },
        {
          name: "custom",
          url: "https://example.com/gen",
          headers: {},
          body: '{"prompt":"{prompt}","seed":{seed}}',
          responsePath: "images.0.url",
        },
      );
      assert.deepEqual(JSON.parse(rawBody), { prompt: "seedless cat", seed: null });
    } finally {
      globalThis.fetch = prevFetch;
    }

    // 7. CLI batch validates --seed
    const badBatchSeed = spawnSync(
      process.execPath,
      [BIN, "batch", "a fox", "a bird", "--seed", "nope", "--dry-run"],
      { encoding: "utf8", env: { ...process.env, BRUSHROUTER_HISTORY_PATH: histPath } },
    );
    assert.equal(badBatchSeed.status, 2);
    assert.match(badBatchSeed.stderr, /--seed expects an integer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
