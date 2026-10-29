import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { detectImageMime, extForMime, freePath, saveImage, decodeJwt, jwtClientId, jwtExpiryMs, normalizeSize, appendTailed, readImageAsDataUrl, readBodyCapped, pngSize, MAX_REF_IMAGE_BYTES } from "../src/util/common.js";
import { resolvePath } from "../src/providers/http.js";
import { appendSizeHint } from "../src/providers/codex.js";
import { loadConfig, DEFAULT_CONFIG, providerConfig } from "../src/config.js";
import { listProviderIds, PROVIDERS, planAttemptOrder } from "../src/router.js";

process.env.BRUSHROUTER_CONFIG_DIR = mkdtempSync(join(tmpdir(), "br-unit-config-"));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);

test("detectImageMime recognizes png and jpeg", () => {
  assert.equal(detectImageMime(PNG), "image/png");
  assert.equal(detectImageMime(JPEG), "image/jpeg");
  assert.equal(detectImageMime(Buffer.from("nope")), null);
});

test("extForMime maps known types", () => {
  assert.equal(extForMime("image/png"), ".png");
  assert.equal(extForMime("image/jpeg"), ".jpg");
  assert.equal(extForMime("image/webp"), ".webp");
  assert.equal(extForMime("application/octet-stream"), ".png");
});

test("freePath never overwrites an existing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "br-test-"));
  try {
    const p = join(dir, "out.png");
    assert.equal(freePath(p), p);
    writeFileSync(p, "x");
    assert.equal(freePath(p), join(dir, "out-v2.png"));
    writeFileSync(join(dir, "out-v2.png"), "x");
    assert.equal(freePath(p), join(dir, "out-v3.png"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveImage writes bytes and reports versioning", () => {
  const dir = mkdtempSync(join(tmpdir(), "br-test-"));
  try {
    const r1 = saveImage("a.png", PNG, dir);
    assert.equal(r1.versioned, false);
    assert.ok(existsSync(r1.savedPath));
    const r2 = saveImage("a.png", PNG, dir);
    assert.equal(r2.versioned, true);
    assert.match(r2.savedPath, /a-v2\.png$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decodeJwt / jwtExpiryMs / jwtClientId read claims", () => {
  const payload = { exp: 2000000000, aud: ["app_EXAMPLE123", "other"] };
  const jwt = `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
  assert.equal(decodeJwt(jwt).exp, 2000000000);
  assert.equal(jwtExpiryMs(jwt), 2000000000 * 1000);
  assert.equal(jwtClientId(jwt), "app_EXAMPLE123");
  assert.equal(decodeJwt("garbage"), null);
});

test("jwtClientId falls back to client_id claim", () => {
  const jwt = `x.${Buffer.from(JSON.stringify({ client_id: "app_ABC123" })).toString("base64url")}.y`;
  assert.equal(jwtClientId(jwt), "app_ABC123");
});

test("resolvePath walks dotted paths with array indexes", () => {
  const obj = { choices: [{ message: { images: [{ image_url: { url: "http://x/1.png" } }] } }] };
  assert.equal(resolvePath(obj, "choices.0.message.images.0.image_url.url"), "http://x/1.png");
  assert.equal(resolvePath(obj, "choices.9.message"), undefined);
});

test("normalizeSize parses WxH", () => {
  assert.deepEqual(normalizeSize("1024x1024"), { width: 1024, height: 1024, raw: "1024x1024" });
  assert.deepEqual(normalizeSize("1536X1024"), { width: 1536, height: 1024, raw: "1536x1024" });
  assert.equal(normalizeSize("auto"), null);
  assert.equal(normalizeSize("nonsense"), null);
});

test("config merges defaults with overrides", () => {
  const cfg = loadConfig({ cwd: tmpdir(), overrides: { providers: { openrouter: { model: "custom/model" } } } });
  assert.equal(cfg.providers.openrouter.model, "custom/model");
  assert.equal(cfg.providers.openrouter.baseUrl, DEFAULT_CONFIG.providers.openrouter.baseUrl);
  assert.deepEqual(cfg.priority, DEFAULT_CONFIG.priority);
});

test("gptweb2api projectId: null by default; env override wires it", () => {
  const clean = loadConfig({ cwd: tmpdir() });
  assert.equal(clean.providers.gptweb2api.projectId, null);
  process.env.BRUSHROUTER_GPTWEB_PROJECT_ID = "g-p-test-123";
  try {
    const env = loadConfig({ cwd: tmpdir() });
    assert.equal(env.providers.gptweb2api.projectId, "g-p-test-123");
  } finally {
    delete process.env.BRUSHROUTER_GPTWEB_PROJECT_ID;
  }
});

test("every provider id in priority exists in the registry", () => {
  for (const id of DEFAULT_CONFIG.priority) {
    assert.ok(PROVIDERS[id], `priority lists unknown provider ${id}`);
  }
  for (const id of listProviderIds()) {
    assert.ok(DEFAULT_CONFIG.priority.includes(id), `provider ${id} missing from default priority`);
  }
});

// openrouter spends per-request money from a key, so it stays out of the default
// auto-routing walk. `enabled: false` is a capability switch, not a preference:
// naming a disabled route explicitly is refused, because any agent can add a
// --provider flag and otherwise bill credits the user never opted into.
test("openrouter is off by default and rejects an explicit --provider", async () => {
  assert.equal(DEFAULT_CONFIG.providers.openrouter.enabled, false, "openrouter was re-enabled by default");

  const cfg = loadConfig({ cwd: mkdtempSync(join(tmpdir(), "br-order-")), overrides: { priority: DEFAULT_CONFIG.priority } });
  const auto = await planAttemptOrder(cfg, {});
  assert.ok(!auto.includes("openrouter"), `auto-routing reached openrouter: ${auto.join(" -> ")}`);

  await assert.rejects(
    () => planAttemptOrder(cfg, { provider: "openrouter" }),
    (e) => e.code === "PROVIDER_DISABLED" && /routes enable openrouter/.test(e.message),
    "an explicit request for a disabled route must be refused",
  );
  // --fallback must not re-admit it through the "rest of the chain" path either.
  await assert.rejects(
    () => planAttemptOrder(cfg, { provider: "openrouter", fallback: true }),
    (e) => e.code === "PROVIDER_DISABLED",
  );

  // Opting in explicitly is what unlocks it, and nothing else.
  const enabledCfg = loadConfig({
    cwd: mkdtempSync(join(tmpdir(), "br-order-")),
    overrides: { priority: DEFAULT_CONFIG.priority, providers: { openrouter: { enabled: true } } },
  });
  assert.deepEqual(await planAttemptOrder(enabledCfg, { provider: "openrouter" }), ["openrouter"]);
});

// The gate has to hold at every entry point, not just the ordered-plan one: a
// batch names one provider and fans out N billed requests from it.
test("a batch naming a disabled route is refused before any item runs", async () => {
  // Dynamic import, matching the other batch tests: they reload the module so a
  // provider stub installed by an earlier test cannot leak into this one.
  const { batchGenerate: bg, PROVIDERS: provs } = await import("../src/router.js");
  let ran = 0;
  const calls = [];
  const cfg = loadConfig({
    cwd: mkdtempSync(join(tmpdir(), "br-batch-gate-")),
    overrides: { priority: DEFAULT_CONFIG.priority, providers: { openrouter: { enabled: false } } },
  });
  const orig = provs.openrouter.generate;
  provs.openrouter.generate = async () => {
    ran++;
    return { buffer: Buffer.from("89504e470d0a1a0a", "hex"), meta: {} };
  };
  try {
    await assert.rejects(
      () => bg({ items: ["a", "b", "c"], provider: "openrouter", cwd: tmpdir(), onItemStart: (i) => calls.push(i) }, cfg),
      (e) => e.code === "PROVIDER_DISABLED",
    );
    assert.equal(ran, 0, "a disabled route must not generate");
    assert.equal(calls.length, 0, "no item may start");
  } finally {
    provs.openrouter.generate = orig;
  }
});

test("every provider exposes the required interface", () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    assert.equal(p.id, id, `${id} has mismatched id`);
    assert.equal(typeof p.probe, "function", `${id} missing probe()`);
    assert.equal(typeof p.generate, "function", `${id} missing generate()`);
    assert.ok(p.label, `${id} missing label`);
  }
});

test("MCP delivers a generate_image result larger than the stdout pipe buffer", async () => {
  // Regression: maybeExit() used to call process.exit(0) immediately after
  // process.stdout.write(). stdout to a pipe is async, so any single response
  // bigger than the 64 KB pipe buffer was truncated and the process still
  // exited 0, handing the client an unparseable JSON-RPC line. The tools/list
  // test above cannot catch that: its payload is tiny. A real generated image
  // is multi-megabyte base64, so the payload here is deliberately oversized.
  const { spawn } = await import("node:child_process");
  const { createServer } = await import("node:http");
  const { fileURLToPath } = await import("node:url");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const bin = fileURLToPath(new URL("../bin/brushrouter.js", import.meta.url));

  // Real PNG magic + filler, not just filler: the provider now refuses a
  // payload that is not actually an image, and a fixture of pure 0x89 was only
  // ever accepted because junk was written to disk unchecked. Same 3 MB size.
  const image = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024 - PNG.length, 0x89)]); // ~4 MB once base64-encoded
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: { b64: image.toString("base64") } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  // The server reads brushrouter.config.json from its cwd, so a temp project
  // config can point custom-http at the stub without touching the user's setup.
  // The endpoint itself comes from the environment, not the project file: a
  // project config is not allowed to name a credentialed endpoint (it can
  // travel with a repository), and BRUSHROUTER_CUSTOM_URL is the supported
  // override for it.
  const dir = mkdtempSync(join(tmpdir(), "brushrouter-mcp-flush-"));
  writeFileSync(
    join(dir, "brushrouter.config.json"),
    JSON.stringify({
      priority: ["custom-http"],
      providers: {
        "custom-http": {
          enabled: true,
          body: '{"prompt": "{prompt}"}',
          response: "json:data.b64",
        },
      },
    }),
  );

  try {
    const child = spawn(process.execPath, [bin, "serve"], {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, BRUSHROUTER_CUSTOM_URL: `http://127.0.0.1:${port}/generate` },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "generate_image", arguments: { prompt: "a test image", provider: "custom-http", out: "big.png" } },
      }) + "\n",
    );
    child.stdin.end();
    const code = await new Promise((r) => child.on("close", r));
    assert.equal(code, 0);
    // Truncation is silent, so assert the byte count first: a bare JSON.parse
    // failure would not say whether the payload was cut or malformed.
    assert.ok(out.length > image.length, `stdout truncated: got ${out.length} bytes, expected > ${image.length}`);
    const msg = JSON.parse(out.trim().split("\n").pop());
    const part = msg.result?.content?.find((c) => c.type === "image");
    assert.ok(part, "no image content in the MCP response");
    assert.equal(Buffer.from(part.data, "base64").length, image.length, "image payload was truncated");
  } finally {
    server.close();
  }
});

test("providerConfig returns a copy, not a live reference", () => {
  const cfg = loadConfig({ cwd: tmpdir() });
  const a = providerConfig(cfg, "codex");
  a.enabled = false;
  assert.notEqual(cfg.providers.codex.enabled, false);
});

test("custom-http body template escapes quotes in prompts", async () => {
  const { httpImageGenerate } = await import("../src/providers/http.js");
  // Point at an invalid URL; we only care that it does not throw during templating.
  await assert.rejects(
    () =>
      httpImageGenerate(
        { prompt: 'a "quoted" \\ backslash', size: "1024x1024", cwd: tmpdir() },
        { url: "http://127.0.0.1:1/nope", body: '{"prompt":"{prompt}"}', response: "json:data.0.url" },
        { id: "t", name: "t", url: "http://127.0.0.1:1/nope", method: "POST", requiresKey: false, headers: {}, body: '{"prompt":"{prompt}"}', responsePath: "json:data.0.url", defaultModel: "m" },
      ),
    (e) => !/Unexpected token|JSON\.parse/.test(e.message),
  );
});

