import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/brushrouter.js", import.meta.url));
const recipeCheck = fileURLToPath(new URL("../scripts/check-recipes.mjs", import.meta.url));

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "br-onboarding-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const home = join(cwd, "home");
  const configDir = join(home, ".config", "brushrouter");
  const config = join(configDir, "config.json");
  mkdirSync(home);
  const env = { HOME: home, USERPROFILE: home, PATH: "/usr/bin:/bin", BRUSHROUTER_CONFIG_DIR: configDir };
  function run(args, { shim = "", extraEnv = {}, script = bin } = {}) {
    const argv = shim ? ["--input-type=module", "-e", `
      process.argv = [process.execPath, ${JSON.stringify(script)}, ...${JSON.stringify(args)}];
      ${shim}
      await import(${JSON.stringify(script)});
    `] : [script, ...args];
    const result = spawnSync(process.execPath, argv, { cwd, env: { ...env, ...extraEnv }, timeout: 10000, encoding: "utf8", input: "" });
    assert.ifError(result.error);
    return result;
  }
  return { cwd, home, configDir, config, run };
}

const tty = `
  Object.defineProperty(process.stdin, "isTTY", { value: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true });
`;
const fal = { BRUSHROUTER_FAL_KEY: "fixture-fal-key" };
const openrouter = { BRUSHROUTER_OPENROUTER_KEY: "fixture-openrouter-key" };

test("setup only changes MCP settings and rules in automation with --yes", (t) => {
  const { cwd, home, run } = fixture(t);
  mkdirSync(join(cwd, ".git"));
  const rules = join(cwd, "AGENTS.md");
  const agent = join(home, "agent.json");
  writeFileSync(rules, "# Existing project rules\n");
  writeFileSync(agent, "{}");
  const extraEnv = { ...fal, BRUSHROUTER_MCP_CONFIGS: agent };
  const pipe = run(["setup", "--json"], { extraEnv });
  assert.equal(pipe.status, 0, pipe.stderr);
  assert.equal(JSON.parse(pipe.stdout).ready, 1);
  for (const args of [["setup", "--non-interactive"], ["setup"]]) {
    const result = run(args, { shim: tty, extraEnv: { ...extraEnv, CI: args.length === 1 ? "true" : "false" } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Skipping MCP changes without --yes/);
    assert.match(result.stdout, /Skipping rules changes without --yes/);
  }
  const dry = run(["setup", "--yes", "--dry-run", "--json"], { shim: tty, extraEnv });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).dryRun, true);
  assert.equal(readFileSync(rules, "utf8"), "# Existing project rules\n");
  assert.deepEqual(JSON.parse(readFileSync(agent, "utf8")), {});

  const yes = run(["setup", "--non-interactive", "--yes", "--json"], { extraEnv });
  assert.equal(yes.status, 0, yes.stderr);
  assert.equal(JSON.parse(yes.stdout).ok, true);
  assert.match(readFileSync(rules, "utf8"), /BRUSHROUTER_START/);
  assert.ok(JSON.parse(readFileSync(agent, "utf8")).mcpServers.brushrouter);
});

test("setup without a provider returns a JSON failure instead of declaring readiness", (t) => {
  const result = fixture(t).run(["setup", "--non-interactive", "--json"]);
  assert.equal(result.status, 1, result.stderr);
  const setup = JSON.parse(result.stdout);
  assert.equal(setup.ok, false);
  assert.equal(setup.ready, 0);
  assert.doesNotMatch(result.stdout, /brushrouter is ready!/);
});

test("interactive setup bounds npm link and describes a timeout", (t) => {
  const { cwd, run } = fixture(t);
  writeFileSync(join(cwd, "package.json"), "{}");
  const shim = tty + `
    const { createRequire, syncBuiltinESMExports } = await import("node:module");
    const { EventEmitter } = await import("node:events");
    const require = createRequire(process.argv[1]);
    const child = require("node:child_process");
    const original = child.spawnSync;
    child.spawnSync = (command, args, opts) => {
      if (command !== "npm" || args[0] !== "link") return original(command, args, opts);
      console.log("link-timeout:" + opts.timeout);
      return { status: null, error: new Error("fixture link timed out") };
    };
    require("node:readline").createInterface = () => Object.assign(new EventEmitter(), {
      setPrompt() {}, close() {},
      prompt() { queueMicrotask(() => this.emit("line", "y")); },
    });
    syncBuiltinESMExports();
  `;
  const result = run(["setup", "--skip-mcp", "--skip-test"], { shim, extraEnv: fal });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /link-timeout:60000/);
  assert.match(result.stdout, /fixture link timed out/);
});

