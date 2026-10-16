import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  detectRuleFiles,
  injectRuleToFile,
  RULE_START_MARKER,
  RULE_END_MARKER,
  BRUSHROUTER_RULE_BODY,
  BRUSHROUTER_RULE_SNIPPET,
} from "../src/util/rules.js";

test("detectRuleFiles accurately detects existing and missing files", () => {
  const dir = mkdtempSync(join(tmpdir(), "rules-detect-test-"));
  try {
    const agentsPath = join(dir, "AGENTS.md");
    writeFileSync(agentsPath, "# Existing Agent Rules\n");

    const detected = detectRuleFiles({ cwd: dir, home: dir });
    const projectAgents = detected.find((d) => d.id === "project-agents");
    assert.ok(projectAgents);
    assert.equal(projectAgents.exists, true);
    assert.equal(projectAgents.hasRule, false);

    const projectClaude = detected.find((d) => d.id === "project-claude");
    assert.ok(projectClaude);
    assert.equal(projectClaude.exists, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("injectRuleToFile appends cleanly to an existing rule file", () => {
  const dir = mkdtempSync(join(tmpdir(), "rules-inject-test-"));
  try {
    const filePath = join(dir, "AGENTS.md");
    writeFileSync(filePath, "# My Project Rules\n\nRule 1: Be fast.\n");

    const res = injectRuleToFile(filePath);
    assert.equal(res.status, "updated");
    assert.ok(res.backup);
    assert.ok(existsSync(res.backup));

    const content = readFileSync(filePath, "utf8");
    assert.ok(content.startsWith("# My Project Rules\n\nRule 1: Be fast."));
    assert.ok(content.includes(RULE_START_MARKER));
    assert.ok(content.includes(RULE_END_MARKER));
    assert.ok(content.includes(BRUSHROUTER_RULE_BODY));

    // Calling again returns already-current
    const res2 = injectRuleToFile(filePath);
    assert.equal(res2.status, "already-current");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("injectRuleToFile updates existing rule block when outdated", () => {
  const dir = mkdtempSync(join(tmpdir(), "rules-update-test-"));
  try {
    const filePath = join(dir, "CLAUDE.md");
    writeFileSync(
      filePath,
      `# Top\n\n${RULE_START_MARKER}\nOld Outdated Rule Body\n${RULE_END_MARKER}\n\n# Bottom\n`
    );

    const res = injectRuleToFile(filePath);
    assert.equal(res.status, "updated");

    const content = readFileSync(filePath, "utf8");
    assert.ok(content.includes("# Top"));
    assert.ok(content.includes("# Bottom"));
    assert.ok(content.includes(BRUSHROUTER_RULE_BODY));
    assert.ok(!content.includes("Old Outdated Rule Body"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("injectRuleToFile respects dry-run and create options", () => {
  const dir = mkdtempSync(join(tmpdir(), "rules-dry-test-"));
  try {
    const nonExistent = join(dir, "non-existent.md");
    const res1 = injectRuleToFile(nonExistent, { create: false });
    assert.equal(res1.status, "not-present");

    const res2 = injectRuleToFile(nonExistent, { create: true, dry: true });
    assert.equal(res2.status, "would-create");
    assert.equal(existsSync(nonExistent), false);

    const res3 = injectRuleToFile(nonExistent, { create: true, dry: false });
    assert.equal(res3.status, "created");
    assert.equal(existsSync(nonExistent), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI rules --dry-run and --version execute successfully", () => {
  const binPath = resolve("./bin/brushrouter.js");
  
  const ver = spawnSync(process.execPath, [binPath, "--version"], { encoding: "utf8" });
  assert.equal(ver.status, 0);
  assert.match(ver.stdout, /brushrouter v\d+\.\d+\.\d+/);

  const rulesDry = spawnSync(process.execPath, [binPath, "rules", "--dry-run"], { encoding: "utf8" });
  assert.equal(rulesDry.status, 0);
  assert.match(rulesDry.stdout, /brushrouter rules — Coding Tool Guidance Injection/);

  const updateDry = spawnSync(process.execPath, [binPath, "update", "--dry-run"], { encoding: "utf8" });
  assert.equal(updateDry.status, 0);
  assert.match(updateDry.stdout, /brushrouter update/);
  assert.match(updateDry.stdout, /Dry run:/);

  const pkg = JSON.parse(readFileSync(resolve("./package.json"), "utf8"));
  assert.equal(pkg.bin.brushrouter, "./bin/brushrouter.js");
  assert.equal(pkg.bin.br, "./bin/brushrouter.js");
});