test("MCP server flushes async work before exiting on stdin close", async () => {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const bin = fileURLToPath(new URL("../bin/brushrouter.js", import.meta.url));
  // tools/list is answered async; the process must not exit before writing it.
  const child = spawn(process.execPath, [bin, "serve"], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
  child.stdin.end();
  const code = await new Promise((r) => child.on("close", r));
  assert.equal(code, 0);
  const lines = out.trim().split("\n").map((l) => JSON.parse(l));
  const tools = lines.find((l) => l.id === 1)?.result?.tools || [];
  assert.deepEqual(
    tools.map((t) => t.name),
    ["generate_image", "batch_generate_images", "find_image_prompts", "image_result"],
  );
  // Every advertised tool must declare a usable schema, or an agent cannot call it.
  for (const t of tools) {
    assert.equal(t.inputSchema?.type, "object", `${t.name} has no input schema`);
    assert.ok(t.description.length > 60, `${t.name} has no description worth reading`);
  }
});

// ---------------------------------------------------------------------------
// MCP session guidance + async jobs.
// ---------------------------------------------------------------------------

test("MCP initialize advertises instructions and honours a config override", async () => {
  const { handleRequest } = await import("../src/mcp.js");
  assert.match(DEFAULT_CONFIG.instructions, /brushrouter/, "default instructions lost their point");
  const dir = mkdtempSync(join(tmpdir(), "br-instr-"));
  try {
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    writeFileSync(join(dir, "brushrouter.config.json"), JSON.stringify({ instructions: "CUSTOM MARKER" }));
    const res = await handleRequest(init, { cwd: dir });
    assert.equal(res.result.instructions, "CUSTOM MARKER");
    // "" must send nothing, not an empty instructions field.
    writeFileSync(join(dir, "brushrouter.config.json"), JSON.stringify({ instructions: "" }));
    const off = await handleRequest(init, { cwd: dir });
    assert.equal("instructions" in off.result, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("async generate_image returns a jobId and image_result collects the image", async () => {
  const { createServer } = await import("node:http");
  const { handleRequest, JOB_TOOL_NAME } = await import("../src/mcp.js");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: { b64: PNG.toString("base64") } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "br-job-"));
  // Endpoint via env, not the project config: see the note on project-config
  // trust in src/config.js. The project file still carries the non-sensitive
  // parts (priority, enabled, templates).
  const prevCustomUrl = process.env.BRUSHROUTER_CUSTOM_URL;
  process.env.BRUSHROUTER_CUSTOM_URL = `http://127.0.0.1:${server.address().port}/g`;
  writeFileSync(
    join(dir, "brushrouter.config.json"),
    JSON.stringify({
      priority: ["custom-http"],
      providers: {
        "custom-http": {
          enabled: true,
          body: '{"prompt":"{prompt}"}',
          response: "json:data.b64",
        },
      },
    }),
  );
  const notes = [];
  const ctx = { cwd: dir, notify: (method, params) => notes.push({ method, params }) };
  const call = (id, name, args) =>
    handleRequest({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, ctx);
  try {
    // async:true must return at once with a jobId, not the image.
    const started = await call(1, "generate_image", { prompt: "x", provider: "custom-http", async: true, out: "a.png" });
    const jobId = /job (img_[a-z0-9_]+)/.exec(started.result.content[0].text)?.[1];
    assert.ok(jobId, `no jobId returned: ${started.result.content[0].text}`);
    assert.equal(started.result.content.some((c) => c.type === "image"), false, "async call still blocked on the image");

    // An unknown job is a reported error, not a crash.
    const bogus = await call(2, JOB_TOOL_NAME, { jobId: "nope" });
    assert.equal(bogus.result.isError, true);

    // Poll until the job finishes (the stub answers immediately).
    let poll;
    for (let i = 0; i < 50; i++) {
      poll = await call(3, JOB_TOOL_NAME, { jobId });
      if (poll.result.content.some((c) => c.type === "image")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const part = poll.result.content.find((c) => c.type === "image");
    assert.ok(part, "job never produced an image");
    assert.equal(Buffer.from(part.data, "base64").length, PNG.length, "image payload was altered");
    assert.ok(
      notes.some((n) => n.method === "notifications/tasks/status" && n.params.status === "completed"),
      "no completion notification was emitted",
    );
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    if (prevCustomUrl === undefined) delete process.env.BRUSHROUTER_CUSTOM_URL;
    else process.env.BRUSHROUTER_CUSTOM_URL = prevCustomUrl;
  }
});

// ---------------------------------------------------------------------------
// Memory: a completed job's image is on disk, so its base64 payload is only a
// cache. Retaining every payload for the 1h TTL made a long agent session grow
// by one base64 image per generation without limit.
// ---------------------------------------------------------------------------

test("job payload eviction keeps the newest bytes within budget and frees the rest", async () => {
  const { evictPayloads } = await import("../src/mcp.js");
  const MB = 1024 * 1024;
  const job = (id, createdAt, bytes, status = "completed") => ({
    id,
    createdAt,
    bytes,
    status,
    content: status === "completed" ? { content: [] } : null,
  });

  // Newest-first: the newest payloads keep their bytes, the oldest gives its up.
  const three = [job("a", 1, 4 * MB), job("b", 2, 4 * MB), job("c", 3, 4 * MB)];
  assert.deepEqual(evictPayloads(three, 8 * MB).map((j) => j.id), ["a"], "wrong job evicted");

  // Within budget nothing is evicted, so recent jobs keep the fast path.
  assert.deepEqual(evictPayloads([job("a", 1, MB), job("b", 2, MB)], 8 * MB), []);

  // A payload bigger than the entire budget is evicted rather than retained.
  assert.deepEqual(evictPayloads([job("big", 1, 64 * MB)], 32 * MB).map((j) => j.id), ["big"]);

  // Jobs with nothing to free are left alone: still working, or already evicted.
  const gone = { id: "gone", createdAt: 1, bytes: 4 * MB, status: "completed", content: null };
  assert.deepEqual(evictPayloads([job("work", 9, 64 * MB, "working"), gone, job("zero", 8, 0)], 0), []);
});

test("job retention knobs are env-overridable and reject nonsense", async () => {
  const MB = 1024 * 1024;
  const job = (id, createdAt) => ({ id, createdAt, bytes: 4 * MB, status: "completed", content: { content: [] } });
  // Cache-bust the import so the module re-reads the env at load time.
  const evicted = async (env) => {
    const saved = process.env.BRUSHROUTER_JOB_MAX_BYTES;
    if (env === undefined) delete process.env.BRUSHROUTER_JOB_MAX_BYTES;
    else process.env.BRUSHROUTER_JOB_MAX_BYTES = env;
    try {
      const { evictPayloads } = await import(`../src/mcp.js?maxBytes=${env}`);
      return evictPayloads([job("old", 1), job("new", 2)]).map((j) => j.id);
    } finally {
      if (saved === undefined) delete process.env.BRUSHROUTER_JOB_MAX_BYTES;
      else process.env.BRUSHROUTER_JOB_MAX_BYTES = saved;
    }
  };
  // A 6 MB budget fits the newest 4 MB payload but not the older one.
  assert.deepEqual(await evicted("6291456"), ["old"]);
  assert.deepEqual(await evicted("104857600"), []);
  // Nonsense must fall back to the default rather than evicting everything.
  for (const bad of ["banana", "0", "-5", "", undefined]) {
    assert.deepEqual(await evicted(bad), [], `budget ${JSON.stringify(bad)} was not rejected`);
  }
});

// ---------------------------------------------------------------------------
// SECURITY: credentials must never be able to reach a model or a log.
// ---------------------------------------------------------------------------

test("redact removes registered secrets by value", async () => {
  const { redact, registerSecret } = await import("../src/util/redact.js");
  const secret = "sk-or-v1-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  registerSecret(secret);
  const out = redact(`the key is ${secret} and that is all`);
  assert.ok(!out.includes(secret), "registered secret leaked");
  assert.match(out, /\*\*\*/);
});

test("redact removes well-known token shapes even if never registered", async () => {
  const { redact, clearSecrets } = await import("../src/util/redact.js");
  clearSecrets();
  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";
  const cases = [
    "sk-proj-abcdefghijklmnopqrstuvwxyz",
    "sk-or-v1-abcdefghijklmnopqrstuvwxyz012345",
    `Authorization: Bearer ${jwt}`,
    `"refresh_token": "${jwt}"`,
    "OPENAI_API_KEY=sk-proj-abcdefghijklmnop",
  ];
  for (const c of cases) {
    const out = redact(c);
    assert.ok(!out.includes(jwt), `jwt leaked from: ${c}`);
    assert.ok(!/sk-(or-v1-)?[A-Za-z0-9_-]{16,}/.test(out), `key leaked from: ${c}`);
  }
});

test("redactValue masks secret-named fields deeply", async () => {
  const { redactValue } = await import("../src/util/redact.js");
  const fake = "sk-or-v1-ZZZZZZZZZZZZZZZZZZZZZZ";
  const out = redactValue({ a: { apiKey: fake, token: fake, ok: "hello" }, list: [fake] });
  assert.equal(out.a.apiKey, "***");
  assert.equal(out.a.token, "***");
  assert.equal(out.a.ok, "hello");
  // A bare string in a list is redacted by shape (we can't know it is a secret).
  assert.ok(!out.list[0].includes("ZZZZZZZZZZZZZZZZZZZZZZ"), "bare key leaked");
});

test("redactValue fails closed past its depth limit instead of leaking", async () => {
  const { redactValue } = await import("../src/util/redact.js");
  const secret = "sk-live-DEEPNESTEDSECRET1234567890";
  const nest = (n) => (n === 0 ? { api_key: secret } : { nest: nest(n - 1) });
  const strAt = (n) => (n === 0 ? secret : { nest: strAt(n - 1) });

  // A secret-named field below the limit is masked by name, past it the whole
  // subtree collapses — either way nothing reaches the caller.
  for (const depth of [7, 8, 9, 12, 40]) {
    assert.ok(!JSON.stringify(redactValue(nest(depth))).includes("DEEPNESTEDSECRET"), `field leaked at depth ${depth}`);
  }
  // A bare string leaf is redacted by shape at *any* depth. This is the case the
  // old guard passed through raw, because it checked depth before type.
  for (const depth of [9, 20]) {
    assert.ok(!JSON.stringify(redactValue(strAt(depth))).includes("DEEPNESTEDSECRET"), `string leaked at depth ${depth}`);
  }
  // The limit still bounds recursion rather than blowing the stack.
  assert.doesNotThrow(() => redactValue(nest(5000)));
});

test("redactValue keeps real tool-style schemas intact within its limit", async () => {
  const { redactValue } = await import("../src/util/redact.js");
  // A nested inputSchema (per-item options array) sits ~9 containers deep in a
  // tools/list response. The old depth-8 limit collapsed its leaf property
  // schemas into the literal "***", which is not valid JSON Schema and made
  // one provider's request validator reject every deepseek request that
  // carried the tool.
  const schema = {
    name: "batch_generate_images",
    inputSchema: {
      type: "object",
      properties: {
        prompts: { type: "array", items: { type: "string" } },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              prompt: { type: "string" },
              background: { type: "string", enum: ["opaque", "transparent"] },
            },
            required: ["prompt"],
          },
        },
      },
    },
  };
  const tools = redactValue({ result: { tools: [schema] } });
  const leaf = tools.result.tools[0].inputSchema.properties.items.items.properties.prompt;
  assert.equal(leaf.type, "string", "nested property schema must survive redaction");

  // A secret nested inside a schema is still masked, by value; only the
  // container-collapse behavior changed.
  const leaked = { inputSchema: { properties: {
    note: { type: "string", description: "call key sk-live-SCHEMALEAKTEST1234567890 to auth" } } } };
  const out = redactValue(leaked);
  assert.ok(!JSON.stringify(out).includes("SCHEMALEAKTEST"), "secret inside schema leaked");
});

test("redactValue passes marked opaque bytes through but redacts everything beside them", async () => {
  const { redactValue, registerSecret, OPAQUE_BYTES } = await import("../src/util/redact.js");
  registerSecret("sk-live-OPAQUETESTVALUE1234567890");
  // Shaped like real image data: long, and pure base64 so nothing in it can be
  // distinguished from a credential by content alone.
  const payload = "A".repeat(4096) + "=";

  const marked = { type: "image", data: payload, mimeType: "image/png" };
  marked[OPAQUE_BYTES] = true;
  const out = redactValue(marked);
  assert.equal(out.data, payload, "marked payload must survive untouched");
  assert.equal(out.mimeType, "image/png");
  assert.equal(Object.getOwnPropertySymbols(out).length, 0, "marker must not be copied out");
  assert.ok(!JSON.stringify(out).includes("opaqueBytes"), "marker must not reach JSON");

  // The exemption covers exactly one field of one object. A secret sitting
  // beside the payload is still removed, and an *unmarked* payload of the same
  // shape is still scanned — no content-based heuristic can bypass redaction.
  const sneaky = { type: "image", data: payload, mimeType: "image/png", note: "sk-live-OPAQUETESTVALUE1234567890" };
  sneaky[OPAQUE_BYTES] = true;
  assert.equal(redactValue(sneaky).note, "***", "a secret beside the payload leaked");
  assert.ok(
    !redactValue({ blob: `${payload} sk-live-OPAQUETESTVALUE1234567890` }).blob.includes("OPAQUETESTVALUE"),
    "an unmarked payload must still be redacted",
  );
});

test("redact does not mangle ordinary prose", async () => {
  const { redact } = await import("../src/util/redact.js");
  // Regression: an over-eager `Key <word>` pattern used to turn this into "Key ***".
  const prose = "Key auto-discovered from agent auth stores or BRUSHROUTER_OPENROUTER_KEY.";
  assert.equal(redact(prose), prose);
  assert.equal(redact("Token refresh succeeded"), "Token refresh succeeded");
  // But a real bearer credential is still removed.
  assert.match(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"), /\*\*\*/);
});

test("describeKey never reveals the full key", async () => {
  const { describeKey } = await import("../src/util/keys.js");
  const fake = "sk-or-v1-SUPERSECRETVALUE1234567890";
  const d = describeKey(fake);
  assert.ok(!d.includes("SUPERSECRET"), "describeKey leaked the key body");
  assert.match(d, /^sk-o/);
});

test("keys lookLikeRealKey rejects placeholders and wrong shapes", async () => {
  const { discoverKey } = await import("../src/util/keys.js");
  // A proxy token in OPENAI_API_KEY must not be mistaken for a real OpenAI key.
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "not-a-real-openai-key-format";
  try {
    const found = discoverKey("openai");
    assert.ok(!found || !found.key.startsWith("not-a-real"), "accepted a malformed OpenAI key");
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  }
});

// ---------------------------------------------------------------------------
// FLEXIBILITY: nothing may be hardcoded to one machine.
// ---------------------------------------------------------------------------

test("config defaults contain no absolute personal paths", () => {
  const blob = JSON.stringify(DEFAULT_CONFIG);
  assert.ok(!blob.includes("/Users/"), "DEFAULT_CONFIG embeds a personal path");
  assert.ok(!/\/Applications\/[A-Za-z ]+\.app/.test(blob), "DEFAULT_CONFIG hardcodes an app path");
  assert.ok(!/app_[A-Za-z0-9]{20,}/.test(blob), "DEFAULT_CONFIG embeds an OAuth client id");
});

test("discovery returns structured results and never throws", async () => {
  const { findCodexCli, findGoogleClis } = await import("../src/util/discover.js");
  const cli = findCodexCli();
  if (cli) {
    assert.ok(cli.path && cli.version, "codex cli result missing fields");
    assert.ok(!/token|secret/i.test(JSON.stringify(cli)), "discovery must not surface credentials");
  }
  assert.ok(Array.isArray(findGoogleClis()));
});

test("codex-cli provider exposes the required interface", () => {
  const p = PROVIDERS["codex-cli"];
  assert.equal(p.id, "codex-cli");
  assert.equal(typeof p.probe, "function");
  assert.equal(typeof p.generate, "function");
});

// Regression: `brushrouter --help` / `-h` used to be treated as an unknown
// command because the flag was parsed as the command name.
test("CLI --help and -h print usage and exit 0", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const bin = fileURLToPath(new URL("../bin/brushrouter.js", import.meta.url));
  for (const flag of ["--help", "-h"]) {
    const r = spawnSync(process.execPath, [bin, flag], { encoding: "utf8" });
    assert.equal(r.status, 0, `${flag} should exit 0`);
    assert.match(r.stdout, /USAGE/, `${flag} should print usage`);
  }
  // No args also prints usage.
  const none = spawnSync(process.execPath, [bin], { encoding: "utf8" });
  assert.equal(none.status, 0);
  assert.match(none.stdout, /USAGE/);
});

// Regression: a provider that returns an Error object (instead of throwing it)
// used to be spread into the result, yielding `buffer: undefined` and a crash
// inside saveImage. The router must validate the provider's return value.
test("router rejects a provider that returns no image buffer", async () => {
  const { generate, PROVIDERS } = await import("../src/router.js");
  const { loadConfig } = await import("../src/config.js");
  const original = PROVIDERS["codex-cli"].generate;
  // Simulate the exact old bug: return an Error instead of throwing it.
  PROVIDERS["codex-cli"].generate = async () => new Error("agy produced no image");
  try {
    const cfg = loadConfig({ cwd: tmpdir(), overrides: { priority: ["codex-cli"] } });
    await assert.rejects(
      () => generate({ prompt: "x", out: "x.png", cwd: tmpdir() }, cfg),
      (e) => {
        assert.ok(/no image data|all providers failed/i.test(e.message), `unexpected message: ${e.message}`);
        return true;
      },
    );
  } finally {
    PROVIDERS["codex-cli"].generate = original;
  }
});

// ---------------------------------------------------------------------------
// ROUTE CONTROL: users can disable a provider, and disabling must be honored.
// ---------------------------------------------------------------------------

test("setRouteEnabled persists a toggle and rejects unknown routes", async () => {
  const { setRouteEnabled } = await import("../src/router.js");
  const dir = mkdtempSync(join(tmpdir(), "br-routes-"));
  const file = join(dir, "config.json");
  try {
    assert.equal(setRouteEnabled("fal", false, { path: file }), file);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.providers.fal.enabled, false);
    // Toggling another route must not clobber the first.
    setRouteEnabled("openrouter", false, { path: file });
    const saved2 = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved2.providers.fal.enabled, false);
    assert.equal(saved2.providers.openrouter.enabled, false);
    assert.throws(() => setRouteEnabled("nope", false, { path: file }), /unknown route/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a disabled route is skipped by auto-routing", async () => {
  const { generate, PROVIDERS } = await import("../src/router.js");
  const { loadConfig } = await import("../src/config.js");
  const original = PROVIDERS["gemini"].generate;
  let called = false;
  PROVIDERS["gemini"].generate = async () => {
    called = true;
    return { buffer: PNG, meta: { model: "stub" } };
  };
  try {
    // Priority lists only gemini, but it is disabled -> nothing to try.
    const cfg = loadConfig({ cwd: tmpdir(), overrides: { priority: ["gemini"], providers: { gemini: { enabled: false } } } });
    await assert.rejects(
      () => generate({ prompt: "x", out: "x.png", cwd: tmpdir() }, cfg),
      /no providers enabled/i,
    );
    assert.equal(called, false, "disabled provider was invoked");
  } finally {
    PROVIDERS["gemini"].generate = original;
  }
});

test("BRUSHROUTER_DISABLE / BRUSHROUTER_ENABLE toggle routes via env", async () => {
  const { loadConfig } = await import("../src/config.js");
  const saved = { d: process.env.BRUSHROUTER_DISABLE, e: process.env.BRUSHROUTER_ENABLE };
  process.env.BRUSHROUTER_DISABLE = "openrouter,fal";
  process.env.BRUSHROUTER_ENABLE = "gptweb2api";
  try {
    const cfg = loadConfig({ cwd: tmpdir() });
    assert.equal(cfg.providers.openrouter.enabled, false);
    assert.equal(cfg.providers.fal.enabled, false);
    assert.equal(cfg.providers["gptweb2api"].enabled, true);
    // Untouched routes keep their defaults.
    assert.equal(cfg.providers.gemini.enabled, true);
  } finally {
    if (saved.d === undefined) delete process.env.BRUSHROUTER_DISABLE;
    else process.env.BRUSHROUTER_DISABLE = saved.d;
    if (saved.e === undefined) delete process.env.BRUSHROUTER_ENABLE;
    else process.env.BRUSHROUTER_ENABLE = saved.e;
  }
});

// ---------------------------------------------------------------------------
// MODEL CHOICE: the user can pin a model, and a pin is never silently swapped.
// ---------------------------------------------------------------------------

test("a pinned OpenRouter model is not silently substituted", async () => {
  const { openrouterProvider } = await import("../src/providers/http.js");
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    // Mimic the real flow: chat rejects an image-only model, /images then runs
    // out of credits. Neither is a reason to swap in a different model.
    if (String(url).endsWith("/chat/completions")) {
      return {
        ok: false,
        status: 404,
        text: async () =>
          '{"error":{"message":"No endpoints found that support the requested output modalities: image, text"}}',
        json: async () => ({}),
      };
    }
    return {
      ok: false,
      status: 402,
      text: async () => '{"error":{"message":"Insufficient credits"}}',
      json: async () => ({}),
    };
  };
  try {
    await assert.rejects(
      () =>
        openrouterProvider.generate(
          { prompt: "x", cwd: tmpdir(), model: "meta/muse-image" },
          { apiKey: "sk-or-v1-fake000000000000", model: null },
        ),
      /Insufficient credits/,
    );
    // Every request used the pinned model — no substitution happened.
    assert.ok(bodies.length > 0);
    for (const b of bodies) assert.equal(b.model, "meta/muse-image");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an image-only model falls back from chat/completions to /images", async () => {
  const { openrouterProvider } = await import("../src/providers/http.js");
  const seen = [];
  const realFetch = globalThis.fetch;
  const b64 = PNG.toString("base64");
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).endsWith("/chat/completions")) {
      return {
        ok: false,
        status: 404,
        text: async () =>
          '{"error":{"message":"No endpoints found that support the requested output modalities: image, text"}}',
        json: async () => ({}),
      };
    }
    return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: b64 }] }), text: async () => "" };
  };
  try {
    const r = await openrouterProvider.generate(
      { prompt: "x", cwd: tmpdir(), model: "meta/muse-image" },
      { apiKey: "sk-or-v1-fake000000000000", model: null },
    );
    assert.ok(Buffer.isBuffer(r.buffer) && r.buffer.length > 0);
    assert.equal(r.meta.endpoint, "/images");
    assert.equal(seen.length, 2, `expected chat then images, saw ${seen.join(", ")}`);
    assert.match(seen[0], /chat\/completions$/);
    assert.match(seen[1], /\/images$/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("openrouter default models do not hardcode a single vendor", async () => {
  const { openrouterProvider } = await import("../src/providers/http.js");
  assert.ok(Array.isArray(openrouterProvider.defaultModels));
  assert.ok(openrouterProvider.defaultModels.length > 0);
  // The old default must be gone; a fallback LIST is fine.
  assert.ok(!openrouterProvider.defaultModels.includes("openai/gpt-5-image-mini"));
});

// ---------------------------------------------------------------------------
// Security regressions
// ---------------------------------------------------------------------------

test("a project config cannot name a program or a credentialed endpoint", () => {
  const dir = mkdtempSync(join(tmpdir(), "br-project-"));
  try {
    writeFileSync(
      join(dir, "brushrouter.config.json"),
      JSON.stringify({
        providers: {
          openrouter: { baseUrl: "http://attacker.example/v1", model: "legit/model" },
          fal: { baseUrl: "http://attacker.example" },
          "codex-cli": { cli: "/tmp/evil-binary", model: "gpt-5.6" },
          gemini: { cli: "/tmp/evil-binary" },
          codex: { authFile: "/etc/shadow" },
          "custom-http": { enabled: true, url: "http://attacker.example/exfil" },
        },
      }),
    );
    const cfg = loadConfig({ cwd: dir });
    const d = DEFAULT_CONFIG.providers;
    // Refused: everything that executes or redirects a credentialed request.
    assert.equal(cfg.providers.openrouter.baseUrl, d.openrouter.baseUrl, "project config redirected a key-bearing baseUrl");
    assert.equal(cfg.providers.fal.baseUrl, d.fal.baseUrl, "project config redirected a key-bearing baseUrl");
    assert.equal(cfg.providers["codex-cli"].cli, null, "project config chose an executable");
    assert.equal(cfg.providers.gemini.cli, null, "project config chose an executable");
    assert.equal(cfg.providers.codex.authFile, null, "project config chose a credential file");
    assert.equal(cfg.providers["custom-http"].url, "", "project config chose an exfil endpoint");
    // Still honoured: ordinary, non-executable settings a project may legitimately carry.
    assert.equal(cfg.providers.openrouter.model, "legit/model");
    assert.equal(cfg.providers["codex-cli"].model, "gpt-5.6");
    assert.equal(cfg.providers["custom-http"].enabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit path in providers.*.cli is still accepted (no shell involved)", async () => {
  const { resolveExecutable } = await import("../src/util/discover.js");
  const dir = mkdtempSync(join(tmpdir(), "br-exec-"));
  try {
    const marker = join(dir, "pwned");
    const fake = join(dir, "fake-cli");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    assert.equal(resolveExecutable(fake), fake, "an absolute executable path must still resolve");
    assert.equal(resolveExecutable(`${fake}; touch ${marker}`), null, "a shell metacharacter must not resolve");
    assert.ok(!existsSync(marker));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("providers.gemini.cli is never passed through a shell", async () => {
  // Regression: `sh -c "command -v <cfg.cli>"` executed this config value.
  const { geminiProvider } = await import("../src/providers/gemini.js");
  const dir = mkdtempSync(join(tmpdir(), "br-inject-"));
  try {
    const marker = join(dir, "pwned");
    const r = await geminiProvider.probe({ cli: `gemini; touch ${marker}` });
    assert.equal(r.available, false);
    assert.ok(!existsSync(marker), "a config value reached a shell");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codex auth tokens are registered with the redactor by value", async () => {
  const { readAuth } = await import("../src/providers/codex.js");
  const { redact } = await import("../src/util/redact.js");
  const dir = mkdtempSync(join(tmpdir(), "br-auth-"));
  try {
    // An opaque refresh token, deliberately shaped so no pattern would catch it.
    const access = "OPAQUEACCESS0000000000000000000000";
    const refresh = "OPAQUEREFRESH000000000000000000000";
    const file = join(dir, "auth.json");
    writeFileSync(file, JSON.stringify({ tokens: { access_token: access, refresh_token: refresh, account_id: "acct" } }));
    const auth = readAuth({ authFile: file });
    assert.equal(auth.access, access);
    assert.ok(!redact(`server said: ${access}`).includes(access), "access token leaked past redaction");
    assert.ok(!redact(`server said: ${refresh}`).includes(refresh), "refresh token leaked past redaction");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeJwt(claims) {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  // exp 2033: makeJwt is only read locally; no signature is checked by br.
  return `x.${b64u({ exp: 2000000000, ...claims })}.y`;
}

function withEnv(map, fn) {
  const saved = new Map(Object.entries(map).map(([k]) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(map)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const CLAIMS_KEY = "https://api.openai.com/auth";

test("readAuth reads pi/omp-format auth.json (per-provider oauth entry)", async () => {
  const { readAuth } = await import("../src/providers/codex.js");
  const { redact } = await import("../src/util/redact.js");
  const dir = mkdtempSync(join(tmpdir(), "br-auth-pi-"));
  const access = makeJwt({ [CLAIMS_KEY]: { chatgpt_plan_type: "plus", chatgpt_account_id: "acct-9" }, client_id: "app_test" });
  try {
    const file = join(dir, "auth.json");
    writeFileSync(file, JSON.stringify({ "openai-codex": { type: "oauth", access, refresh: "r123" } }));
    const auth = readAuth({ authFile: file });
    assert.equal(auth.format, "pi");
    assert.equal(auth.access, access);
    assert.equal(auth.plan, "plus");
    assert.equal(auth.accountId, "acct-9");
    assert.ok(!redact(`tok ${access}`).includes(access), "pi access token leaked past redaction");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("brushrouter's own auth.json outranks the borrowed ones", async () => {
  const { readAuth } = await import("../src/providers/codex.js");
  const dir = mkdtempSync(join(tmpdir(), "br-home-"));
  const cfg = mkdtempSync(join(tmpdir(), "br-cfg-"));
  try {
    const own = makeJwt({ [CLAIMS_KEY]: { chatgpt_plan_type: "pro" } });
    const codexToken = makeJwt({ [CLAIMS_KEY]: { chatgpt_plan_type: "free" } });
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(join(dir, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: codexToken } }));
    writeFileSync(join(cfg, "auth.json"), JSON.stringify({ tokens: { access_token: own } }));
    const auth = withEnv({ HOME: dir, BRUSHROUTER_CONFIG_DIR: cfg, XDG_DATA_HOME: undefined }, () => readAuth());
    assert.equal(auth.plan, "pro", "expected brushrouter's own auth to win over ~/.codex");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("oauth helpers: pkce + credential validation", async () => {
  const { pkcePair, credentialFromTokenResponse } = await import("../src/oauth.js");
  const { createHash } = await import("node:crypto");
  const { verifier, challenge } = pkcePair();
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
  assert.throws(() => credentialFromTokenResponse({ access_token: "a" }), /missing refresh_token/);
  const idToken = makeJwt({ [CLAIMS_KEY]: { chatgpt_account_id: "a-1", chatgpt_plan_type: "pro" } });
  const cred = credentialFromTokenResponse({ access_token: "a", refresh_token: "r", id_token: idToken });
  assert.equal(cred.tokens.account_id, "a-1");
  assert.throws(() => credentialFromTokenResponse({ access_token: "a", refresh_token: "r", id_token: makeJwt({}) }), /no ChatGPT account/);
});

test("safeParseMessage drops the file fragment a JSON error quotes back", async () => {
  const { safeParseMessage } = await import("../src/util/redact.js");
  const { loadConfig } = await import("../src/config.js");
  const dir = mkdtempSync(join(tmpdir(), "br-parse-"));
  try {
    const secret = "SUPERSECRETVALUE-abcdefghijklmnop";
    writeFileSync(join(dir, "brushrouter.config.json"), `${secret}\n`);
    let msg = "";
    try {
      loadConfig({ cwd: dir });
    } catch (e) {
      msg = e.message;
    }
    assert.match(msg, /failed to parse/, "expected a parse error");
    assert.ok(!msg.includes("SUPERSECRET"), `the parser quoted file content back: ${msg}`);
    assert.ok(!safeParseMessage(new SyntaxError('Unexpected token \'S\', "LEAKME..." is not valid JSON')).includes("LEAKME"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("freePath handles paths without extensions safely", async () => {
  const { freePath } = await import("../src/util/common.js");
  const dir = mkdtempSync(join(tmpdir(), "br-freepath-"));
  try {
    const p = join(dir, "image");
    writeFileSync(p, "data");
    const p2 = freePath(p);
    assert.equal(p2, `${p}-v2.png`);
    writeFileSync(p2, "data");
    const p3 = freePath(p);
    assert.equal(p3, `${p}-v3.png`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sseData parses trailing lines when stream finishes without newline", async () => {
  const { sseData } = await import("../src/util/common.js");
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: line1\ndata: line2"));
      controller.close();
    },
  });
  const results = [];
  for await (const chunk of sseData(stream)) {
    results.push(chunk);
  }
  assert.deepEqual(results, ["line1", "line2"]);
});

test("attemptOrder prioritizes image-capable providers when images are provided", async () => {
  const { planAttemptOrder } = await import("../src/router.js");
  const cfg = {
    priority: ["gptweb2api", "gemini", "fal", "openrouter"],
    providers: {
      "gptweb2api": { enabled: true },
      gemini: { enabled: true },
      fal: { enabled: true },
      openrouter: { enabled: true },
    },
  };
  const order = await planAttemptOrder(cfg, { images: ["ref.png"] });
  assert.equal(order[0], "openrouter");
  assert.deepEqual(order, ["openrouter", "gptweb2api", "gemini", "fal"]);
});

test("customHttpProvider uses resolved key for auth", async () => {
  const { customHttpProvider } = await import("../src/providers/http.js");
  const probe = await customHttpProvider.probe({ url: "https://api.example.com/v1" });
  assert.equal(probe.available, true);
  assert.equal(probe.auth, "none");
  const probeWithKey = await customHttpProvider.probe({ url: "https://api.example.com/v1", apiKey: "test-key" });
  assert.equal(probeWithKey.available, true);
  assert.equal(probeWithKey.auth, "key");
});

test("serveMcp handles invalid json and malformed json-rpc with standard error codes", async () => {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const bin = fileURLToPath(new URL("../bin/brushrouter.js", import.meta.url));
  const child = spawn(process.execPath, [bin, "serve"], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stdin.write("not valid json\n");
  child.stdin.write(JSON.stringify(["not", "an", "object"]) + "\n");
  child.stdin.end();
  await new Promise((resolve) => child.on("close", resolve));
  const lines = out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines[0].error.code, -32700); // Parse error
  assert.equal(lines[1].error.code, -32600); // Invalid Request
});

test("gemini provider defaults to gemini-3.8-flash-high", async () => {
  const { DEFAULT_CONFIG } = await import("../src/config.js");
  const { DEFAULT_GEMINI_MODEL } = await import("../src/providers/gemini.js");
  assert.equal(DEFAULT_CONFIG.providers.gemini.model, "gemini-3.8-flash-high");
  assert.equal(DEFAULT_GEMINI_MODEL, "gemini-3.8-flash-high");
});

test("findCodexCli discovers bundled CLI in desktop ChatGPT app", async () => {
  const { findCodexCli, resetDiscoverCache } = await import("../src/util/discover.js");
  resetDiscoverCache();
  const cli = findCodexCli();
  if (existsSync("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex")) {
    assert.ok(cli, "should find bundled codex cli in ChatGPT.app");
    assert.match(cli.path, /codex/);
    assert.match(cli.version, /codex/i);
  }
});

test("batchItemPath formats slug and padding correctly", async () => {
  const { batchItemPath } = await import("../src/util/common.js");
  const p1 = batchItemPath("/tmp/out", 1, 10, "A Red Fox in the Snow!");
  assert.equal(p1, "/tmp/out/01-a-red-fox-in-the-snow.png");

  const p2 = batchItemPath("/tmp/out", 12, 100, "Isometric Coffee Shop");
  assert.equal(p2, "/tmp/out/012-isometric-coffee-shop.png");

  const p3 = batchItemPath("/tmp/out", 1, 5, "");
  assert.equal(p3, "/tmp/out/01-image.png");
});

test("batchVariantPath suffixes index before extension", async () => {
  const { batchVariantPath } = await import("../src/util/common.js");
  assert.equal(batchVariantPath("fox.png", 1, 3), "fox-1.png");
  assert.equal(batchVariantPath("fox.png", 2, 3), "fox-2.png");
  assert.equal(batchVariantPath("/dir/art", 1, 10), "/dir/art-01.png");
});

test("batchGenerate distributes multiple prompts concurrently and writes images", async () => {
  const { batchGenerate, PROVIDERS } = await import("../src/router.js");
  const dir = mkdtempSync(join(tmpdir(), "br-batch-test-"));

  let activeExecutions = 0;
  let maxConcurrent = 0;
  const executedPrompts = [];

  PROVIDERS["mock-batch-1"] = {
    id: "mock-batch-1",
    supportsImages: true,
    async probe() {
      return { available: true };
    },
    async generate({ prompt }) {
      activeExecutions++;
      maxConcurrent = Math.max(maxConcurrent, activeExecutions);
      executedPrompts.push(prompt);
      await new Promise((r) => setTimeout(r, 20));
      activeExecutions--;
      return { buffer: PNG, meta: { model: "mock-model" } };
    },
  };

  PROVIDERS["mock-batch-2"] = {
    id: "mock-batch-2",
    supportsImages: true,
    async probe() {
      return { available: true };
    },
    async generate({ prompt }) {
      activeExecutions++;
      maxConcurrent = Math.max(maxConcurrent, activeExecutions);
      executedPrompts.push(prompt);
      await new Promise((r) => setTimeout(r, 20));
      activeExecutions--;
      return { buffer: PNG, meta: { model: "mock-model-2" } };
    },
  };

  try {
    const cfg = {
      priority: ["mock-batch-1", "mock-batch-2"],
      providers: {
        "mock-batch-1": { enabled: true, concurrency: 2 },
        "mock-batch-2": { enabled: true, concurrency: 2 },
      },
    };

    const items = [
      { prompt: "prompt 1" },
      { prompt: "prompt 2" },
      { prompt: "prompt 3" },
      { prompt: "prompt 4" },
    ];

    const result = await batchGenerate(
      {
        items,
        outDir: dir,
        concurrency: 3,
      },
      cfg,
    );

    assert.equal(result.total, 4);
    assert.equal(result.completed, 4);
    assert.equal(result.failed, 0);
    assert.equal(executedPrompts.length, 4);
    assert.ok(maxConcurrent >= 2, `expected concurrent execution, got maxConcurrent=${maxConcurrent}`);
    assert.ok(maxConcurrent <= 3, `concurrency exceeded limit: ${maxConcurrent}`);

    for (const r of result.results) {
      assert.ok(r.ok);
      assert.ok(existsSync(r.savedPath));
      assert.ok(r.savedPath.startsWith(dir));
    }
  } finally {
    delete PROVIDERS["mock-batch-1"];
    delete PROVIDERS["mock-batch-2"];
    rmSync(dir, { recursive: true, force: true });
  }
});

test("batchGenerate handles rate-limit circuit breaking with provider cooldown", async () => {
  const { batchGenerate, PROVIDERS } = await import("../src/router.js");
  const dir = mkdtempSync(join(tmpdir(), "br-batch-cd-"));

  let p1Calls = 0;
  let p2Calls = 0;

  PROVIDERS["mock-cd-1"] = {
    id: "mock-cd-1",
    async probe() {
      return { available: true };
    },
    async generate() {
      p1Calls++;
      const err = new Error("Usage limit reached for this month");
      err.code = "USAGE_LIMIT_REACHED";
      throw err;
    },
  };

  PROVIDERS["mock-cd-2"] = {
    id: "mock-cd-2",
    async probe() {
      return { available: true };
    },
    async generate() {
      p2Calls++;
      return { buffer: PNG, meta: { model: "backup" } };
    },
  };

  try {
    const cfg = {
      priority: ["mock-cd-1", "mock-cd-2"],
      providers: {
        "mock-cd-1": { enabled: true },
        "mock-cd-2": { enabled: true },
      },
    };

    const cooldownEvents = [];
    const items = [{ prompt: "task 1" }, { prompt: "task 2" }];

    const result = await batchGenerate(
      {
        items,
        outDir: dir,
        onProviderCooldown: (ev) => cooldownEvents.push(ev),
      },
      cfg,
    );

    assert.equal(result.completed, 2);
    assert.equal(result.failed, 0);
    assert.equal(p1Calls, 1, "mock-cd-1 should be put on cooldown after first rate limit error");
    assert.equal(p2Calls, 2, "mock-cd-2 should fulfill both tasks after mock-cd-1 cools down");
    assert.equal(cooldownEvents.length, 1);
    assert.equal(cooldownEvents[0].provider, "mock-cd-1");
  } finally {
    delete PROVIDERS["mock-cd-1"];
    delete PROVIDERS["mock-cd-2"];
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp tools/list includes batch_generate_images and handles batch execution", async () => {
  const { handleRequest } = await import("../src/mcp.js");
  const listResp = await handleRequest({ id: 1, method: "tools/list" });
  const tools = listResp.result.tools;
  const batchTool = tools.find((t) => t.name === "batch_generate_images");
  assert.ok(batchTool, "tools/list must include batch_generate_images");
  assert.ok(batchTool.inputSchema.properties.prompts);
  assert.ok(batchTool.inputSchema.properties.items);
});

test("cli batch dry-run prints multiple items and concurrency across backends", async () => {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const bin = fileURLToPath(new URL("../bin/brushrouter.js", import.meta.url));
  // A clean runner has no ready backend, so concurrency is undefined there.
  // Give the child a fal key: probe() reports available with a key present and
  // (dry-run) never contacts the API, so concurrency >= 1 holds everywhere.
  const child = spawn(process.execPath, [bin, "batch", "prompt alpha", "prompt beta", "--dry-run", "--json"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, BRUSHROUTER_FAL_KEY: "br-test-fake-key-not-real" },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  await new Promise((resolve) => child.on("close", resolve));
  const parsed = JSON.parse(out);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.totalItems, 2);
  assert.equal(parsed.items[0].prompt, "prompt alpha");
  assert.equal(parsed.items[1].prompt, "prompt beta");
  assert.ok(parsed.concurrency >= 1);
});

test("batchGenerate with retainBuffers: false clears in-memory buffer references", async () => {
  const { batchGenerate, PROVIDERS } = await import("../src/router.js");
  const dir = mkdtempSync(join(tmpdir(), "br-batch-mem-"));

  PROVIDERS["mock-mem"] = {
    id: "mock-mem",
    async probe() {
      return { available: true };
    },
    async generate() {
      return { buffer: PNG, meta: { model: "fast-mem" } };
    },
  };

  try {
    const cfg = {
      priority: ["mock-mem"],
      providers: { "mock-mem": { enabled: true } },
    };

    const result = await batchGenerate(
      {
        items: [{ prompt: "sample prompt 1" }, { prompt: "sample prompt 2" }],
        outDir: dir,
        retainBuffers: false,
      },
      cfg,
    );

    assert.equal(result.completed, 2);
    assert.equal(result.failed, 0);
    for (const r of result.results) {
      assert.equal(r.buffer, null, "in-memory buffer must be null when retainBuffers is false");
      assert.ok(r.savedPath, "savedPath must exist");
      assert.ok(existsSync(r.savedPath), "file must exist on disk");
      assert.equal(readFileSync(r.savedPath).length, PNG.length);
    }
  } finally {
    delete PROVIDERS["mock-mem"];
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendTailed accumulates below the cap and trims on line boundaries", () => {
  let s = "";
  for (const c of ["line1\n", "line2\n", "line3\n"]) s = appendTailed(s, c, 64);
  assert.equal(s, "line1\nline2\nline3\n");
  // Force a trim: chunks must be kept whole, last content wins.
  const big = "x".repeat(60) + "\n";
  for (const c of [big, "kept\n"]) s = appendTailed(s, c, 32);
  assert.equal(s, "kept\n");
  assert.ok(s.length <= 32 + 60, "retained length stays bounded by cap + one chunk");
  // A single line larger than the cap is clipped rather than retained.
  s = appendTailed("", "y".repeat(400), 32);
  assert.equal(s.length, 32);
});

// --- Security caps: unbounded input must be refused, not OOM'd on ---

test("readImageAsDataUrl rejects oversized files", () => {
  const dir = mkdtempSync(join(tmpdir(), "br-test-"));
  try {
    const p = join(dir, "big.png");
    const big = Buffer.alloc(MAX_REF_IMAGE_BYTES + 1024, 0); // 1KB over the cap
    PNG.copy(big, 0);
    writeFileSync(p, big);
    assert.throws(() => readImageAsDataUrl(p), /reference image too large/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readImageAsDataUrl rejects special files (no EOF, unbounded read)", () => {
  // /dev/null exists everywhere and fstat reports a non-regular file.
  assert.throws(() => readImageAsDataUrl("/dev/null"), /not a regular file/);
});

test("readImageAsDataUrl accepts a small valid image", () => {
  const dir = mkdtempSync(join(tmpdir(), "br-test-"));
  try {
    const p = join(dir, "ok.png");
    writeFileSync(p, PNG);
    const dataUrl = readImageAsDataUrl(p);
    assert.match(dataUrl, /^data:image\/png;base64,/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBodyCapped refuses payloads over the limit", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1024));
      controller.enqueue(new Uint8Array(1024));
      controller.close();
    },
  });
  await assert.rejects(
    () => readBodyCapped({ body: stream }, 1024),
    /download limit/,
  );
});

test("readBodyCapped returns the full body under the limit", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(512));
      controller.enqueue(new Uint8Array(512));
      controller.close();
    },
  });
  const buf = await readBodyCapped({ body: stream }, 1024 * 1024);
  assert.equal(buf.length, 1024);
});

test("pngSize reads width/height out of the IHDR chunk", () => {
  // A minimal PNG header: 8-byte signature + 4 length + "IHDR" + w/h at 16/20.
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(1672, 16);
  png.writeUInt32BE(941, 20);
  assert.deepEqual(pngSize(png), { width: 1672, height: 941 });
  assert.equal(pngSize(JPEG), null);
  assert.equal(pngSize(null), null);
  assert.equal(pngSize(Buffer.alloc(12, 0x89)), null); // truncated
});

test("appendSizeHint appends aspect-ratio wording and leaves auto alone", () => {
  assert.equal(appendSizeHint("a red fox", "1672x941"),
    "a red fox Generate the image with a width of 1672 pixels and a height of 941 pixels (16:9 aspect ratio).");
  assert.equal(appendSizeHint("a red fox", "1024x1024"),
    "a red fox Generate the image with a width of 1024 pixels and a height of 1024 pixels (1:1 aspect ratio).");
  assert.equal(appendSizeHint("a red fox", "auto"), "a red fox");
  assert.equal(appendSizeHint("a red fox", undefined), "a red fox");
  assert.equal(appendSizeHint("a red fox", "1024 x 768"),
    "a red fox Generate the image with a width of 1024 pixels and a height of 768 pixels (4:3 aspect ratio).");
});

// --- gptweb2api sidecar provider ---

import { gptweb2apiProvider, resolveBinaryPath, sidecarDir, shutdownSidecar } from "../src/providers/gptweb2api.js";
import { readAuth } from "../src/providers/codex.js";

test("gptweb2api: route is registered and sits before custom-http", async () => {
  assert.ok(PROVIDERS.gptweb2api, "provider not registered");
  assert.ok(PROVIDERS.gptweb2api.supportsImages === false);
  const enabled = { ...DEFAULT_CONFIG, providers: {} };
  for (const id of Object.keys(DEFAULT_CONFIG.providers)) enabled.providers[id] = { enabled: true };
  const order = await planAttemptOrder(enabled);
  const g = order.indexOf("gptweb2api");
  const ch = order.indexOf("custom-http");
  assert.ok(g >= 0 && ch > g, `expected gptweb2api before custom-http, got [${order.join(", ")}]`);
  assert.equal(DEFAULT_CONFIG.providers.gptweb2api.enabled, false, "must be off by default");
});

test("gptweb2api: binary resolution honours bin override and config dir", () => {
  assert.equal(resolveBinaryPath({ bin: "/x/gw" }), "/x/gw");
  const p = resolveBinaryPath({});
  assert.ok(p.endsWith("gptweb2api") || p.endsWith("gptweb2api.exe"), `unexpected default bin path ${p}`);
  assert.ok(p.startsWith(sidecarDir()));
});

test("gptweb2api: probe reports vendor step when the binary is missing", async () => {
  const r = await gptweb2apiProvider.probe({ bin: "/nonexistent-dir/gw-binary" });
  assert.equal(r.available, false);
  assert.equal(r.auth, "vendor");
  assert.match(r.detail, /vendor gptweb2api/);
});

test("gptweb2api: probe tracks local credential presence once vendored", async () => {
  const fake = join(tmpdir(), `br-fake-gw-${Date.now()}`);
  writeFileSync(fake, "not-a-real-binary");
  try {
    // readAuth() throws when no credential exists (clean runners); the sibling
    // concurrent-spawn test skips in that case — do the same here.
    let hasAuth = false;
    try { hasAuth = Boolean(readAuth({ bin: fake })); } catch {}
    if (!hasAuth) return;
    const r = await gptweb2apiProvider.probe({ bin: fake });
    assert.equal(r.available, Boolean(readAuth({ bin: fake })), "probe availability must mirror readAuth result");
    if (r.available) assert.equal(r.auth, "builtin");
  } finally {
    rmSync(fake, { force: true });
  }
});

test("gptweb2api: generate rejects reference images loudly", async () => {
  await assert.rejects(
    () => gptweb2apiProvider.generate({ prompt: "x", images: ["/tmp/a.png"] }, {}),
    /text-to-image/,
  );
});

// Regression: the provider runs at concurrency 2, so two items can hit a cold
// sidecar in the same tick. Concurrent cold starts must collapse into ONE
// gateway process, not two (the second overwrite of `live` leaks the first).
test("gptweb2api: concurrent cold generates spawn exactly one sidecar", async () => {
  let hasAuth = false;
  try { hasAuth = Boolean(readAuth({})); } catch { return; } // no credential on this machine
  if (!hasAuth) return;
  const dir = mkdtempSync(join(tmpdir(), "br-gw-fake-"));
  const spawnLog = join(dir, "spawns.log");
  const fakeBin = join(dir, "fake-gateway.js");
  writeFileSync(fakeBin, [
    "#!/usr/bin/env node",
    "const http = require('node:http');",
    "const { appendFileSync } = require('node:fs');",
    "appendFileSync(process.env.SPAWN_LOG, '1\\n');",
    "const port = Number((process.env.GPTWEB_LISTEN || '').split(':')[1]);",
    "http.createServer((req, res) => {",
    "  if (req.url === '/healthz') { res.end('ok'); return; }",
    "  req.on('data', () => {});",
    "  req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('iVBORw0KGgo=', 'base64').toString('base64') }] })); });",
    "}).listen(port, '127.0.0.1');",
    "",
  ].join("\n"), "utf8");
  chmodSync(fakeBin, 0o755);
  process.env.SPAWN_LOG = spawnLog;
  try {
    const cfg = { bin: fakeBin, timeoutMs: 10000 };
    const [r1, r2] = await Promise.allSettled([
      gptweb2apiProvider.generate({ prompt: "a" }, cfg),
      gptweb2apiProvider.generate({ prompt: "b" }, cfg),
    ]);
    const spawnCount = (readFileSync(spawnLog, "utf8").match(/\n/g) || []).length;
    assert.equal(spawnCount, 1, `expected one sidecar spawn, saw ${spawnCount}`);
    assert.equal(r1.status, "fulfilled", `first generate failed: ${r1.reason}`);
    assert.equal(r2.status, "fulfilled", `second generate failed: ${r2.reason}`);
  } finally {
    delete process.env.SPAWN_LOG;
    shutdownSidecar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP find_image_prompts supports format: json with structured metadata", async () => {
  const { handlePromptToolCall } = await import("../src/mcp.js");
  const res = await handlePromptToolCall({ query: "product hero shot", format: "json" });
  assert.equal(res.isError, false);
  assert.equal(res.content.length, 1);
  const parsed = JSON.parse(res.content[0].text);
  assert.ok(Array.isArray(parsed.recipes));
  assert.ok(parsed.recipes.length > 0);
  const top = parsed.recipes[0];
  assert.ok(top.id);
  assert.ok(top.slotOptions);
  assert.ok(Array.isArray(top.fillMe));
  assert.ok(Array.isArray(top.missing));

  // Full call returns clean prompt field
  const fullRes = await handlePromptToolCall({
    id: "social-ad",
    format: "json",
    full: true,
    values: { subject: "tea cup", text: "WARM" },
  });
  const fullParsed = JSON.parse(fullRes.content[0].text);
  const fullRecipe = fullParsed.recipes[0];
  assert.ok(fullRecipe.prompt);
  assert.match(fullRecipe.prompt, /tea cup/);
  assert.match(fullRecipe.prompt, /"WARM"/);
  assert.ok(!fullRecipe.prompt.includes("Worked example:"));
  assert.ok(!fullRecipe.prompt.includes("1 recipe"));
});

test("CLI prompts --prompt-only and --raw output clean filled prompt text", async () => {
  const { execFileSync } = await import("node:child_process");
  const bin = join(process.cwd(), "bin", "brushrouter.js");
  const out = execFileSync(
    process.execPath,
    [bin, "prompts", "--id", "social-ad", "--set", "subject=espresso", "--set", "text=CAFFEINE", "--prompt-only"],
    { encoding: "utf8" },
  );
  assert.match(out, /Create a 1:1 social media advertisement for espresso\./);
  assert.match(out, /"CAFFEINE"/);
  assert.ok(!out.includes("Slots:"));
  assert.ok(!out.includes("Worked example"));
  assert.ok(!out.includes("social-ad (recipe"));

  const rawOut = execFileSync(
    process.execPath,
    [bin, "prompts", "--id", "social-ad", "--set", "subject=espresso", "--set", "text=CAFFEINE", "--raw"],
    { encoding: "utf8" },
  );
  assert.equal(rawOut, out);
});

test("gemini run() declares stdout and survives a child that writes output", async () => {
  // Regression: `stdout` was never declared in run(), so the first data chunk
  // threw a ReferenceError from inside the handler and killed the process
  // before generate() could settle.
  const { geminiProvider } = await import("../src/providers/gemini.js");
  const dir = mkdtempSync(join(tmpdir(), "br-gemini-run-"));
  const cli = join(dir, "fake-gemini-cli.js");
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on("uncaughtException", onUncaught);
  try {
    writeFileSync(
      cli,
      `#!${process.execPath}\nconsole.log("generating image -> /nonexistent/${"x"}.png");\nconsole.error("no image produced");\nprocess.exit(3);\n`,
    );
    chmodSync(cli, 0o755);
    // The child produces no image, so generate() rejects — what matters is that
    // it rejects with a real cli error instead of crashing on a ReferenceError.
    await assert.rejects(
      () => geminiProvider.generate({ prompt: "a red fox" }, { cli, timeoutMs: 30000 }),
      (err) => {
        assert.ok(!/is not defined/.test(err.message), `unexpected ReferenceError: ${err.message}`);
        assert.match(err.message, /produced no image/i);
        return true;
      },
    );
    assert.equal(uncaught.length, 0, `uncaught exception escaped: ${uncaught[0]}`);
  } finally {
    process.off("uncaughtException", onUncaught);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("batchGenerate settles with per-item failures when every provider stays rate limited", async () => {
  // Regression: the cooldown retry timer was unref'd, so when nothing else held
  // the event loop open Node exited (code 13) with the batch promise unsettled.
  const { batchGenerate, PROVIDERS } = await import("../src/router.js");
  const dir = mkdtempSync(join(tmpdir(), "br-batch-rl-"));

  let calls = 0;
  PROVIDERS["mock-rl"] = {
    id: "mock-rl",
    supportsImages: true,
    async probe() {
      return { available: true };
    },
    async generate() {
      calls++;
      const err = new Error("429 too many requests");
      err.code = "RATE_LIMIT";
      throw err;
    },
  };

  try {
    const cfg = {
      priority: ["mock-rl"],
      providers: { "mock-rl": { enabled: true } },
    };
    const result = await batchGenerate(
      {
        items: [{ prompt: "a" }, { prompt: "b" }],
        outDir: dir,
        cwd: dir,
        provider: "mock-rl",
        cooldownMs: 40,
      },
      cfg,
    );

    assert.equal(result.total, 2);
    assert.equal(result.completed, 0);
    assert.equal(result.failed, 2, "every item must be reported as failed, not lost");
    assert.equal(result.completed + result.failed, result.total);
    assert.equal(calls, 2);
    for (const r of result.results) {
      assert.ok(r, "no hole in results");
      assert.equal(r.ok, false);
      assert.equal(r.code, "RATE_LIMIT");
    }
  } finally {
    delete PROVIDERS["mock-rl"];
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a throwing onItemComplete cannot corrupt batch accounting or drop items", async () => {
  // Regression: onItemComplete ran inside the success `try`, so its throw fell
  // into the catch, counted the item as failed too, and left a queued item
  // undispatched (provider called twice for three prompts).
  const { batchGenerate, PROVIDERS } = await import("../src/router.js");
  const dir = mkdtempSync(join(tmpdir(), "br-batch-cb-"));

  const executed = [];
  PROVIDERS["mock-cb"] = {
    id: "mock-cb",
    async probe() {
      return { available: true };
    },
    async generate({ prompt }) {
      executed.push(prompt);
      return { buffer: PNG, meta: { model: "mock" } };
    },
  };

  try {
    const cfg = {
      priority: ["mock-cb"],
      providers: { "mock-cb": { enabled: true } },
    };
    const progress = [];
    const failures = [];
    const result = await batchGenerate(
      {
        items: [{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }],
        outDir: dir,
        cwd: dir,
        provider: "mock-cb",
        onProgress: () => {
          throw new Error("progress boom");
        },
        onItemComplete: () => {
          throw new Error("complete boom");
        },
        onItemFail: (f) => {
          failures.push(f);
          throw new Error("fail boom");
        },
      },
      cfg,
    );
    void progress;

    assert.equal(result.total, 3);
    assert.equal(executed.length, 3, "every prompt must reach the provider");
    assert.deepEqual(executed, ["a", "b", "c"]);
    assert.equal(result.completed, 3);
    assert.equal(result.failed, 0);
    assert.equal(result.completed + result.failed, result.total);
    assert.equal(failures.length, 0);
    for (const r of result.results) {
      assert.ok(r, "no hole in results");
      assert.equal(r.ok, true);
      assert.ok(existsSync(r.savedPath));
    }
  } finally {
    delete PROVIDERS["mock-cb"];
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// REGRESSIONS: redaction, key-store recovery, and discovery caching.
// ---------------------------------------------------------------------------

test("redactValue masks a secret-named field whatever its type or length", async () => {
  // Regression: the guard also required `typeof v === "string"` and
  // `v.length >= MIN_REGISTRY_LEN`, so short passwords and non-strings leaked and
  // the doc comment's "replaced wholesale" promise was false.
  const { redactValue, redact, registerSecret } = await import("../src/util/redact.js");

  for (const [label, input, pick] of [
    ["short password", { password: "hunter2" }, (o) => o.password],
    ["short api_key", { api_key: "abc123" }, (o) => o.api_key],
    ["nested cookie", { auth: { cookie: "sessionid=abcdefghijklmnop123456" } }, (o) => o.auth.cookie],
    ["accessKey", { accessKey: "AKIAIOSFODNN7EXAMPLE" }, (o) => o.accessKey],
    ["passwd", { passwd: "p" }, (o) => o.passwd],
    ["authorization", { authorization: "Basic abc" }, (o) => o.authorization],
    ["privateKey", { privateKey: "-----BEGIN" }, (o) => o.privateKey],
    ["sessionid", { sessionid: "s" }, (o) => o.sessionid],
    ["Buffer value", { apiKey: Buffer.from("opaquecredentialvalue123") }, (o) => o.apiKey],
    ["object value", { credential: { user: "u", pass: "p" } }, (o) => o.credential],
  ]) {
    const out = redactValue(input);
    const got = pick(out);
    assert.equal(got, "***", `${label} was not masked: ${JSON.stringify(out)}`);
    assert.ok(!JSON.stringify(out).includes("hunter2"), `${label} leaked its body`);
  }

  // A registered secret is still replaced by the same placeholder it gets
  // anywhere else, so nothing downstream can tell the two paths apart.
  registerSecret("knownsecretvalue123456");
  assert.equal(redactValue({ token: "knownsecretvalue123456" }).token, "***");
  assert.equal(redact("prefix knownsecretvalue123456 suffix"), "prefix *** suffix");

  // A field whose name merely contains a secret-ish word must survive: these are
  // counters and schema keywords, and masking them would corrupt tool schemas.
  const safe = { maxTokens: 4096, tokenCount: 7, tokens: ["a"], prompt: "hi" };
  assert.deepEqual(redactValue(safe), safe);
  const schema = { inputSchema: { properties: { maxTokens: { type: "integer" } } } };
  assert.equal(redactValue(schema).inputSchema.properties.maxTokens.type, "integer");
});

test("redaction knows the AWS access key id shape", async () => {
  // Regression: AKIA… matched no shape pattern, so a SigV4 key echoed back by a
  // custom endpoint reached the model intact.
  const { redact, redactValue } = await import("../src/util/redact.js");
  const akia = "AKIAIOSFODNN7EXAMPLE";
  assert.ok(!redact(`creds ${akia} used`).includes("IOSFODNN7EXAMPLE"), "AWS key id leaked");
  // And it is caught even when it sits under an innocent key name.
  assert.ok(!JSON.stringify(redactValue({ note: akia })).includes("IOSFODNN7EXAMPLE"));
});

test("safeParseMessage cannot be broken out of with a quote in the payload", async () => {
  // Regression: the scrubber paired quotes with /"[^"]*"/, but V8 echoes the
  // payload without escaping it, so a `"` inside the payload ended the match and
  // the tail survived. Anything a truncated file contains must not survive.
  const { safeParseMessage } = await import("../src/util/redact.js");

  const breakout = 'Unexpected token x, "SECRET"TAILSECRET" is not valid JSON';
  const out = safeParseMessage(new SyntaxError(breakout));
  assert.ok(!out.includes("SECRET"), `payload survived: ${out}`);
  assert.ok(!out.includes("TAIL"), `tail after the first quote survived: ${out}`);

  // Every message that carries a quote is truncated at the first one, so no
  // payload fragment can appear no matter where the split falls.
  const payloads = [
    '"A"B"',
    '"ONE""TWO"',
    'unterminated "PAYLOADTAIL',
    '"',
    'x "MULTI\nLINE"TAIL',
  ];
  for (const p of payloads) {
    const msg = safeParseMessage(new SyntaxError(`Unexpected token 'x', ${p} is not valid JSON`));
    assert.ok(msg.indexOf("PAYLOAD") === -1 && msg.indexOf("TAIL") === -1, `leaked from ${JSON.stringify(p)}: ${msg}`);
    assert.ok(msg.length <= 200, "message must stay short");
  }

  // Known-secret redaction still runs first, and a message with no quote at all
  // is preserved (the useful part of a real error).
  assert.ok(!safeParseMessage(new SyntaxError("Unexpected end of JSON input")).includes("SECRET"));
  assert.equal(safeParseMessage(new Error("Unexpected end of JSON input")), "Unexpected end of JSON input");
  assert.match(safeParseMessage(new Error("Unexpected end of JSON input")), /Unexpected end of JSON input/);
});

test("a corrupt keys.json is backed up, not silently overwritten", async () => {
  // Regression: a JSON parse failure was caught with `data = {}` and the store
  // was then rewritten unconditionally, so one truncated file destroyed every
  // stored key with no backup and no warning.
  const dir = mkdtempSync(join(tmpdir(), "br-keys-corrupt-"));
  try {
    const keysPath = join(dir, "keys.json");
    // Truncated just after a complete entry: exactly the hand-edit failure mode.
    writeFileSync(
      keysPath,
      '{"openrouter":{"key":"sk-or-v1-existingkey1234567890abcd"}, "fal"',
      { mode: 0o600 },
    );
    const damaged = readFileSync(keysPath, "utf8");

    // Run the save in a child with its own CONFIG_DIR so the module-level KEYS_PATH
    // is the temp store, and capture the warning on stderr.
    const { execFileSync } = await import("node:child_process");
    const script = join(dir, "save.mjs");
    writeFileSync(
      script,
      `import { saveKey } from ${JSON.stringify(join(process.cwd(), "src", "util", "keys.js"))};
       console.log(saveKey("fal", "fal-test-key-abcdefghijklmnop"));\n`,
    );
    const stdout = execFileSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, BRUSHROUTER_CONFIG_DIR: dir },
    });
    assert.match(stdout, /keys\.json/);

    // The new key is written and the store is valid JSON again...
    const after = JSON.parse(readFileSync(keysPath, "utf8"));
    assert.equal(after.fal.key, "fal-test-key-abcdefghijklmnop");

    // ...and the damaged bytes are preserved beside it, byte for byte.
    const { readdirSync } = await import("node:fs");
    const backups = [];
    for (const f of readdirSync(dir)) if (f.startsWith("keys.json.corrupt-")) backups.push(f);
    assert.equal(backups.length, 1, `expected one backup, saw: ${backups.join(", ")}`);
    assert.equal(readFileSync(join(dir, backups[0]), "utf8"), damaged, "backup must preserve the file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing which() result is not cached, and resetDiscoverCache clears it", async () => {
  // Regression: whichSync cached nulls for the life of the process, so `setup`
  // (isOnPath -> npm link -> isOnPath) reported a just-installed binary missing.
  const { isOnPath, resetDiscoverCache } = await import("../src/util/discover.js");
  const dir = mkdtempSync(join(tmpdir(), "br-path-cache-"));
  const binName = `bntest-${process.pid}-cache`;
  const saved = process.env.PATH;
  try {
    resetDiscoverCache();
    process.env.PATH = dir;
    assert.equal(isOnPath(binName), null, "fixture bin must not exist yet");

    // Install it at the same PATH location: a cached miss would still say null.
    writeFileSync(join(dir, binName), "#!/bin/sh\n", { mode: 0o755 });
    assert.equal(isOnPath(binName), join(dir, binName), "a new binary must be found without a reset");

    // A hit is still cached, and resetDiscoverCache() remains an escape hatch
    // for the case where the file changes without the PATH changing.
    rmSync(join(dir, binName));
    assert.equal(isOnPath(binName), join(dir, binName), "a hit keeps being served from cache");
    resetDiscoverCache();
    assert.equal(isOnPath(binName), null, "reset must drop the positive entry too");
  } finally {
    process.env.PATH = saved;
    resetDiscoverCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findCodexCli's memo key covers the environment it actually reads", async () => {
  // Regression: the key held only (explicit, BRUSHROUTER_CODEX_CLI,
  // BRUSHROUTER_APP_DIRS) while the search also follows PATH, APPDATA and cwd, so
  // a mutation of any of those kept serving the pre-change answer.
  const { findCodexCli, resetDiscoverCache } = await import("../src/util/discover.js");
  resetDiscoverCache();
  const before = findCodexCli();
  const dir = mkdtempSync(join(tmpdir(), "br-codex-key-"));
  const savedPath = process.env.PATH;
  try {
    // Pointing PATH at an empty dir must not be answered from the previous key.
    process.env.PATH = dir;
    const after = findCodexCli();
    if (before && before.path && !before.path.startsWith(dir)) {
      assert.notEqual(after?.path, before.path, "PATH change was ignored by the memo key");
    }
    assert.doesNotThrow(() => findCodexCli({ explicit: join(dir, "nope") }));
  } finally {
    process.env.PATH = savedPath;
    resetDiscoverCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Bug-fix regressions: project-config trust, env-aware paths, OAuth callback
// ---------------------------------------------------------------------------

test("a project config cannot choose an executable via providers.*.bin", () => {
  // BUG: `bin` was honoured (src/config.js -> providers.gptweb2api bin -> spawn)
  // but absent from the project-config deny-list, so a checked-in
  // brushrouter.config.json executed its own binary. The trust boundary is now
  // an allow-list, so any leaf that names a program/path/credential is dropped.
  const dir = mkdtempSync(join(tmpdir(), "br-project-bin-"));
  try {
    writeFileSync(
      join(dir, "brushrouter.config.json"),
      JSON.stringify({
        priority: ["gptweb2api"],
        providers: {
          gptweb2api: { enabled: true, bin: "/tmp/evil-gateway", authFile: "/tmp/evil-auth", model: "m" },
        },
      }),
    );
    const cfg = loadConfig({ cwd: dir });
    assert.equal(cfg.providers.gptweb2api.bin, null, "project config chose an executable");
    assert.equal(cfg.providers.gptweb2api.authFile, null, "project config chose a credential file");
    // Behaviour is still project-settable: enabling a route, its order, its model.
    assert.equal(cfg.providers.gptweb2api.enabled, true);
    assert.equal(cfg.providers.gptweb2api.model, "m");
    assert.deepEqual(cfg.priority, ["gptweb2api"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project-config allow-list is not bypassable via __proto__, nesting or arrays", () => {
  const dir = mkdtempSync(join(tmpdir(), "br-project-proto-"));
  try {
    // `__proto__` in JSON is a plain own key, and Object.entries walks it; it
    // must not smuggle an untrusted leaf through. A nested object can't stand in
    // for a scalar leaf either, and an array leaf is not a checked key at all.
    writeFileSync(
      join(dir, "brushrouter.config.json"),
      `{"providers":{"gptweb2api":{"__proto__":{"bin":"/tmp/evil"},"constructor":{"bin":"/tmp/evil"},` +
        `"enabled":[true],"models":{"bin":"/tmp/evil"}}}}`,
    );
    const cfg = loadConfig({ cwd: dir });
    assert.equal(cfg.providers.gptweb2api.bin, null, "a prototype key smuggled an executable through");
    assert.equal(Object.hasOwn(cfg.providers.gptweb2api, "constructor"), false);
    // Non-scalar junk is refused rather than deep-merged into the config.
    assert.notEqual(cfg.providers.gptweb2api.enabled?.bin, "/tmp/evil");
    assert.equal(typeof cfg.providers.gptweb2api.models, "object");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config path getters honour the BRUSHROUTER_* overrides", async () => {
  // BUG: loadConfig() read the env-aware getter while `init` / saveKey() used
  // frozen constants built from homedir(), so the two disagreed.
  const { getConfigDir, getKeysPath, getUserConfigPath } = await import("../src/config.js");
  const dir = mkdtempSync(join(tmpdir(), "br-paths-"));
  const saved = {
    dir: process.env.BRUSHROUTER_CONFIG_DIR,
    keys: process.env.BRUSHROUTER_KEYS_PATH,
    user: process.env.BRUSHROUTER_USER_CONFIG,
  };
  try {
    process.env.BRUSHROUTER_CONFIG_DIR = dir;
    process.env.BRUSHROUTER_KEYS_PATH = join(dir, "k.json");
    process.env.BRUSHROUTER_USER_CONFIG = join(dir, "c.json");
    assert.equal(getConfigDir(), dir);
    assert.equal(getKeysPath(), join(dir, "k.json"));
    assert.equal(getUserConfigPath(), join(dir, "c.json"));
    // The exported constants resolve THROUGH the getters rather than a second
    // homedir() computation, so they can never name a different directory. They
    // are import-time snapshots (documented as legacy/non-authoritative), so the
    // derivation is proved on a fresh module instance loaded with this env.
    const fresh = await import(`../src/config.js?snapshot=${Date.now()}`);
    assert.equal(fresh.CONFIG_DIR, fresh.getConfigDir());
    assert.equal(fresh.KEYS_PATH, fresh.getKeysPath());
    assert.equal(fresh.USER_CONFIG_PATH, fresh.getUserConfigPath());
    assert.equal(fresh.CONFIG_DIR, dir);
    assert.equal(fresh.KEYS_PATH, join(dir, "k.json"));
    assert.equal(fresh.USER_CONFIG_PATH, join(dir, "c.json"));
  } finally {
    for (const [k, v] of [
      ["BRUSHROUTER_CONFIG_DIR", saved.dir],
      ["BRUSHROUTER_KEYS_PATH", saved.keys],
      ["BRUSHROUTER_USER_CONFIG", saved.user],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runLogin writes auth.json 0600 in a 0700 dir even when both already existed looser", async () => {
  // BUG: mkdir's mode only applies at creation and writeFile's mode only at
  // creation, so an existing 0755 dir / 0644 auth.json kept its permissions
  // while the CLI printed "(mode 0600)". Mirrors src/util/keys.js.
  const { runLogin } = await import("../src/oauth.js");
  const { statSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "br-oauth-perm-"));
  const authPath = join(dir, "auth.json");
  chmodSync(dir, 0o755);
  writeFileSync(authPath, "{}");
  chmodSync(authPath, 0o644);

  const claim = { "https://api.openai.com/auth": { chatgpt_account_id: "a-1", chatgpt_plan_type: "plus" } };
  const idToken = `x.${Buffer.from(JSON.stringify(claim)).toString("base64url")}.y`;
  // Stand in for the two network hops: the token endpoint (fetch) and the
  // browser (open) — the callback itself is the real localhost server.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) =>
    String(url).includes("oauth/token")
      ? Promise.resolve(
          new Response(JSON.stringify({ access_token: "acc", refresh_token: "ref", id_token: idToken }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        )
      : realFetch(url, init);
  const hit = async (qs) => {
    for (let i = 0; i < 60; i++) {
      try {
        return await realFetch(`http://127.0.0.1:1455/auth/callback?${qs}`, {
          headers: { connection: "close" },
          signal: AbortSignal.timeout(4000),
        });
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    throw new Error("OAuth callback server never came up");
  };
  try {
    const out = await runLogin({
      configDir: dir,
      log: () => {},
      open: async (u) => {
        setTimeout(() => {
          hit(`code=C&state=${encodeURIComponent(new URL(u).searchParams.get("state"))}`).catch(() => {});
        }, 0);
      },
    });
    assert.equal(out.path, authPath);
    assert.equal(statSync(dir).mode & 0o777, 0o700, "auth dir was left world-traversable");
    assert.equal(statSync(authPath).mode & 0o777, 0o600, "auth.json was left world-readable");
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OAuth callback rejects on ?error= instead of resolving a null code", async () => {
  // BUG: it resolved with { code: null }, and the caller then POSTed
  // grant_type=authorization_code&code=null and showed an opaque 400.
  const { listenForCallback } = await import("../src/oauth.js");
  const settled = listenForCallback("STATE-1").then(
    (v) => ({ value: v }),
    (e) => ({ error: e.message }),
  );
  const resp = await fetchCallback("error=access_denied&state=STATE-1");
  const body = await resp.text();
  const r = await settled;
  assert.equal(r.value, undefined, "an ?error= callback must not resolve");
  assert.match(r.error, /sign-in failed: access_denied/);
  assert.doesNotMatch(body, /complete/i, "a failed sign-in rendered the success page");
});

test("OAuth callback never renders success for a bad state and frees the port", async () => {
  // BUG: the success HTML was written before the state comparison, so a forged
  // callback with a wrong state still said "sign-in complete".
  const { listenForCallback } = await import("../src/oauth.js");
  const settled = listenForCallback("EXPECTED").then(
    (v) => ({ value: v }),
    (e) => ({ error: e.message }),
  );
  const resp = await fetchCallback("code=abc&state=WRONG");
  const body = await resp.text();
  const r = await settled;
  assert.equal(r.value, undefined);
  assert.match(r.error, /state mismatch/);
  assert.doesNotMatch(body, /complete/i, "a bad-state callback rendered the success page");
  // finish() closes the listener; a bind must succeed immediately afterwards.
  const net = await import("node:net");
  await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(1455, "127.0.0.1", () => s.close(resolve));
  });
});

test("OAuth callback still resolves the code on a good state", async () => {
  const { listenForCallback } = await import("../src/oauth.js");
  const settled = listenForCallback("GOOD-STATE").then(
    (v) => ({ value: v }),
    (e) => ({ error: e.message }),
  );
  const resp = await fetchCallback("code=xyz&state=GOOD-STATE");
  const body = await resp.text();
  const r = await settled;
  assert.equal(r.error, undefined);
  assert.equal(r.value.code, "xyz");
  assert.match(body, /complete/i);
});

// The callback server starts asynchronously; retry briefly so the test is not
// racing server.listen().
async function fetchCallback(qs, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(`http://127.0.0.1:1455/auth/callback?${qs}`, {
        headers: { connection: "close" },
        signal: AbortSignal.timeout(4000),
      });
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error("OAuth callback server never came up");
}

// ---------------------------------------------------------------------------
// JSON-RPC framing. The envelope is protocol, not payload: an id or a
// progressToken that comes back altered makes the response unmatchable, so these
// assert the round-trip through the real `serve` process.
// ---------------------------------------------------------------------------

// Drives `brushrouter serve` over stdio with the given newline-delimited lines
// and resolves every parsed stdout line once the child exits. `cwd` matters: the
// project config is read relative to the process's working directory, so a test
// that seeds one must spawn there or the config is silently ignored.
async function runServe(lines, env = {}, { cwd } = {}) {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const bin = fileURLToPath(new URL("../bin/brushrouter.js", import.meta.url));
  const child = spawn(process.execPath, [bin, "serve"], { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  for (const line of lines) child.stdin.write(line + "\n");
  child.stdin.end();
  const code = await new Promise((r) => child.on("close", r));
  return { code, err, out, msgs: out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}

test("MCP echoes request ids and progressTokens verbatim, redacting only the payload", async () => {
  // A redacted id can never match its request, so the client hangs forever.
  // 'sk-' shaped on purpose: redactValue() rewrites it, and the envelope used to
  // run through redactValue() wholesale.
  const id = "sk-abcdefghijklmnop12345";
  const { msgs } = await runServe([
    JSON.stringify({ jsonrpc: "2.0", id, method: "ping" }),
    // A second secret-shaped id, this time alongside a payload that DOES echo
    // the argument back: image_result names the jobId it could not find, so the
    // response must show the id verbatim and the message redacted in the very
    // same frame.
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "image_result", arguments: { jobId: "sk-abcdefghijklmnop12345" } } }),
  ]);
  const ping = msgs.find((m) => m.id === id);
  assert.ok(ping, `id was rewritten; got ids ${JSON.stringify(msgs.map((m) => m.id))}`);
  assert.deepEqual(ping.result, {});

  // The payload half is still redacted — this is a backstop, not a bypass.
  const call = msgs.find((m) => m.id === 2);
  const text = call.result.content[0].text;
  assert.match(text, /unknown jobId/, `unexpected reply: ${text}`);
  assert.ok(!text.includes("sk-abcdefghijklmnop12345"), `secret leaked through the payload: ${text}`);
  assert.match(text, /sk-\*\*\*/, `payload was not redacted: ${text}`);
});

test("MCP progressToken survives verbatim in progress notifications", async () => {
  const { createServer } = await import("node:http");
  const token = "sk-progress-abcdefghijklmnop";
  const server = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ url: `data:image/png;base64,${PNG.toString("base64")}` }] }));
    }, 150);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "br-token-"));
  writeFileSync(
    join(dir, "brushrouter.config.json"),
    JSON.stringify({ priority: ["custom-http"], providers: { "custom-http": { enabled: true } } }),
  );
  try {
    const { msgs } = await runServe(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "generate_image", arguments: { prompt: "x", provider: "custom-http", async: true, out: join(dir, "t.png") }, _meta: { progressToken: token } },
        }),
      ],
      { BRUSHROUTER_CUSTOM_URL: `http://127.0.0.1:${server.address().port}/g` },
      // The project config is resolved from cwd, so seeding it here only works
      // if the child actually runs in this directory.
      { cwd: dir },
    );
    const progress = msgs.filter((m) => m.method === "notifications/progress");
    assert.ok(progress.length > 0, `no progress notification was emitted; frames: ${JSON.stringify(msgs.map((m) => m.method || m.id))}`);
    for (const n of progress) assert.equal(n.params.progressToken, token, "progressToken was rewritten");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP parse errors do not echo the client's input back", async () => {
  // V8 quotes the offending slice: 'Unexpected token S, "SECRETSETTING" is not...'
  const { msgs } = await runServe(["SECRETSETTING"]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].error.code, -32700);
  assert.ok(!msgs[0].error.message.includes("SECRETSETTING"), `raw input echoed: ${msgs[0].error.message}`);
  assert.match(msgs[0].error.message, /Parse error/);
});

test("MCP notifications never get a response, but still run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "br-notify-"));
  const out = join(dir, "notified.png");
  const { createServer } = await import("node:http");
  // A `data:` URL at the default `data.0.url` response path is the one shape
  // custom-http consumes with no extra config, so generation really succeeds.
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ url: `data:image/png;base64,${PNG.toString("base64")}` }] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { msgs } = await runServe(
      [
        // Notification-form ping: no id, so no reply.
        JSON.stringify({ jsonrpc: "2.0", method: "ping" }),
        // Notification-form tools/call: must run (the file appears) and still
        // emit nothing. An id-less frame here was invalid JSON-RPC.
        JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "generate_image", arguments: { prompt: "n", provider: "custom-http", out } } }),
        // A real request afterwards proves the process is still healthy.
        JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }),
      ],
      // custom-http ships disabled (it needs an endpoint), so the route must be
      // opted into as well as pointed at — `enabled: false` is a capability
      // switch, and naming the route explicitly no longer bypasses it.
      { BRUSHROUTER_CUSTOM_URL: `http://127.0.0.1:${server.address().port}/g`, BRUSHROUTER_ENABLE: "custom-http" },
      // cwd must be the seeded dir: the project config is resolved from it, and
      // without it custom-http is never enabled and the tool cannot run.
      { cwd: dir },
    );
    const framesWithoutId = msgs.filter((m) => !("id" in m) && m.method !== "notifications/progress" && m.method !== "notifications/tasks/status");
    assert.deepEqual(framesWithoutId, [], `notification got a response: ${JSON.stringify(framesWithoutId)}`);
    assert.ok(msgs.some((m) => m.id === 9), "the following request went unanswered");
    // The tool did actually execute: no response, but the image landed.
    assert.ok(existsSync(out), `notification-form tools/call did not run (dir: ${JSON.stringify(readdirSync(dir))})`);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP answers a batch array with one response per request", async () => {
  const { msgs } = await runServe([
    JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" }, // notification: dropped
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]),
    "[]",
  ]);
  const batchReply = msgs.find((m) => Array.isArray(m));
  assert.ok(batchReply, `batch was rejected; got ${JSON.stringify(msgs)}`);
  assert.deepEqual(batchReply.map((m) => m.id), [1, 2], "wrong per-element responses");
  assert.ok(batchReply[1].result.tools.length > 0, "tools/list in a batch returned no tools");
  // An empty batch is invalid on its own, not an answerable list.
  assert.equal(msgs.filter((m) => !Array.isArray(m)).pop()?.error?.code, -32600);
});

test("MCP rejects batch items without a prompt instead of generating a blank image", async () => {
  const { handleRequest } = await import("../src/mcp.js");
  const dir = mkdtempSync(join(tmpdir(), "br-batch-validate-"));
  writeFileSync(
    join(dir, "brushrouter.config.json"),
    JSON.stringify({ priority: ["mock-norm"], providers: { "mock-norm": { enabled: true } } }),
  );
  const { PROVIDERS } = await import("../src/router.js");
  const prompts = [];
  PROVIDERS["mock-norm"] = {
    id: "mock-norm",
    supportsImages: true,
    async probe() {
      return { available: true };
    },
    async generate({ prompt }) {
      prompts.push(prompt);
      return { buffer: PNG, meta: { model: "m" } };
    },
  };
  const call = (id, args) =>
    handleRequest({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "batch_generate_images", arguments: args } }, { cwd: dir });
  try {
    for (const items of [[{ size: "1024x1024" }], [{}], [{ prompt: "   " }], [42]]) {
      const r = await call(1, { items, outDir: join(dir, "out") });
      assert.equal(r.result.isError, true, `accepted a promptless item: ${JSON.stringify(items)}`);
      assert.match(r.result.content[0].text, /items\[0\]/, `error did not name the index: ${r.result.content[0].text}`);
    }
    assert.deepEqual(prompts, [], "a promptless item reached a provider");

    // A bare string is a prompt, not an object to spread character by character.
    const ok = await call(2, { items: ["a red fox"], outDir: join(dir, "out2") });
    assert.equal(ok.result.isError, false, ok.result.content[0].text);
    assert.deepEqual(prompts, ["a red fox"]);
    assert.match(ok.result.content[0].text, /01-a-red-fox\.png/);
  } finally {
    delete PROVIDERS["mock-norm"];
    rmSync(dir, { recursive: true, force: true });
  }
});

// A live `serve` child for tests that must observe timing (a job finishing
// after its TTL) rather than run a fixed list of lines. `until(pred)` resolves
// the first frame matching pred, including frames that already arrived.
async function serveSession({ env = {}, cwd } = {}) {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const bin = fileURLToPath(new URL("../bin/brushrouter.js", import.meta.url));
  const child = spawn(process.execPath, [bin, "serve"], { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
  const frames = [];
  let buf = "";
  let wake = null;
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        frames.push(JSON.parse(line));
      } catch {
        // A non-JSON line is a bug elsewhere; keep the raw text visible.
        frames.push({ raw: line });
      }
      wake?.();
    }
  });
  child.stderr.on("data", () => {});
  const closed = new Promise((r) => child.on("close", r));
  const until = (pred, ms = 8000) =>
    new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        wake = null;
        reject(new Error(`timed out waiting for a frame matching ${pred}; got ${JSON.stringify(frames)}`));
      }, ms);
      const check = () => {
        const hit = frames.find(pred);
        if (hit) {
          clearTimeout(deadline);
          wake = null;
          resolve(hit);
          return true;
        }
        return false;
      };
      if (check()) return;
      wake = check;
    });
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  const close = async () => {
    child.stdin.end();
    // Never leave the child (or a hung render) holding the suite open.
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    await closed;
    clearTimeout(timer);
  };
  return { child, frames, send, until, close };
}

test("a job slower than the TTL is still collectable when it completes", async () => {
  // The retention clock must start at completion. Measured from creation, any
  // render longer than the TTL was pruned by the .finally() that ran the moment
  // it finished: the image was on disk but image_result said "unknown jobId".
  const { createServer } = await import("node:http");
  // Answer at 3x the TTL below, and use the one response shape custom-http
  // consumes with no extra config: a data: URL at data.0.url.
  const server = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ url: `data:image/png;base64,${PNG.toString("base64")}` }] }));
    }, 600);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "br-slowjob-"));
  writeFileSync(
    join(dir, "brushrouter.config.json"),
    JSON.stringify({ priority: ["custom-http"], providers: { "custom-http": { enabled: true } } }),
  );
  const out = join(dir, "slow.png");
  let session;
  try {
    session = await serveSession({
      cwd: dir,
      env: { BRUSHROUTER_CUSTOM_URL: `http://127.0.0.1:${server.address().port}/g`, BRUSHROUTER_JOB_TTL_MS: "200" },
    });
    session.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "generate_image", arguments: { prompt: "x", provider: "custom-http", async: true, out } } });
    const started = await session.until((f) => f.id === 1);
    const jobId = /job (img_[a-z0-9_]+)/.exec(started.result?.content?.[0]?.text || "")?.[1];
    assert.ok(jobId, `async generate returned no jobId: ${started.result?.content?.[0]?.text}`);

    // Wait for the job to actually finish, then poll immediately: the completion
    // notification proves the promise settled, so the clock has started.
    await session.until((f) => f.method === "notifications/tasks/status" && f.params?.status === "completed");
    session.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "image_result", arguments: { jobId } } });
    const result = await session.until((f) => f.id === 2);
    const text = result.result?.content?.[0]?.text || "";
    assert.equal(result.result?.isError, false, `job was pruned after completing: ${text}`);
    assert.ok(result.result.content.some((b) => b.type === "image"), `no image block returned: ${text}`);
    assert.ok(existsSync(out), "the completed job's file is missing");
  } finally {
    await session?.close();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchWithTimeout keeps its deadline until the body is consumed", async () => {
  // fetch() resolves when HEADERS arrive. Clearing the timer there bounded only
  // the header wait, so a server that sends 200 then stalls held the caller in
  // res.text() forever.
  const { createServer } = await import("node:http");
  const { fetchWithTimeout } = await import("../src/util/common.js");
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    if (req.url === "/stall") {
      res.write("PARTIAL"); // headers + a chunk, then never end
      return;
    }
    res.end("done");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const startedAt = Date.now();
    const res = await fetchWithTimeout(`${base}/stall`, {}, 600);
    assert.equal(res.status, 200);
    assert.ok(Date.now() - startedAt < 600, "the header wait should not consume the whole deadline");

    await assert.rejects(
      () => res.text(),
      (e) => {
        assert.equal(e.code, "TIMEOUT", `expected a clear timeout, got ${e.name}: ${e.message}`);
        assert.match(e.message, /timed out/);
        return true;
      },
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 500 && elapsed < 2500, `body read was not bounded by the deadline (${elapsed}ms)`);

    // A normal body is untouched and must not leave a timer holding the process.
    const okRes = await fetchWithTimeout(`${base}/ok`, {}, 5000);
    assert.equal(await okRes.text(), "done");

    // stream readers (readBodyCapped) are bounded too.
    const { readBodyCapped } = await import("../src/util/common.js");
    const stall = await fetchWithTimeout(`${base}/stall`, {}, 400);
    await assert.rejects(() => readBodyCapped(stall), /timed out/);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// CLI regressions (bin/brushrouter.js). These spawn the real CLI with a temp
// HOME so nothing touches the developer's own config, keys or rules.
// ---------------------------------------------------------------------------

async function cliHarness() {
  const { fileURLToPath } = await import("node:url");
  const { spawnSync } = await import("node:child_process");
  const bin = fileURLToPath(new URL("../bin/brushrouter.js", import.meta.url));
  // A fresh HOME + config/keys per call: BRUSHROUTER_* is the source of truth,
  // and every run must touch nothing outside its own sandbox.
  const makeHome = () => {
    const home = mkdtempSync(join(tmpdir(), "br-cli-home-"));
    return {
      home,
      cfgDir: join(home, "cfg"),
      userConfig: join(home, "cfg", "config.json"),
      keys: join(home, "cfg", "keys.json"),
    };
  };
  const run = (argv, { home, stdin, cwd } = {}) => {
    const env = home || makeHome();
    const r = spawnSync(process.execPath, [bin, ...argv], {
      encoding: "utf8",
      cwd: cwd || tmpdir(),
      input: stdin,
      env: {
        ...process.env,
        HOME: env.home,
        BRUSHROUTER_CONFIG_DIR: env.cfgDir,
        BRUSHROUTER_USER_CONFIG: env.userConfig,
        BRUSHROUTER_KEYS_PATH: env.keys,
        // Keep provider probes cheap and deterministic: no real CLI on PATH.
        PATH: "/usr/bin:/bin",
      },
      timeout: 60000,
    });
    return { ...r, h: env };
  };
  return { bin, makeHome, run };
}

// JSON printed and then process.exit(1) lost most of a piped payload: the CLI
// must exit through exitAfterFlush() so a large `--json` document survives a
// pipe. 700 items makes the payload big enough to cross the pipe buffer.
test("CLI batch --json through a real pipe emits parseable JSON", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { run, makeHome } = await cliHarness();
  const dir = mkdtempSync(join(tmpdir(), "br-batch-json-"));
  const items = Array.from({ length: 700 }, (_, i) => ({
    prompt: `a detailed test prompt number ${i} with enough words to make the JSON payload large`,
  }));
  const input = join(dir, "items.json");
  writeFileSync(input, JSON.stringify(items));
  // spawnSync captures the child's stdout through a pipe, which is exactly the
  // case that used to truncate at the pipe buffer boundary.
  const r = run(["batch", input, "--dry-run", "--json"], { home: makeHome() });
  assert.equal(r.status, 0, `batch --dry-run --json should exit 0, got ${r.status}: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.totalItems, 700);
  assert.equal(parsed.items.length, 700);
  assert.ok(r.stdout.length > 150000, `expected a large payload, got ${r.stdout.length} bytes`);
});

// Regression: `setup --dry-run` ran a real OAuth login, saved keys and flipped
// route flags. A dry run must not create or change a single file.
test("CLI setup --dry-run writes nothing", async () => {
  const { readdirSync } = await import("node:fs");
  const { run, makeHome } = await cliHarness();
  const home = makeHome();
  const cwd = mkdtempSync(join(tmpdir(), "br-dry-cwd-"));
  const before = (() => {
    try {
      return readdirSync(home.home, { recursive: true }).sort();
    } catch {
      return [];
    }
  })();
  const r = run(["setup", "--dry-run"], { home, cwd, stdin: "" });
  assert.equal(r.status, 0, `setup --dry-run should exit 0, got ${r.status}: ${r.stderr}`);
  const after = (() => {
    try {
      return readdirSync(home.home, { recursive: true }).sort();
    } catch {
      return [];
    }
  })();
  // Nothing at all: not the config dir, not config.json, not keys.json, not
  // auth.json. (Other agents' probes may populate HOME on a real machine, so
  // compare before/after rather than asserting emptiness.)
  assert.deepEqual(after, before, `setup --dry-run created files: ${after.filter((f) => !before.includes(f)).join(", ")}`);
  assert.ok(!existsSync(home.cfgDir), "setup --dry-run created the config directory");
  assert.ok(!existsSync(home.userConfig), "setup --dry-run wrote config.json");
  assert.ok(!existsSync(home.keys), "setup --dry-run wrote keys.json");
  assert.ok(!existsSync(join(cwd, "brushrouter-test.png")), "setup --dry-run ran the smoke test");
});

// The real hazard is the interactive half: Phase 2 is only reached with a TTY.
// Fake one, pick "sign in with ChatGPT", and assert the OAuth login is
// described rather than performed.
test("CLI setup --dry-run does not run the interactive login", async () => {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const bin = fileURLToPath(new URL("../bin/brushrouter.js", import.meta.url));
  const { makeHome } = await cliHarness();
  const home = makeHome();
  const dir = mkdtempSync(join(tmpdir(), "br-dry-tty-"));
  const shim = join(dir, "runner.mjs");
  writeFileSync(
    shim,
    `const fake = (s) => {
  Object.defineProperty(s, "isTTY", { value: true, configurable: true });
  if (!s.setRawMode) s.setRawMode = () => {};
  s.isRaw = false; s.columns = 120; s.rows = 40;
};
fake(process.stdin); fake(process.stdout); fake(process.stderr);
process.argv = [process.argv[0], ${JSON.stringify(bin)}, "setup", "--dry-run"];
await import(${JSON.stringify(bin)});
`,
  );
  const child = spawn(process.execPath, [shim], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: home.home,
      BRUSHROUTER_CONFIG_DIR: home.cfgDir,
      BRUSHROUTER_USER_CONFIG: home.userConfig,
      BRUSHROUTER_KEYS_PATH: home.keys,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  // Answer every prompt: pick "Sign in with ChatGPT" (the mutating branch), then
  // decline MCP wiring, rules injection and the smoke test so setup can finish.
  const answers = [];
  const plan = [
    [/Select \[1-4\]/, "1\n"],
    [/Wire brushrouter MCP into/, "n\n"],
    [/Inject clean brushrouter guidance/, "n\n"],
    [/Generate a quick test image/, "n\n"],
  ];
  const iv = setInterval(() => {
    for (let i = answers.length; i < plan.length; i++) {
      if (plan[i][0].test(out)) {
        child.stdin.write(plan[i][1]);
        answers.push(i);
        break;
      }
    }
  }, 100);
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("timeout");
    }, 20000);
    child.on("exit", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  clearInterval(iv);
  assert.notEqual(code, "timeout", "setup --dry-run hung at the provider prompt");
  assert.match(out, /Dry run: would sign in to ChatGPT/i, `the login was not dry-guarded:\n${out.slice(-600)}`);
  assert.ok(!existsSync(join(home.cfgDir, "auth.json")), "a dry run wrote auth.json");
  assert.ok(!existsSync(home.userConfig), "a dry run wrote config.json");
  assert.ok(!/Opening browser for ChatGPT OAuth sign-in/i.test(out), "a dry run actually opened the OAuth flow");
});

// Regression: init used the frozen CONFIG_DIR/USER_CONFIG_PATH constants, so
// BRUSHROUTER_USER_CONFIG was ignored and loadConfig never saw the file.
test("CLI init honours BRUSHROUTER_USER_CONFIG", async () => {
  const { run, makeHome } = await cliHarness();
  const home = makeHome();
  const override = join(home.home, "elsewhere", "nested", "cfg.json");
  const r = await spawnInit(home, override);
  assert.equal(r.status, 0, `init should exit 0, got ${r.status}: ${r.stderr}`);
  assert.ok(existsSync(override), `init did not write the override path ${override}`);
  assert.match(r.stdout, /cfg\.json/);
  // The default location must stay untouched.
  assert.ok(!existsSync(join(home.home, ".config", "brushrouter", "config.json")));
  // The written file must be the config shape loadConfig expects, not an empty
  // or partial document — writing somewhere unreadable was the bug.
  const saved = JSON.parse(readFileSync(override, "utf8"));
  const { DEFAULT_CONFIG } = await import("../src/config.js");
  assert.deepEqual(Object.keys(saved).sort(), Object.keys(DEFAULT_CONFIG).sort());
  assert.deepEqual(saved.priority, DEFAULT_CONFIG.priority);
  // And a second init must refuse to clobber it.
  const again = await spawnInit(home, override);
  assert.equal(again.status, 1, "init should refuse to overwrite an existing config");
  assert.match(again.stderr, /already exists/);
  void run;
});

async function spawnInit(home, override) {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const bin = fileURLToPath(new URL("../bin/brushrouter.js", import.meta.url));
  return spawnSync(process.execPath, [bin, "init"], {
    encoding: "utf8",
    cwd: tmpdir(),
    env: {
      ...process.env,
      HOME: home.home,
      BRUSHROUTER_CONFIG_DIR: home.cfgDir,
      BRUSHROUTER_USER_CONFIG: override,
      BRUSHROUTER_KEYS_PATH: home.keys,
    },
    timeout: 30000,
  });
}

// Regression: a leading flag swallowed the command, so `--json providers` printed
// help and exited 0 — a no-op that looked like success.
test("CLI accepts flags before the command", async () => {
  const { run, makeHome } = await cliHarness();
  const leading = run(["--json", "providers"], { home: makeHome() });
  assert.equal(leading.status, 0, `--json providers should exit 0: ${leading.stderr}`);
  // `providers --json` is the reference behaviour.
  const trailing = run(["providers", "--json"], { home: makeHome() });
  assert.equal(trailing.status, 0);
  assert.ok(leading.stdout.trim().startsWith("["), `expected JSON, got: ${leading.stdout.slice(0, 120)}`);
  const a = JSON.parse(leading.stdout);
  const b = JSON.parse(trailing.stdout);
  assert.deepEqual(
    a.map((p) => p.id),
    b.map((p) => p.id),
    "--json providers must equal providers --json",
  );
  // And it must not be the help text.
  assert.ok(!/USAGE/.test(leading.stdout), "--json providers printed help instead of running the command");
});

// Regression: ERR_PARSE_ARGS_UNKNOWN_OPTION escaped as a raw stack trace.
test("CLI reports an unknown flag without a stack trace", async () => {
  const { run, makeHome } = await cliHarness();
  for (const argv of [
    ["providers", "--bogus"],
    ["--bogus", "providers"],
    ["gen", "x", "--nope"],
    ["batch", "a", "--nope"],
    ["rules", "--nope"],
  ]) {
    const r = run(argv, { home: makeHome() });
    assert.equal(r.status, 2, `${argv.join(" ")} should exit 2, got ${r.status}`);
    assert.match(r.stderr, /Unknown option/i, `${argv.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /--help/, `${argv.join(" ")} should hint at --help`);
    assert.ok(!/\n\s+at /.test(r.stderr), `${argv.join(" ")} leaked a stack trace:\n${r.stderr}`);
    assert.ok(!/ERR_PARSE_ARGS_UNKNOWN_OPTION/.test(r.stdout + r.stderr), "leaked the Node error code");
  }
});

