import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { PROVIDERS, generate, batchGenerate, planAttemptOrder } from "../src/router.js";
import { handleToolCall, handleRequest } from "../src/mcp.js";
import { discoverKey } from "../src/util/keys.js";
import { loadConfig } from "../src/config.js";
import { saveImage } from "../src/util/common.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const b64 = png.toString("base64");
const dataUrl = `data:image/png;base64,${b64}`;
const apiKey = "fixture-key-not-a-real-credential";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "br-edit-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const file of ["base image.png", "extra.png", "mask.png"]) writeFileSync(join(cwd, file), png);
  return { cwd, prompt: 'replace the sky "carefully"', images: ["base image.png", "extra.png"], mask: "mask.png" };
}

function mockFetch(t, fetch) {
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  t.after(() => { globalThis.fetch = original; });
}

test("saving provider output uses the detected format rather than a misleading default extension", (t) => {
  const { cwd } = fixture(t);
  const webp = Buffer.from("RIFF\x04\0\0\0WEBP", "latin1");
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const first = saveImage("result.png", webp, cwd, { matchExtension: true });
  assert.equal(first.savedPath, join(cwd, "result.webp"));
  assert.equal(first.requestedPath, join(cwd, "result.png"));
  assert.equal(first.versioned, false);
  assert.equal(existsSync(first.requestedPath), false);
  assert.equal(saveImage("result.png", webp, cwd, { matchExtension: true }).savedPath, join(cwd, "result-v2.webp"));
  assert.equal(saveImage("result.png", jpg, cwd, { force: true, matchExtension: true }).savedPath, join(cwd, "result.jpg"));
  assert.equal(saveImage("result.jpeg", jpg, cwd).savedPath, join(cwd, "result.jpeg"));
  writeFileSync(join(cwd, "result.png"), png);
  writeFileSync(join(cwd, "result.webp"), "existing neighbor");
  assert.equal(saveImage("result.png", webp, cwd, { force: true }).savedPath, join(cwd, "result.png"));
  assert.deepEqual(readFileSync(join(cwd, "result.png")), webp);
  assert.equal(readFileSync(join(cwd, "result.webp"), "utf8"), "existing neighbor");
});

test("checkout config cannot activate or move metered routes ahead of user-configured routes", (t) => {
  const { cwd } = fixture(t);
  const project = join(cwd, "brushrouter.config.json");
  const paid = ["openrouter", "fal", "openai", "gemini-api", "replicate"];
  const userConfig = { priority: ["codex", ...paid], providers: { openai: { apiKey, enabled: true } } };
  writeFileSync(project, JSON.stringify({
    priority: [...paid, "codex"],
    providers: Object.fromEntries(paid.map((id) => [id, { enabled: true }])),
  }));
  const cfg = loadConfig({ cwd, userConfig });
  assert.deepEqual(cfg.priority, userConfig.priority);
  assert.equal(cfg.providers.openai.enabled, true);
  for (const id of ["openrouter", "gemini-api", "replicate"]) assert.equal(cfg.providers[id].enabled, false);

  writeFileSync(project, JSON.stringify({ providers: { codex: { enabled: false }, gemini: { enabled: false }, openai: { enabled: [true] } } }));
  const disabled = loadConfig({ cwd, userConfig });
  assert.deepEqual(disabled.priority, userConfig.priority);
  assert.equal(disabled.providers.codex.enabled, true);
  assert.equal(disabled.providers.gemini.enabled, false);
  assert.equal(loadConfig({ cwd, userConfig, overrides: { priority: ["openai"] } }).priority[0], "openai");
});

test("an empty, malformed, or metered-only checkout priority keeps the trusted priority", (t) => {
  const { cwd } = fixture(t);
  const project = join(cwd, "brushrouter.config.json");
  const userConfig = { priority: ["codex", "gemini"] };
  for (const priority of [[], ["openai", "replicate"], [null, 12, " "], ["typo", "openai"], { codex: true }]) {
    writeFileSync(project, JSON.stringify({ priority }));
    assert.deepEqual(loadConfig({ cwd, userConfig }).priority, userConfig.priority);
  }
  writeFileSync(project, JSON.stringify({ priority: ["typo", "codex", "fal"] }));
  assert.deepEqual(loadConfig({ cwd, userConfig }).priority, ["codex"]);
});