test("doctor skips disabled providers and labels local checks as unverified", (t) => {
  const { run } = fixture(t);
  // OpenRouter is disabled by default despite a configured key.
  const shim = 'globalThis.fetch = async () => { console.error("unexpected fetch"); throw Error("unexpected fetch"); };';
  const result = run(["doctor", "--json"], { shim, extraEnv: { ...fal, ...openrouter } });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /unexpected fetch/);
  const { providers } = JSON.parse(result.stdout);
  assert.equal(providers.find(({ id }) => id === "openrouter").auth, "disabled");
  assert.equal(providers.find(({ id }) => id === "fal").verification, "configured");
  const none = run(["doctor", "--json"], { shim, extraEnv: openrouter });
  assert.equal(none.status, 1);
  assert.equal(JSON.parse(none.stdout).ready, 0);
});

test("doctor --fix plans and applies only local user-config changes", (t) => {
  const { run, configDir, config } = fixture(t);
  const diagnose = (...args) => {
    const result = run(["doctor", "--fix", "--json", ...args]);
    assert.equal(result.status, 1, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.deepEqual(diagnose("--dry-run").fixes.map(({ action, status }) => [action, status]),
    [["create-directory", "planned"], ["create-config", "planned"]]);
  assert.equal(existsSync(configDir), false);
  assert.deepEqual(diagnose().fixes.map(({ status }) => status), ["applied", "applied"]);
  assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), {});
  if (process.platform !== "win32") {
    const mode = (path) => statSync(path).mode & 0o777;
    assert.equal(mode(configDir), 0o700);
    assert.equal(mode(config), 0o600);
  }
  writeFileSync(config, "{invalid");
  assert.equal(diagnose("--dry-run").fixes.find(({ action }) => action === "repair-config").status, "planned");
  assert.equal(readFileSync(config, "utf8"), "{invalid");
  const repair = diagnose().fixes.find(({ action }) => action === "repair-config");
  assert.equal(repair.status, "applied");
  assert.equal(readFileSync(repair.backup, "utf8"), "{invalid");
  assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { providers: { fal: { enabled: false } } });
  assert.deepEqual(diagnose().fixes, []);
});

test("model results distinguish invalid providers, rejected keys, transient errors and empty catalogues", (t) => {
  const { run } = fixture(t);
  const unknown = run(["models", "not-a-provider", "--json"]);
  assert.equal(unknown.status, 2);
  assert.equal(JSON.parse(unknown.stdout).error.code, "unknown-provider");
  for (const [status, code] of [[401, "auth"], [403, "auth"], [429, "transient"], [503, "transient"], [200, "empty"], [null, "transient"]]) {
    const shim = status === null ? 'globalThis.fetch = async () => { throw new Error("fixture network unavailable"); };'
      : `globalThis.fetch = async () => new Response('{"data":[]}', { status: ${status} });`;
    const result = run(["models", "openrouter", "--json"], { shim, extraEnv: openrouter });
    assert.equal(result.status, 1, result.stderr);
    const row = JSON.parse(result.stdout).openrouter;
    assert.deepEqual(row.models, []);
    assert.equal(row.error.code, code);
    if (status && status !== 200) assert.equal(row.error.status, status);
    const doctor = run(["doctor", "--json"], { shim, extraEnv: { ...openrouter, BRUSHROUTER_ENABLE: "openrouter" } });
    assert.equal(doctor.status, 1, doctor.stderr);
    const check = JSON.parse(doctor.stdout).providers.find(({ id }) => id === "openrouter");
    assert.equal(check.auth, code === "auth" ? "invalid" : code);
  }
  const partial = run(["models", "openrouter", "fal", "--json"]);
  assert.equal(partial.status, 0, partial.stderr);
  assert.equal(JSON.parse(partial.stdout).openrouter.error.code, "missing");
  const successShim = `globalThis.fetch = async () => new Response('{"data":[{"id":"fixture/image"}]}');`;
  const success = run(["models", "openrouter", "--json"], { shim: successShim, extraEnv: openrouter });
  assert.equal(success.status, 0, success.stderr);
  assert.deepEqual(JSON.parse(success.stdout).openrouter.models, ["fixture/image"]);
  const verified = run(["doctor", "--json"], { shim: successShim, extraEnv: { ...openrouter, BRUSHROUTER_ENABLE: "openrouter" } });
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).providers.find(({ id }) => id === "openrouter").verification, "verified");
});

test("models JSON redacts a credential echoed as a gateway model ID", (t) => {
  const { run } = fixture(t);
  const id = openrouter.BRUSHROUTER_OPENROUTER_KEY;
  const shim = `globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: ${JSON.stringify(id)} }] }));`;
  const result = run(["models", "openrouter", "--json"], { shim, extraEnv: openrouter });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(id));
  assert.deepEqual(JSON.parse(result.stdout).openrouter.endpoints, [{ id: "***", endpoint: "/images" }]);
});