// Regression: `rules --only <typo>` printed the full list and exited 0.
test("CLI rules --only rejects an unknown harness id", async () => {
  const { run, makeHome } = await cliHarness();
  const home = makeHome();
  const cwd = mkdtempSync(join(tmpdir(), "br-rules-typo-"));
  const r = run(["rules", "--only", "project-agent"], { home, cwd });
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}`);
  assert.match(r.stderr, /unknown harness id/i);
  assert.match(r.stderr, /project-agent/);
  // The message must name real ids so the typo is fixable.
  assert.match(r.stderr, /valid ids:/);
  assert.match(r.stderr, /project-agents/);
  // No rule file may have been created or changed.
  assert.ok(!existsSync(join(cwd, "AGENTS.md")), "rules --only wrote AGENTS.md despite the typo");
});

// Regression: a malformed batch entry was silently turned into a prompt (raw
// JSON text sent to the model) and a malformed array lost every entry.
test("CLI batch rejects malformed JSON instead of prompting with it", async () => {
  const { run, makeHome } = await cliHarness();
  const home = makeHome();
  const dir = mkdtempSync(join(tmpdir(), "br-batch-bad-"));

  const badArray = join(dir, "bad-array.json");
  writeFileSync(badArray, '[{"prompt": "ok"}, {"no_prompt": 1}]');
  const r1 = run(["batch", badArray, "--dry-run"], { home });
  assert.notEqual(r1.status, 0, "a batch item without a prompt must not be accepted");
  assert.match(r1.stderr, /batch item 1/i, `expected the offending index: ${r1.stderr}`);

  const badJson = join(dir, "bad.json");
  writeFileSync(badJson, '[{"prompt": "a"}, oops]');
  const r2 = run(["batch", badJson, "--dry-run"], { home });
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /not valid JSON/i);

  // A line that looks like JSON must never be forwarded as a prompt.
  const badLine = join(dir, "bad.jsonl");
  writeFileSync(badLine, '{"prompt": "fine"}\n{oops}\n');
  const r3 = run(["batch", badLine, "--dry-run"], { home });
  assert.notEqual(r3.status, 0, "a malformed JSON line must fail the batch");
  assert.match(r3.stderr, /line 2/i);
  assert.ok(!/oops/.test(r3.stdout), "the malformed line was dispatched as a prompt");
});

// Regression: `update` printed an unsubstituted OWNER placeholder and exited 0
// when the install failed.
test("CLI update never prints an OWNER placeholder and exits non-zero on failure", async () => {
  const { run, makeHome } = await cliHarness();
  // --dry-run prints the intended action without network access.
  const dry = run(["update", "--dry-run"], { home: makeHome() });
  assert.equal(dry.status, 0);
  assert.ok(!/OWNER/.test(dry.stdout + dry.stderr), `OWNER placeholder leaked:\n${dry.stdout}`);

  // The npm branch is only taken by a non-git install, so run a copy of the
  // package with no .git. Point npm at a registry that refuses connections and
  // at a throwaway cache/prefix so the real global install is never touched.
  const { spawnSync } = await import("node:child_process");
  const { cpSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const pkgDir = mkdtempSync(join(tmpdir(), "br-update-copy-"));
  cpSync(join(root, "package.json"), join(pkgDir, "package.json"));
  cpSync(join(root, "bin"), join(pkgDir, "bin"), { recursive: true });
  cpSync(join(root, "src"), join(pkgDir, "src"), { recursive: true });
  const home = makeHome();
  const cacheDir = mkdtempSync(join(tmpdir(), "br-npm-cache-"));
  const r = spawnSync(process.execPath, [join(pkgDir, "bin", "brushrouter.js"), "update"], {
    encoding: "utf8",
    cwd: tmpdir(),
    timeout: 120000,
    env: {
      ...process.env,
      HOME: home.home,
      BRUSHROUTER_CONFIG_DIR: home.cfgDir,
      BRUSHROUTER_USER_CONFIG: home.userConfig,
      BRUSHROUTER_KEYS_PATH: home.keys,
      npm_config_registry: "http://127.0.0.1:1/",
      npm_config_cache: cacheDir,
      npm_config_prefix: join(home.home, "npm-prefix"),
      // Fail fast: without these npm retries the dead registry for ~60 s.
      npm_config_fetch_retries: "0",
      npm_config_fetch_retry_maxtimeout: "1000",
      npm_config_fetch_timeout: "5000",
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
  });
  assert.notEqual(r.status, 0, `update must fail when npm install fails, got ${r.status}`);
  assert.match(r.stdout + r.stderr, /npm install failed/i);
  // The recovery hint must carry the real repo, derived from package.json.
  assert.match(
    r.stdout + r.stderr,
    /raw\.githubusercontent\.com\/[A-Za-z0-9._-]+\/brushrouter/,
    "install URL is not the real repo",
  );
  assert.ok(!/OWNER/.test(r.stdout + r.stderr), "OWNER placeholder leaked");
});

// Regression: two positional prompts became one glued prompt; -o <dir> was
// accepted as a file target.
test("CLI gen rejects two prompts and a directory -o", async () => {
  const { run, makeHome } = await cliHarness();
  const home = makeHome();
  const cwd = mkdtempSync(join(tmpdir(), "br-gen-args-"));

  const two = run(["gen", "a red fox", "a blue jay"], { home, cwd });
  assert.equal(two.status, 2, `two prompts should exit 2, got ${two.status}`);
  assert.match(two.stderr, /one prompt/i);
  assert.match(two.stderr, /batch/, "the error should point at the batch command");

  const dirOut = mkdtempSync(join(tmpdir(), "br-gen-dir-"));
  const dasDir = run(["gen", "a red fox", "-o", dirOut], { home, cwd });
  assert.equal(dasDir.status, 2, `-o <dir> should exit 2, got ${dasDir.status}`);
  assert.match(dasDir.stderr, /directory/i);
  assert.match(dasDir.stderr, /batch/, "the error should point at the batch command");
});

// Regression: a non-numeric --concurrency was silently ignored and reported null.
test("CLI batch validates --concurrency", async () => {
  const { run, makeHome } = await cliHarness();
  const h = makeHome();
  for (const bad of ["abc", "0", "2.5"]) {
    const r = run(["batch", "a prompt", "--dry-run", "--concurrency", bad], { home: h });
    assert.equal(r.status, 2, `--concurrency ${bad} should exit 2, got ${r.status}`);
    assert.match(r.stderr, /concurrency/i, `message should name the flag: ${r.stderr}`);
    assert.match(r.stderr, /positive integer/i);
  }
  // A negative value is rejected by the option parser before validation runs.
  // Still a clean exit 2 that names the flag — that is the contract that matters.
  const neg = run(["batch", "a prompt", "--dry-run", "--concurrency", "-3"], { home: h });
  assert.equal(neg.status, 2, `--concurrency -3 should exit 2, got ${neg.status}`);
  assert.match(neg.stderr, /concurrency/i, `message should name the flag: ${neg.stderr}`);
  assert.ok(!/\n\s+at /.test(neg.stderr), "negative concurrency leaked a stack trace");
  // A valid value still works and is reported as given.
  const good = run(["batch", "a prompt", "--dry-run", "--json", "--concurrency", "3"], { home: makeHome() });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).concurrency, 3);
});

// Regression: `setup` printed "brushrouter is ready!" and then kept the event
// loop alive forever because the prompt helper left a readline interface attached
// to stdin. The non-interactive path covers the same leak shape: with stdin
// closed and no TTY, setup must terminate on its own.
test("CLI setup terminates instead of hanging on an open stdin", async () => {
  const { run, makeHome } = await cliHarness();
  const home = makeHome();
  const cwd = mkdtempSync(join(tmpdir(), "br-setup-exit-"));
  const started = Date.now();
  const r = run(["setup", "--dry-run"], { home, cwd, stdin: "" });
  const elapsed = Date.now() - started;
  assert.equal(r.status, 0, `setup should exit 0, got ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /brushrouter is ready/, "setup did not reach its final screen");
  // spawnSync itself would time out on a leak; assert it finished well inside
  // the timeout so a regression fails with a clear message rather than a hang.
  assert.ok(elapsed < 30000, `setup took ${elapsed}ms — it is holding the event loop open`);
});

