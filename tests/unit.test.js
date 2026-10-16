import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, chmodSync } from "node:fs";
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
// auto-routing walk. It must remain forceable with --provider, which is what
// `enabled: false` means (see attemptOrder in src/router.js).
test("openrouter is off by default but still forceable", async () => {
  assert.equal(DEFAULT_CONFIG.providers.openrouter.enabled, false, "openrouter was re-enabled by default");

  const cfg = loadConfig({ cwd: mkdtempSync(join(tmpdir(), "br-order-")), overrides: { priority: DEFAULT_CONFIG.priority } });
  const auto = await planAttemptOrder(cfg, {});
  assert.ok(!auto.includes("openrouter"), `auto-routing reached openrouter: ${auto.join(" -> ")}`);
  assert.deepEqual(await planAttemptOrder(cfg, { provider: "openrouter" }), ["openrouter"]);
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

  const image = Buffer.alloc(3 * 1024 * 1024, 0x89); // ~4 MB once base64-encoded
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
  const child = spawn(process.execPath, [bin, "batch", "prompt alpha", "prompt beta", "--dry-run", "--json"], {
    stdio: ["pipe", "pipe", "pipe"],
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
    "  req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('x').toString('base64') }] })); });",
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