test("checkout cannot promote an environment-enabled metered fallback by disabling an earlier route", (t) => {
  const { cwd } = fixture(t);
  const enable = process.env.BRUSHROUTER_ENABLE;
  const priority = process.env.BRUSHROUTER_PRIORITY;
  t.after(() => {
    if (enable === undefined) delete process.env.BRUSHROUTER_ENABLE;
    else process.env.BRUSHROUTER_ENABLE = enable;
    if (priority === undefined) delete process.env.BRUSHROUTER_PRIORITY;
    else process.env.BRUSHROUTER_PRIORITY = priority;
  });
  process.env.BRUSHROUTER_ENABLE = "openai";
  process.env.BRUSHROUTER_PRIORITY = "codex,openai";
  writeFileSync(join(cwd, "brushrouter.config.json"), JSON.stringify({
    priority: ["gemini"],
    providers: { codex: { enabled: false } },
  }));
  const cfg = loadConfig({ cwd, userConfig: {} });
  assert.deepEqual(cfg.priority, ["codex", "openai"]);
  assert.equal(cfg.providers.codex.enabled, true);
  assert.equal(cfg.providers.openai.enabled, true);
});

test("checkout cannot disable a free Web route that the router tries ahead of metered routes", async (t) => {
  const { cwd } = fixture(t);
  const authFile = join(cwd, "fixture-auth.json");
  const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_plan_type: "free" } })).toString("base64url");
  writeFileSync(authFile, JSON.stringify({ tokens: { access_token: `x.${claims}.y`, refresh_token: "fixture" } }));
  const userConfig = {
    priority: ["openai", "gptweb2api"],
    providers: { codex: { authFile }, openai: { enabled: true }, gptweb2api: { enabled: true } },
  };
  assert.deepEqual(await planAttemptOrder(loadConfig({ cwd, userConfig })), ["gptweb2api", "openai"]);
  writeFileSync(join(cwd, "brushrouter.config.json"), JSON.stringify({ providers: { gptweb2api: { enabled: false } } }));
  assert.deepEqual(await planAttemptOrder(loadConfig({ cwd, userConfig })), ["gptweb2api", "openai"]);
});

test("OpenAI Images selects generation JSON or edits multipart with ordered references and a PNG mask", async (t) => {
  const request = fixture(t);
  const cfg = { apiKey, size: "1024x1024", quality: "medium" };
  assert.equal((await PROVIDERS.openai.probe(cfg)).available, true);
  let calls = 0;
  mockFetch(t, async (url, init) => {
    assert.equal(init.headers.Authorization, `Bearer ${apiKey}`);
    if (calls++ === 0) {
      assert.equal(url, "https://api.openai.com/v1/images/generations");
      assert.deepEqual(JSON.parse(init.body), { model: "gpt-image-2.6-sunburst", prompt: request.prompt, size: "1024x1024", quality: "medium" });
    } else {
      assert.equal(url, "https://api.openai.com/v1/images/edits");
      assert.equal(init.headers["Content-Type"], undefined);
      assert.equal(init.body.get("model"), "gpt-image-1.5");
      assert.equal(init.body.get("size"), "1536x1024");
      assert.equal(init.body.get("background"), "transparent");
      const refs = init.body.getAll("image[]");
      assert.deepEqual(refs.map((ref) => ref.name), ["reference-1.png", "reference-2.png"]);
      assert.deepEqual(Buffer.from(await refs[0].arrayBuffer()), png);
      assert.deepEqual(Buffer.from(await init.body.get("mask").arrayBuffer()), png);
    }
    return Response.json({ data: [{ b64_json: b64 }] });
  });
  assert.deepEqual((await PROVIDERS.openai.generate({ prompt: request.prompt }, cfg)).buffer, png);
  const edit = await PROVIDERS.openai.generate({ ...request, model: "gpt-image-1.5", size: "1536X1024", background: "transparent" }, cfg);
  assert.deepEqual(edit.buffer, png);
  assert.equal(edit.meta.maskUsed, true);
  assert.equal(calls, 2);
});