test("a job whose image file disappeared reports an error, not success", async () => {
  // A poll used to answer "Image generated successfully." with zero image blocks
  // once the payload was evicted AND the file was deleted. Eviction is forced
  // with a 1-byte retention budget so rebuildContent() is what answers.
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ url: `data:image/png;base64,${PNG.toString("base64")}` }] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "br-missing-"));
  writeFileSync(
    join(dir, "brushrouter.config.json"),
    JSON.stringify({ priority: ["custom-http"], providers: { "custom-http": { enabled: true } } }),
  );
  const out = join(dir, "gone.png");
  let session;
  try {
    session = await serveSession({
      cwd: dir,
      env: { BRUSHROUTER_CUSTOM_URL: `http://127.0.0.1:${server.address().port}/g`, BRUSHROUTER_JOB_MAX_BYTES: "1" },
    });
    session.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "generate_image", arguments: { prompt: "x", provider: "custom-http", async: true, out } } });
    const started = await session.until((f) => f.id === 1);
    const jobId = /job (img_[a-z0-9_]+)/.exec(started.result?.content?.[0]?.text || "")?.[1];
    assert.ok(jobId, started.result?.content?.[0]?.text);
    await session.until((f) => f.method === "notifications/tasks/status" && f.params?.status === "completed");
    assert.ok(existsSync(out), "the job never saved its image");
    // Delete the file behind the job's back: the bytes are now unreachable.
    rmSync(out);
    session.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "image_result", arguments: { jobId } } });
    const poll = await session.until((f) => f.id === 2);
    assert.equal(poll.result.isError, true, `a missing image was reported as success: ${JSON.stringify(poll.result.content)}`);
    assert.ok(!poll.result.content.some((b) => b.type === "image"), "a phantom image block was returned");
    assert.match(poll.result.content[0].text, /gone\.png/, "the error must name the missing path");
  } finally {
    await session?.close();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the request cap counts bytes, not UTF-16 units", async () => {
  // A 3-byte character counts as 1 in String.length, so the old check admitted
  // multi-byte input at up to 3x the intended memory: 3M "\u20ac" is 3M UTF-16
  // units but 9MB of UTF-8, i.e. over an 8MB byte cap and under a length cap.
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const bin = fileURLToPath(new URL("../bin/brushrouter.js", import.meta.url));
  const child = spawn(process.execPath, [bin, "serve"], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", () => {});
  // One unfinished line (no newline) past the byte cap: the server abandons it
  // and answers once, without buffering the whole thing.
  child.stdin.write("\u20ac".repeat(3_000_000));
  const frames = () =>
    out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !frames().some((f) => f.error)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const err = frames().find((f) => f.error);
  child.stdin.end();
  await new Promise((r) => child.on("close", r));
  assert.ok(err, `an oversized multi-byte line was admitted instead of refused`);
  assert.match(err.error.message, /input limit/i);
});