test("update JSON reports bounded git and npm steps, and runs doctor only after success", (t) => {
  const { run } = fixture(t);
  for (const failed of ["git", "npm", null]) {
    const shim = `
      const { createRequire, syncBuiltinESMExports } = await import("node:module");
      const child = createRequire(process.argv[1])("node:child_process");
      const original = child.spawnSync;
      child.spawnSync = (command, args, opts) => {
        if (command !== "git" && !(command === "npm" && args[0] === "link")) return original(command, args, opts);
        console.error(JSON.stringify({ command, args, timeout: opts.timeout, prompt: opts.env.GIT_TERMINAL_PROMPT, editor: opts.env.GIT_EDITOR, stdio: opts.stdio }));
        return { status: command === ${JSON.stringify(failed)} ? 17 : 0, stderr: "fixture failure" };
      };
      syncBuiltinESMExports();
    `;
    const status = run(["update", "--json"], { shim, extraEnv: fal });
    assert.equal(status.status, failed ? 1 : 0, status.stderr);
    const result = JSON.parse(status.stdout);
    assert.equal(result.ok, !failed);
    const commands = status.stderr.trim().split("\n").map((s) => JSON.parse(s));
    assert.deepEqual(commands[0], {
      command: "git", args: ["pull", "--rebase", "--no-edit"], timeout: 30000, prompt: "0", editor: "true", stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(commands.length, failed === "git" ? 1 : 2);
    if (failed !== "git") assert.equal(commands[1].timeout, 60000);
    if (failed) {
      assert.equal(result.doctor, null);
      assert.equal(result.steps.at(-1).status, "error");
      assert.match(result.steps.at(-1).error, /fixture failure/);
    } else assert.equal(result.doctor.ready, 1);
  }
  const dry = run(["update", "--dry-run", "--json"]);
  assert.equal(dry.status, 0);
  assert.deepEqual(JSON.parse(dry.stdout).steps.map(({ status }) => status), ["planned", "planned"]);
});

test("custom recipe validation reports file errors without breaking valid runtime entries", (t) => {
  const { cwd, configDir, run } = fixture(t);
  const project = join(cwd, ".brushrouter", "recipes");
  const trust = join(configDir, "recipes");
  const extra = join(cwd, "extra");
  for (const dir of [project, trust, extra]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(trust, "trusted.json"), '{"id":"trusted","text":"Trusted prompt"}');
  writeFileSync(join(extra, "look.json"), '{"styles":[{"id":"extra-look","text":"Extra style"}]}');
  writeFileSync(join(project, "mixed.json"), JSON.stringify({ recipes: {}, styles: [
    { id: "survivor", text: "Prompt about {subject}", negatives: "not an array", image: {} },
    null,
    { id: "trusted", text: "Untrusted override" },
  ] }));
  writeFileSync(join(project, "syntax.json"), "{broken");
  const extraEnv = { BRUSHROUTER_EXTRA_RECIPES_DIRS: extra + delimiter + join(cwd, "missing") };
  const checked = run(["recipes", "validate", "--json"], { extraEnv });
  assert.equal(checked.status, 1, checked.stderr);
  const report = JSON.parse(checked.stdout);
  assert.deepEqual(report.directories, [trust, extra, join(cwd, "missing"), project]);
  const mixed = report.files.find(({ file }) => file.endsWith("mixed.json"));
  assert.equal(mixed.entries, 1);
  for (const message of [/recipes: expected/, /image.skeleton/, /negatives/, /expected non-empty/, /cannot override/]) {
    assert.ok(mixed.errors.some((s) => message.test(s)), mixed.errors.join("\n"));
  }
  assert.ok(report.files.find(({ file }) => file.endsWith("syntax.json")).errors.length);
  const runtime = run(["prompts", "--id", "survivor", "--full", "--json"], { extraEnv });
  assert.equal(runtime.status, 0, runtime.stderr);
  assert.match(runtime.stdout, /survivor/);
  assert.match(runtime.stderr, /syntax\.json/);
  const projectOnly = run(["recipes", "validate", project, "--json"], { extraEnv });
  assert.equal(projectOnly.status, 1);
  assert.match(projectOnly.stdout, /cannot override/);
  const explicit = run(["recipes", "validate", extra, "--json"], { extraEnv: { BRUSHROUTER_NO_CUSTOM_RECIPES: "1" } });
  assert.equal(explicit.status, 0);
  assert.equal(JSON.parse(explicit.stdout).files[0].entries, 1);
  const bundled = run([project], { script: recipeCheck });
  assert.equal(bundled.status, 2);
  assert.match(bundled.stderr, /only checks bundled recipes/);
});