test("OpenAI Images preserves valid custom dimensions and maps unsupported sizes for each model", async (t) => {
  const sizes = [];
  mockFetch(t, async (_url, init) => {
    sizes.push(JSON.parse(init.body).size);
    return Response.json({ data: [{ b64_json: b64 }] });
  });
  const provider = PROVIDERS.openai;
  await provider.generate({ prompt: "draw", size: "1536x864" }, { apiKey });
  await provider.generate({ prompt: "draw" }, { apiKey, size: "1000x577" });
  await provider.generate({ prompt: "draw", size: "1536x864", model: "gpt-image-1.5" }, { apiKey });
  await provider.generate({ prompt: "draw", size: "auto" }, { apiKey });
  assert.equal(sizes[0], "1536x864");
  const [w, h] = sizes[1].split("x").map(Number);
  assert.equal(w % 16 + h % 16, 0);
  assert.ok(w * h >= 655360 && w * h <= 8294400);
  assert.ok(Math.abs(w - 1000) < 100 && Math.abs(h - 577) < 100);
  assert.equal(sizes[2], "1536x1024");
  assert.equal(sizes[3], "auto");
});

test("AI Studio discovers Google keys and sends inline reference data without putting credentials in URLs", async (t) => {
  const request = fixture(t);
  const old = Object.fromEntries(["BRUSHROUTER_GEMINI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"].map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
  delete process.env.BRUSHROUTER_GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  process.env.GOOGLE_API_KEY = apiKey;
  assert.equal(discoverKey("gemini-api").source, "env:GOOGLE_API_KEY");
  process.env.GEMINI_API_KEY = apiKey;
  assert.equal(discoverKey("gemini-api").source, "env:GEMINI_API_KEY");
  assert.equal((await PROVIDERS["gemini-api"].probe({})).available, true);
  mockFetch(t, async (url, init) => {
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent");
    assert.equal(init.headers["x-goog-api-key"], apiKey);
    const payload = JSON.parse(init.body);
    assert.deepEqual(payload.contents[0].parts, [{ text: request.prompt }, ...request.images.map(() => ({ inlineData: { mimeType: "image/png", data: b64 } }))]);
    assert.deepEqual(payload.generationConfig.imageConfig, { aspectRatio: "16:9" });
    return Response.json({ candidates: [{ content: { parts: [{ text: "image" }, { inlineData: { mimeType: "image/png", data: b64 } }] } }] });
  });
  const result = await PROVIDERS["gemini-api"].generate({ ...request, size: "1920x1080", mask: undefined }, {});
  assert.deepEqual(result.buffer, png);
  assert.equal(result.meta.imagesUsed, true);
});

test("Replicate polls a versioned prediction and downloads output without forwarding credentials", async (t) => {
  const request = fixture(t);
  const version = "a".repeat(64);
  const cfg = { apiKey, baseUrl: "http://127.0.0.1:9998/v1", model: `owner/model:${version}`, imageInput: "sources", imageInputArray: true, maskInput: "matte", inputs: { steps: 12 }, widthInput: "w", pollIntervalMs: 1 };
  let calls = 0;
  mockFetch(t, async (url, init) => {
    calls++;
    switch (new URL(url).pathname) {
      case "/v1/predictions":
        assert.equal(init.headers.Prefer, "wait=10");
        assert.deepEqual(JSON.parse(init.body), { version, input: { prompt: request.prompt, steps: 12, w: 512, sources: [dataUrl, dataUrl], matte: dataUrl } });
        return Response.json({ id: "job_1", status: "starting" });
      case "/v1/predictions/job_1":
        assert.equal(init.headers.Authorization, `Bearer ${apiKey}`);
        return Response.json({ id: "job_1", status: "succeeded", output: ["http://127.0.0.1:9998/output.png"] });
      case "/output.png":
        assert.equal(init.headers, undefined);
        return new Response(png);
      default:
        assert.fail(`unexpected request: ${url}`);
    }
  });
  const result = await PROVIDERS.replicate.generate({ ...request, size: "512x768" }, cfg);
  assert.deepEqual(result.buffer, png);
  assert.equal(result.meta.maskUsed, true);
  await assert.rejects(() => PROVIDERS.replicate.generate(request, { ...cfg, maskInput: undefined }), { code: "UNSUPPORTED" });
  assert.equal(calls, 3);
});

test("Replicate defaults to the unversioned Flux model and redacts echoed API credentials", async (t) => {
  assert.equal((await PROVIDERS.replicate.probe({ apiKey })).available, true);
  mockFetch(t, async (url, init) => {
    assert.equal(url, "https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions");
    assert.deepEqual(JSON.parse(init.body), { input: { prompt: "draw", aspect_ratio: "16:9" } });
    return Response.json({ detail: apiKey }, { status: 429 });
  });
  await assert.rejects(() => PROVIDERS.replicate.generate({ prompt: "draw", size: "1600x900" }, { apiKey }),
    (err) => err.code === "RATE_LIMIT" && err.message.includes("***") && !err.message.includes(apiKey));
});

test("ComfyUI probes, queues default Flux and template edits, uploads masks, polls, and downloads saved output", async (t) => {
  const request = fixture(t);
  const workflow = join(request.cwd, "workflow.json");
  writeFileSync(workflow, JSON.stringify({ 1: { class_type: "CustomEdit", inputs: {
    text: "Brief: {prompt}", seed: "{seed}", dimensions: ["{width}", "{height}", "{size}"], refs: ["{image}", "{image2}"], mask: "{mask}", model: "{model}",
  } } }));
  const uploads = [];
  let queued = 0;
  let polled = 0;
  mockFetch(t, async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, "http://127.0.0.1:8188");
    switch (parsed.pathname) {
      case "/system_stats": return Response.json({ system: {} });
      case "/upload/image": {
        assert.equal(init.body.get("type"), "input");
        const file = init.body.get("image");
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
        uploads.push(file.name);
        return Response.json({ name: `upload-${uploads.length}.png`, subfolder: "imports" });
      }
      case "/prompt": {
        const graph = JSON.parse(init.body).prompt;
        if (++queued === 1) {
          assert.equal(graph["1"].inputs.unet_name, "flux1-schnell.safetensors");
          assert.equal(graph["4"].inputs.text, request.prompt);
          assert.equal(graph["8"].class_type, "SaveImage");
        } else {
          assert.deepEqual(graph["1"].inputs, {
            text: `Brief: ${request.prompt}`, seed: graph["1"].inputs.seed, dimensions: [640, 896, "640x896"],
            refs: ["imports/upload-1.png", "imports/upload-2.png"], mask: "imports/upload-3.png", model: "alternate.safetensors",
          });
          assert.equal(typeof graph["1"].inputs.seed, "number");
        }
        return Response.json({ prompt_id: "job" });
      }
      case "/history/job":
        if (polled++ % 2 === 0) return Response.json({});
        return Response.json({ job: { outputs: { 8: { images: [{ filename: "with space.png", subfolder: "test", type: "output" }] } } } });
      case "/view":
        assert.deepEqual(Object.fromEntries(parsed.searchParams), { filename: "with space.png", subfolder: "test", type: "output" });
        return new Response(png);
      default: assert.fail(`unexpected request: ${url}`);
    }
  });
  assert.equal((await PROVIDERS.comfyui.probe({})).available, true);
  assert.deepEqual((await PROVIDERS.comfyui.generate({ prompt: request.prompt }, { pollIntervalMs: 1 })).buffer, png);
  await assert.rejects(() => PROVIDERS.comfyui.generate(request, {}), { code: "UNSUPPORTED" });
  const result = await PROVIDERS.comfyui.generate({ ...request, size: "640x896", model: "alternate.safetensors" }, { workflow, pollIntervalMs: 1 });
  assert.deepEqual(result.buffer, png);
  assert.equal(result.meta.maskUsed, true);
  assert.equal(result.meta.model, "alternate.safetensors");
  assert.equal(new Set(uploads).size, 3);
  assert.equal(polled, 4);
});