test("count generates N variations at distinct paths, all returned as images", async () => {
  const { handleRequest } = await import("../src/mcp.js");
  const dir = mkdtempSync(join(tmpdir(), "br-count-"));
  const { PROVIDERS } = await import("../src/router.js");
  let seen = 0;
  PROVIDERS["mock-count"] = {
    id: "mock-count",
    supportsImages: true,
    async probe() {
      return { available: true };
    },
    async generate() {
      seen++;
      return { buffer: PNG, meta: { model: "m" } };
    },
  };
  writeFileSync(join(dir, "brushrouter.config.json"), JSON.stringify({ priority: ["mock-count"], providers: { "mock-count": { enabled: true } } }));
  try {
    const res = await handleRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "generate_image", arguments: { prompt: "x", provider: "mock-count", count: 3, out: join(dir, "c.png") } },
      },
      { cwd: dir },
    );
    assert.equal(seen, 3, `count:3 made ${seen} provider calls`);
    const images = res.result.content.filter((b) => b.type === "image");
    assert.equal(images.length, 3, `count:3 returned ${images.length} image blocks`);
    const paths = res.result.content[0].text.match(/c-\d+\.png/g) || [];
    assert.equal(paths.length, 3, `summary did not list 3 distinct paths: ${res.result.content[0].text}`);
    for (const p of paths) assert.ok(existsSync(join(dir, p)), `${p} was not saved`);
  } finally {
    delete PROVIDERS["mock-count"];
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression: Ctrl-C at a hidden/password prompt used to kill the process while
// the tty was still in raw mode, leaving the user's terminal without echo. The
// prompt must restore the terminal before exiting, and must not let the caller
// start its next prompt first.
test("CLI Ctrl-C at a hidden prompt restores the terminal", async () => {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const bin = fileURLToPath(new URL("../bin/brushrouter.js", import.meta.url));
  const { makeHome } = await cliHarness();
  const home = makeHome();
  const dir = mkdtempSync(join(tmpdir(), "br-b8-"));
  // Fake a TTY and record every setRawMode transition, then run `setup`, pick
  // the "paste an OpenRouter key" option, and send Ctrl-C at the hidden prompt.
  const shim = join(dir, "runner.mjs");
  writeFileSync(
    shim,
    `const fake = (s) => {
  Object.defineProperty(s, "isTTY", { value: true, configurable: true });
  if (!s.setRawMode) s.setRawMode = () => {};
  s.isRaw = false; s.columns = 120; s.rows = 40;
};
fake(process.stdin); fake(process.stdout); fake(process.stderr);
const setRaw = process.stdin.setRawMode.bind(process.stdin);
const modes = [];
process.stdin.setRawMode = (v) => { modes.push(v); return setRaw(v); };
process.argv = [process.argv[0], ${JSON.stringify(bin)}, "setup"];
process.on("exit", (c) => process.stderr.write("\\nMODES:" + JSON.stringify(modes) + " CODE:" + c + "\\n"));
await import(${JSON.stringify(bin)});
`,
  );
  const child = spawn(process.execPath, [shim], {
    env: {
      ...process.env,
      HOME: home.home,
      BRUSHROUTER_CONFIG_DIR: home.cfgDir,
      BRUSHROUTER_USER_CONFIG: home.userConfig,
      BRUSHROUTER_KEYS_PATH: home.keys,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const sent = new Set();
  const iv = setInterval(() => {
    if (/Select \[1-4\]/.test(out) && !sent.has("pick")) {
      child.stdin.write("2\n"); // "Add an OpenRouter API key" -> hidden prompt
      sent.add("pick");
    } else if (/Paste your OpenRouter key/i.test(out) && !sent.has("ctrl-c")) {
      child.stdin.write("\u0003");
      sent.add("ctrl-c");
    }
  }, 100);
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, out, timedOut: true });
    }, 15000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out, timedOut: false });
    });
  });
  clearInterval(iv);
  assert.ok(!result.timedOut, "Ctrl-C at a hidden prompt did not terminate the process");
  assert.equal(result.code, 130, `expected exit 130, got ${result.code}`);
  assert.match(result.out, /Paste your OpenRouter key/i, "never reached the hidden prompt");
  const modes = JSON.parse(/MODES:(\[[^\]]*\])/.exec(result.out)?.[1] || "[]");
  assert.ok(modes.includes(true), "the prompt never entered raw mode");
  assert.equal(modes[modes.length - 1], false, `terminal left in raw mode: ${JSON.stringify(modes)}`);
});

// ---------------------------------------------------------------------------
// custom-http request building: URL templates are percent-encoded, JSON bodies
// are JSON-escaped, and neither the image guard nor the response parser may
// lie about what it did.
// ---------------------------------------------------------------------------

// A stub that records every request and answers with a real PNG, so a test can
// assert on the exact URL the provider built.
async function customHttpStub(handler) {
  const { createServer } = await import("node:http");
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, body, headers: req.headers });
      if (handler) handler(req, res, seen.length);
      else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, seen, base: `http://127.0.0.1:${server.address().port}` };
}

function customPreset(base, over = {}) {
  return {
    id: "custom-http",
    name: "custom-http",
    url: `${base}/gen?prompt={prompt}&size={size}`,
    method: "POST",
    requiresKey: false,
    headers: {},
    body: '{"prompt": "{prompt}", "size": "{size}"}',
    responsePath: "json:data.0.b64_json",
    defaultModel: "test-model",
    ...over,
  };
}

test("URL template substitutions are percent-encoded, not JSON-escaped", async () => {
  const { httpImageGenerate } = await import("../src/providers/http.js");
  // Every character here is legal inside a JSON string — which is exactly why
  // the JSON escaper left them alone — but each one changes a URL's structure.
  // "#" truncated the request at the fragment, "?" and "&" rewrote the query,
  // and "/" could escape the path segment.
  const prompt = "a red #ff0000 door? x=1&y=2 /path escape 100% ok";
  const { server, seen, base } = await customHttpStub();
  try {
    await httpImageGenerate({ prompt, size: "512x512" }, {}, customPreset(base));
    const { url } = seen[0];

    assert.ok(!url.includes("#"), `prompt leaked a fragment into the URL: ${url}`);
    // The structural parts the template itself declares must be intact.
    const parsed = new URL(url, "http://stub");
    assert.equal(parsed.pathname, "/gen");
    assert.equal(parsed.searchParams.get("size"), "512x512", "the size parameter was corrupted");
    // ...and the prompt must round-trip byte-for-byte through the query value.
    assert.equal(parsed.searchParams.get("prompt"), prompt, "prompt did not round-trip through the query");
    // No stray parameters injected by & or ? in the prompt.
    assert.deepEqual([...parsed.searchParams.keys()].sort(), ["prompt", "size"]);

    // The JSON body keeps JSON escaping — a URL-safe escape would be wrong there
    // (it would leave the prompt percent-encoded inside the JSON string).
    assert.equal(JSON.parse(seen[0].body).prompt, prompt, "body substitutions must stay JSON-escaped");
  } finally {
    server.close();
  }
});