test("ComfyUI loads relative workflows from the user config directory, not the checkout", async (t) => {
  const { cwd } = fixture(t);
  const userDir = join(cwd, "user");
  mkdirSync(userDir);
  const original = process.env.BRUSHROUTER_USER_CONFIG;
  process.env.BRUSHROUTER_USER_CONFIG = join(userDir, "config.json");
  t.after(() => {
    if (original == null) delete process.env.BRUSHROUTER_USER_CONFIG;
    else process.env.BRUSHROUTER_USER_CONFIG = original;
  });
  for (const [directory, node] of [[cwd, "CheckoutNode"], [userDir, "TrustedNode"]]) {
    writeFileSync(join(directory, "graph.json"), JSON.stringify({ 1: { class_type: node, inputs: { text: "{prompt}" } } }));
  }
  writeFileSync(join(cwd, "brushrouter.config.json"), JSON.stringify({ providers: { comfyui: { workflow: "untrusted.json" } } }));
  const cfg = loadConfig({ cwd, userConfig: { providers: { comfyui: { workflow: "graph.json" } } } });
  assert.equal(cfg.providers.comfyui.workflow, "graph.json");
  let requests = 0;
  mockFetch(t, async (url, init) => {
    requests++;
    if (url.endsWith("/prompt")) {
      assert.equal(JSON.parse(init.body).prompt["1"].class_type, "TrustedNode");
      return Response.json({ prompt_id: "job" });
    }
    if (url.endsWith("/history/job")) {
      return Response.json({ job: { outputs: { 1: { images: [{ filename: "result.png", type: "output" }] } } } });
    }
    assert.match(url, /\/view\?/);
    return new Response(png);
  });
  await assert.rejects(() => PROVIDERS.comfyui.generate({ prompt: "draw", cwd, model: "ignored.safetensors" }, cfg.providers.comfyui),
    (err) => err.code === "BAD_WORKFLOW" && err.message.includes("{model}"));
  assert.equal(requests, 0);
  const result = await PROVIDERS.comfyui.generate({ prompt: "draw", cwd }, cfg.providers.comfyui);
  assert.deepEqual(result.buffer, png);
  assert.equal(result.meta.model, undefined);
});