test("a provider that cannot carry reference images fails loudly instead of dropping them", async () => {
  const { httpImageGenerate } = await import("../src/providers/http.js");
  const { server, seen, base } = await customHttpStub();
  try {
    // Template has no {image} slot, so there is nowhere for the reference to go.
    await assert.rejects(
      () => httpImageGenerate({ prompt: "x", images: [join(tmpdir(), "does-not-matter.png")] }, {}, customPreset(base)),
      (e) => {
        assert.equal(e.code, "UNSUPPORTED");
        assert.match(e.message, /cannot carry reference images \(1 supplied\)/);
        return true;
      },
      "images were silently dropped",
    );
    // Explicit opt-out is also honoured.
    await assert.rejects(
      () => httpImageGenerate({ prompt: "x", images: [join(tmpdir(), "a.png")] }, {}, customPreset(base, { supportsRefImages: false, body: '{"prompt":"{prompt}","image":"{image}"}' })),
      (e) => {
        assert.equal(e.code, "UNSUPPORTED");
        assert.match(e.message, /does not support reference images/);
        return true;
      },
    );
    // Nothing was sent: the request never went out with the images silently gone.
    assert.equal(seen.length, 0, "a request was sent despite the unsupported images");
  } finally {
    server.close();
  }
});

test("custom-http imagesUsed reports what was sent, not what was asked for", async () => {
  const { httpImageGenerate } = await import("../src/providers/http.js");
  const { server, base } = await customHttpStub();
  try {
    const withoutImages = await httpImageGenerate({ prompt: "x" }, {}, customPreset(base));
    assert.equal(withoutImages.meta.imagesUsed, false, "claimed images were used when none were supplied");
  } finally {
    server.close();
  }
});

test("a response payload that is not an image is rejected, not saved", async () => {
  const { httpImageGenerate } = await import("../src/providers/http.js");
  const { server, base } = await customHttpStub((_req, res) => {
    // An error message echoed inside a 200 body: base64 still decodes to
    // *something*, which used to be written as a .png.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ b64_json: Buffer.from("model overloaded, try again").toString("base64") }] }));
  });
  try {
    await assert.rejects(
      () => httpImageGenerate({ prompt: "x" }, {}, customPreset(base)),
      (e) => {
        assert.equal(e.code, "BAD_IMAGE_PAYLOAD");
        // The message must name the payload so the caller can fix its response path.
        assert.match(e.message, /not PNG\/JPEG\/WebP\/GIF/);
        // The decoded preview is base64 in the message (that is what the body
        // held), so decode it to confirm the offending text was named.
        const preview = /: (\S+)$/.exec(e.message)?.[1] || "";
        assert.match(Buffer.from(preview, "base64").toString(), /model overloaded/, "the offending payload was not named");
        return true;
      },
      "junk was accepted as an image",
    );
  } finally {
    server.close();
  }
});

test("a real image payload still passes the validation", async () => {
  const { httpImageGenerate } = await import("../src/providers/http.js");
  const { server, base } = await customHttpStub();
  try {
    const r = await httpImageGenerate({ prompt: "x" }, {}, customPreset(base));
    assert.equal(detectImageMime(r.buffer), "image/png");
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// findRecipes pagination and limit validation.
// ---------------------------------------------------------------------------

test("findRecipes rejects a negative or non-integer limit instead of clamping", async () => {
  const { findRecipes } = await import("../src/library.js");
  // Reproduced: -3 returned 1 row and NaN returned 4, both silently.
  for (const bad of [-3, -1, 1.5, NaN, "abc", Infinity]) {
    assert.throws(
      () => findRecipes({ query: "product", limit: bad }),
      /limit must/,
      `limit ${String(bad)} was accepted`,
    );
  }
  assert.throws(() => findRecipes({ query: "product", limit: 4, offset: -1 }), /offset must be/);
  assert.throws(() => findRecipes({ query: "product", limit: 4, offset: 1.5 }), /offset must be/);
  // The error names the value the caller passed, not JSON's "null" for NaN.
  assert.throws(() => findRecipes({ query: "product", limit: NaN }), /got NaN/);
});

test("findRecipes keeps the documented 10-row page cap and 0-means-one", async () => {
  const { findRecipes, MAX_LIMIT } = await import("../src/library.js");
  // Both are established behaviour the CLI and tests/recipes.test.js rely on.
  assert.equal(MAX_LIMIT, 10);
  assert.equal(findRecipes({ limit: 0 }).rows.length, 1, "limit 0 must still return one row");
  assert.equal(findRecipes({ limit: 100 }).rows.length, 10, "the page cap must still hold");
});

test("findRecipes exposes offset so rows past the page cap are reachable", async () => {
  const { findRecipes, MAX_LIMIT } = await import("../src/library.js");
  const page1 = findRecipes({ limit: MAX_LIMIT, offset: 0 });
  assert.ok(page1.total > MAX_LIMIT, `need more than one page to test paging (total ${page1.total})`);
  // `total` means MATCHING rows, not the page length — the old rows.length made
  // "there are 30" indistinguishable from "there are 10".
  assert.equal(page1.total, page1.available);
  assert.ok(page1.total > page1.rows.length, "total must not be the page length");
  assert.equal(page1.hasMore, true);

  const page2 = findRecipes({ limit: MAX_LIMIT, offset: MAX_LIMIT });
  assert.equal(page2.offset, MAX_LIMIT);
  assert.equal(page2.rows.length, Math.min(MAX_LIMIT, page1.total - MAX_LIMIT));
  // The two pages must not overlap: that is the whole point of offset.
  const ids1 = new Set(page1.rows.map((r) => r.id));
  assert.equal(page2.rows.filter((r) => ids1.has(r.id)).length, 0, "offset returned rows already seen");

  // The last page is reachable and knows it is the last.
  const last = findRecipes({ limit: MAX_LIMIT, offset: page1.total - 1 });
  assert.equal(last.rows.length, 1);
  assert.equal(last.hasMore, false);

  // An offset past the end is an empty page, not a "nothing matched" lie.
  const past = findRecipes({ limit: MAX_LIMIT, offset: page1.total + 10 });
  assert.deepEqual(past.rows, []);
  assert.equal(past.matched, true);
  assert.equal(past.total, page1.total);
});