test("fal selects generation, edit and inpainting endpoints with appropriate reference fields", async (t) => {
  const request = fixture(t);
  let calls = 0;
  mockFetch(t, async (url, init) => {
    assert.equal(init.headers.Authorization, `Key ${apiKey}`);
    const payload = JSON.parse(init.body);
    assert.equal(payload.prompt, request.prompt);
    switch (calls++) {
      case 0:
        assert.equal(url, "https://fal.run/fal-ai/flux/schnell");
        assert.equal(payload.image_urls, undefined);
        break;
      case 1:
        assert.equal(url, "https://fal.run/fal-ai/flux-2/edit");
        assert.deepEqual(payload.image_urls, [dataUrl, dataUrl]);
        break;
      case 2:
        assert.equal(url, "https://fal.run/custom/inpaint");
        assert.equal(payload.image_url, dataUrl);
        assert.equal(payload.mask_url, dataUrl);
        assert.equal(payload.image_urls, undefined);
        break;
      default:
        assert.fail("unexpected fal request");
    }
    return Response.json({ images: [{ url: dataUrl }] });
  });
  assert.deepEqual((await PROVIDERS.fal.generate({ prompt: request.prompt }, { apiKey })).buffer, png);
  assert.deepEqual((await PROVIDERS.fal.generate({ ...request, mask: undefined }, { apiKey })).buffer, png);
  await assert.rejects(() => PROVIDERS.fal.generate(request, { apiKey }), { code: "UNSUPPORTED" });
  const edit = await PROVIDERS.fal.generate({ ...request, images: request.images.slice(0, 1) }, { apiKey, inpaintModel: "custom/inpaint" });
  assert.equal(edit.meta.maskUsed, true);
  assert.equal(calls, 3);
});

test("Gemini and Antigravity stage references and never mistake them for generated outputs", { skip: process.platform === "win32" }, async (t) => {
  const request = fixture(t);
  for (const binary of ["gemini-fixture", "agy-fixture"]) {
    const cli = join(request.cwd, binary);
    const script = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2).join(" ");
if (!args.includes("@reference-inputs/1.png") || !args.includes("@reference-inputs/2.png")) process.exit(7);
if (fs.readFileSync("reference-inputs/1.png").toString("base64") !== "${b64}") process.exit(8);
console.log(process.cwd() + "/reference-inputs/1.png");
if (!args.includes("NO OUTPUT")) fs.writeFileSync("brushrouter-out.png", Buffer.from("${b64}", "base64"));
`;
    writeFileSync(cli, script, { mode: 0o700 });
    assert.deepEqual((await PROVIDERS.gemini.generate({ ...request, mask: undefined }, { cli })).buffer, png);
    await assert.rejects(() => PROVIDERS.gemini.generate({ ...request, prompt: "NO OUTPUT", mask: undefined }, { cli }), /produced no image/);
  }
});

test("single and batch mask routing skips incompatible routes even with explicit fallback", async (t) => {
  const request = fixture(t);
  const seen = [];
  const cfg = { priority: ["gemini-api", "openai"], providers: {} };
  t.mock.method(PROVIDERS["gemini-api"], "generate", async () => { assert.fail("incompatible route was invoked"); });
  t.mock.method(PROVIDERS.openai, "probe", async () => ({ available: true }));
  t.mock.method(PROVIDERS.openai, "generate", async (input) => { seen.push(input.mask); return { buffer: png, meta: {} }; });
  assert.deepEqual(await planAttemptOrder(cfg, request), ["openai"]);
  await assert.rejects(() => generate({ ...request, provider: "gemini-api" }, cfg), { code: "UNSUPPORTED" });
  await assert.rejects(() => generate({ ...request, images: [] }, cfg), { code: "INVALID_MASK" });
  assert.equal((await generate({ ...request, provider: "gemini-api", fallback: true }, cfg)).meta.maskUsed, true);
  const batch = await batchGenerate({ items: [request], provider: "gemini-api", fallback: true }, cfg);
  assert.equal(batch.results[0].provider, "openai");
  assert.equal(batch.results[0].meta.maskUsed, true);
  const unsupported = await batchGenerate({ items: [request], provider: "gemini-api" }, cfg);
  assert.equal(unsupported.results[0].code, "UNSUPPORTED");
  await assert.rejects(() => batchGenerate({ items: [{ ...request, images: [] }] }, cfg), { code: "INVALID_MASK" });
  assert.deepEqual(seen, [request.mask, request.mask]);
});

test("CLI mask flag and MCP mask schemas forward inputs and reject missing bases", async (t) => {
  const request = fixture(t);
  const config = join(request.cwd, "config.json");
  writeFileSync(config, JSON.stringify({ providers: { openai: { enabled: true } } }));
  const original = process.env.BRUSHROUTER_USER_CONFIG;
  process.env.BRUSHROUTER_USER_CONFIG = config;
  t.after(() => {
    if (original == null) delete process.env.BRUSHROUTER_USER_CONFIG;
    else process.env.BRUSHROUTER_USER_CONFIG = original;
  });
  const cli = resolve("bin/brushrouter.js");
  const dry = spawnSync(process.execPath, [cli, "--mask", request.mask, "gen", request.prompt, "-p", "openai", "--images", request.images[0], "--dry-run", "--json"], { cwd: request.cwd, encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).mask, request.mask);
  const invalid = spawnSync(process.execPath, [cli, "gen", request.prompt, "--mask", request.mask], { cwd: request.cwd, encoding: "utf8" });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /requires a base image/);

  t.mock.method(PROVIDERS.openai, "generate", async ({ images, mask }) => {
    assert.deepEqual(images, request.images);
    assert.equal(mask, request.mask);
    return { buffer: png, meta: {} };
  });
  const ctx = { cwd: request.cwd };
  const { result } = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ctx);
  assert.equal(result.tools.find((tool) => tool.name === "generate_image").inputSchema.properties.mask.type, "string");
  assert.equal(result.tools.find((tool) => tool.name === "batch_generate_images").inputSchema.properties.items.items.properties.mask.type, "string");
  const single = await handleToolCall("generate_image", { ...request, provider: "openai", out: "single.png" }, ctx);
  assert.equal(single.isError, false);
  assert.ok(existsSync(join(request.cwd, "single.png")));
  const batch = await handleToolCall("batch_generate_images", { provider: "openai", items: [{ ...request, out: "batch.png" }], outDir: "out" }, ctx);
  assert.equal(batch.isError, false);
  assert.ok(existsSync(join(request.cwd, "out", "batch.png")));
  await assert.rejects(() => handleToolCall("generate_image", { ...request, images: [] }, ctx), { code: "INVALID_MASK" });
});

test("MCP variations detect the format if the caller supplied no extension", async (t) => {
  const { cwd } = fixture(t);
  const webp = Buffer.from("RIFF\x04\0\0\0WEBP", "latin1");
  t.mock.method(PROVIDERS.codex, "generate", async () => ({ buffer: webp }));
  for (const [out, ext] of [["detected", ".webp"], ["explicit.png", ".png"]]) {
    const result = await handleToolCall("generate_image", { prompt: "test", provider: "codex", out, count: 2 }, { cwd });
    assert.equal(result.isError, false, result.content[0].text);
    for (const index of [1, 2]) {
      assert.ok(existsSync(join(cwd, `${out.split(".")[0]}-${index}${ext}`)), result.content[0].text);
    }
  }
});

test("CLI batch uses a per-item mask or the flag default and rejects a masked item without a base", (t) => {
  const request = fixture(t);
  const cfg = join(request.cwd, "config.json");
  writeFileSync(cfg, JSON.stringify({
    priority: ["gemini-api", "openai"],
    providers: { "gemini-api": { enabled: true, apiKey }, openai: { enabled: true, apiKey } },
  }));
  const input = join(request.cwd, "items.json");
  const cli = resolve("bin/brushrouter.js");
  const options = {
    cwd: request.cwd,
    encoding: "utf8",
    env: { ...process.env, BRUSHROUTER_USER_CONFIG: cfg, BRUSHROUTER_CONFIG_DIR: request.cwd, BRUSHROUTER_ENABLE: "", BRUSHROUTER_DISABLE: "", BRUSHROUTER_PRIORITY: "" },
  };
  const args = [cli, "batch", input, "--mask", request.mask, "--dry-run", "--json"];
  writeFileSync(input, JSON.stringify([
    { prompt: "use the default mask", images: request.images },
    { prompt: "use the item mask", images: request.images, mask: "extra.png" },
  ]));
  const dry = spawnSync(process.execPath, args, options);
  assert.equal(dry.status, 0, dry.stderr);
  const plan = JSON.parse(dry.stdout);
  assert.deepEqual(plan.items.map(({ mask }) => mask), [request.mask, "extra.png"]);
  assert.deepEqual(plan.readyProviders.map(({ id }) => id), ["openai"]);

  writeFileSync(input, JSON.stringify([
    { prompt: "masked edit", images: request.images, mask: request.mask },
    { prompt: "text generation" },
  ]));
  const mixed = spawnSync(process.execPath, [cli, "batch", input, "--provider", "gemini-api", "--dry-run", "--json"], options);
  assert.equal(mixed.status, 0, mixed.stderr);
  const mixedPlan = JSON.parse(mixed.stdout);
  assert.equal(mixedPlan.items[0].code, "UNSUPPORTED");
  assert.equal(mixedPlan.items[1].error, undefined);
  assert.deepEqual(mixedPlan.readyProviders.map(({ id }) => id), ["gemini-api"]);

  writeFileSync(input, JSON.stringify([{ prompt: "masked edit", images: request.images, mask: request.mask }]));
  const incompatibleArgs = [cli, "batch", input, "--provider", "gemini-api", "--dry-run"];
  const allIncompatible = spawnSync(process.execPath, [...incompatibleArgs, "--json"], options);
  assert.equal(allIncompatible.status, 1, allIncompatible.stderr);
  assert.equal(JSON.parse(allIncompatible.stdout).items[0].code, "UNSUPPORTED");
  const textPreview = spawnSync(process.execPath, incompatibleArgs, options);
  assert.equal(textPreview.status, 1, textPreview.stderr);
  assert.match(textPreview.stdout, /mask/i);

  writeFileSync(input, JSON.stringify([{ prompt: "missing base image" }]));
  const invalid = spawnSync(process.execPath, args, options);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /batch item 1 mask: requires a mask file path and a base image/);
});
