import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  stripJsonComments,
  safeParseJsonc,
  getKnownAgentConfigs,
  detectInstalledAgents,
  getBrushrouterMcpEntry,
  installMcpToAgent,
} from "../src/util/mcp-install.js";

test("stripJsonComments removes single-line and multi-line comments and trailing commas", () => {
  const jsonc = `
  {
    // Single line comment
    "mcpServers": {
      /* Multi-line
         comment */
      "test": {
        "command": "test",
      },
    },
  }
  `;
  const parsed = safeParseJsonc(jsonc);
  assert.deepEqual(parsed, {
    mcpServers: {
      test: {
        command: "test",
      },
    },
  });
});

test("safeParseJsonc handles invalid JSON without crashing", () => {
  assert.throws(() => safeParseJsonc("this is not { valid json"), /JSON/);
});

test("getKnownAgentConfigs includes standard agents and extra from env", () => {
  const custom1 = join(tmpdir(), "custom1.json");
  const custom2 = join(tmpdir(), "custom2.json");
  const env = { BRUSHROUTER_MCP_CONFIGS: `${custom1}:${custom2}` };
  const configs = getKnownAgentConfigs({ env, platform: "darwin" });
  const names = configs.map((c) => c.name);

  assert.ok(names.includes("claude"));
  assert.ok(names.includes("claude-desktop"));
  assert.ok(names.includes("cursor"));
  assert.ok(names.includes("omp"));
  assert.ok(names.includes("windsurf"));
  assert.ok(names.includes("opencode"));
  assert.ok(names.includes("zed"));
  assert.ok(names.includes("custom-1"));
  assert.ok(names.includes("custom-2"));

  const c1 = configs.find((c) => c.name === "custom-1");
  assert.equal(c1.path, custom1);
});

test("detectInstalledAgents discovers installed vs missing agents", () => {
  const dir = mkdtempSync(join(tmpdir(), "br-agent-test-"));
  try {
    const agentConfigPath = join(dir, "agent", "mcp.json");
    mkdirSync(join(dir, "agent"), { recursive: true });
    writeFileSync(agentConfigPath, JSON.stringify({ mcpServers: { other: { command: "x" } } }));

    const mockConfigs = [
      { name: "test-agent", path: agentConfigPath, key: "mcpServers" },
      { name: "missing-agent", path: join(dir, "nonexistent", "mcp.json"), key: "mcpServers" },
    ];

    const detected = detectInstalledAgents(mockConfigs);
    assert.equal(detected.length, 2);

    const agent1 = detected.find((d) => d.name === "test-agent");
    assert.equal(agent1.exists, true);
    assert.equal(agent1.isInstalled, true);
    assert.equal(agent1.hasBrushrouter, false);

    const agent2 = detected.find((d) => d.name === "missing-agent");
    assert.equal(agent2.exists, false);
    assert.equal(agent2.isInstalled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installMcpToAgent updates existing config and preserves other servers", () => {
  const dir = mkdtempSync(join(tmpdir(), "br-install-test-"));
  try {
    const configPath = join(dir, "mcp.json");
    const initial = {
      mcpServers: {
        otherTool: { command: "node", args: ["other.js"] },
      },
    };
    writeFileSync(configPath, JSON.stringify(initial, null, 2));

    const agent = { name: "test", path: configPath, key: "mcpServers" };
    const entry = { command: "brushrouter", args: ["serve"] };

    // Dry run first
    const dryRes = installMcpToAgent(agent, entry, { dry: true });
    assert.equal(dryRes.status, "would-update");
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).mcpServers.brushrouter, undefined);

    // Real run
    const res = installMcpToAgent(agent, entry);
    assert.equal(res.status, "updated");
    assert.ok(res.backup);
    assert.ok(existsSync(res.backup));

    const updated = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(updated.mcpServers.otherTool, initial.mcpServers.otherTool);
    assert.deepEqual(updated.mcpServers.brushrouter, entry);

    // Subsequent run should detect already installed
    const repeatRes = installMcpToAgent(agent, entry);
    assert.equal(repeatRes.status, "already-installed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installMcpToAgent creates file if parent directory exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "br-create-test-"));
  try {
    const configPath = join(dir, "mcp.json");
    const agent = { name: "test-new", path: configPath, key: "mcpServers" };
    const entry = { command: "brushrouter", args: ["serve"] };

    const res = installMcpToAgent(agent, entry);
    assert.equal(res.status, "created");
    assert.ok(existsSync(configPath));

    const written = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(written.mcpServers.brushrouter, entry);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installMcpToAgent supports Zed context_servers format", () => {
  const dir = mkdtempSync(join(tmpdir(), "br-zed-test-"));
  try {
    const configPath = join(dir, "settings.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        theme: "One Dark",
        context_servers: {
          existing: { command: "x" },
        },
      })
    );
    const agent = { name: "zed", path: configPath, key: "context_servers" };
    const entry = { command: "brushrouter", args: ["serve"] };

    const res = installMcpToAgent(agent, entry);
    assert.equal(res.status, "updated");

    const written = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(written.theme, "One Dark");
    assert.deepEqual(written.context_servers.brushrouter, entry);
    assert.deepEqual(written.context_servers.existing, { command: "x" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("installMcpToAgent handles DeepSeek Harness (dsh) YAML patch format", () => {
  const dir = mkdtempSync(join(tmpdir(), "br-dsh-test-"));
  const profileDir = join(dir, "profiles", "desktop");
  mkdirSync(profileDir, { recursive: true });
  const entry = { command: "brushrouter", args: ["serve"] };

  try {
    const patchPath = join(profileDir, "cordis.patch.yml");
    const agent = { name: "dsh", label: "DeepSeek Harness (DSH)", path: patchPath, custom: "dsh-yaml" };

    // 1. Appends our block to a populated patch file, preserving user entries.
    writeFileSync(
      patchPath,
      "- id: mcp-semble\n  name: \"@deepseek-ai/dsh-mcp-client\"\n  config:\n    serverName: semble\n\n# user comment kept\n"
    );
    const res = installMcpToAgent(agent, entry);
    assert.equal(res.status, "updated");
    assert.ok(res.backup && existsSync(res.backup));

    const content = readFileSync(patchPath, "utf8");
    assert.ok(content.includes("serverName: semble"));
    assert.ok(content.includes("# user comment kept"));
    assert.ok(content.includes("serverName: brushrouter"));
    assert.ok(content.includes('args: ["serve"]'));

    // 2. Idempotent.
    assert.equal(installMcpToAgent(agent, entry).status, "already-installed");

    // 3. Stale block is replaced in place, user entries preserved.
    writeFileSync(
      patchPath,
      "# doc\n"
        + "# <!-- BRUSHROUTER_START -->\n"
        + "- id: mcp-brushrouter\n"
        + "  config:\n    command: old\n"
        + "# <!-- BRUSHROUTER_END -->\n"
        + "\n- id: mcp-semble\n"
    );
    const res2 = installMcpToAgent(agent, entry);
    assert.equal(res2.status, "updated");
    const content2 = readFileSync(patchPath, "utf8");
    assert.ok(content2.includes("command: brushrouter"));
    assert.ok(!content2.includes("command: old"));
    assert.ok(content2.includes("mcp-semble"));
    assert.ok(content2.includes("# doc"));

    // 4. Bare `[]` is replaced with our block (stays a valid list).
    writeFileSync(patchPath, "[]\n");
    assert.equal(installMcpToAgent(agent, entry).status, "updated");
    const content3 = readFileSync(patchPath, "utf8");
    assert.ok(content3.includes("- id: mcp-brushrouter"));
    assert.ok(!content3.includes("[]"));

    // 5. Detect flags DSH via the marker block, with no JSON parse error.
    const detected = detectInstalledAgents([agent]);
    assert.equal(detected[0].hasBrushrouter, true);
    assert.equal(detected[0].parseError, null);

    // 6. Missing parents refuse unless forced.
    const absent = { name: "dsh", path: join(dir, "no", "such", "cordis.patch.yml"), custom: "dsh-yaml" };
    assert.equal(installMcpToAgent(absent, entry).status, "not-present");
    assert.equal(installMcpToAgent(absent, entry, { force: true }).status, "created");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install.sh script syntax and execution", () => {
  const check = spawnSync("bash", ["-n", "install.sh"]);
  assert.equal(check.status, 0);
  const home = mkdtempSync(join(tmpdir(), "br-install-test-"));
  try {
    const run = spawnSync("./install.sh", ["--help"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /brushrouter installer/);
    assert.match(run.stdout, /provider-agnostic image generation router/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test("getKnownAgentConfigs adapts to Windows, Linux, and macOS platforms", () => {
  const home = "/Users/testuser";
  const appData = "C:\\Users\\testuser\\AppData\\Roaming";
  
  // Windows
  const winConfigs = getKnownAgentConfigs({
    env: { APPDATA: appData },
    home: "C:\\Users\\testuser",
    os: "win32",
  });
  const winClaudeDesktop = winConfigs.find((c) => c.name === "claude-desktop");
  assert.ok(winClaudeDesktop);
  assert.equal(winClaudeDesktop.path, join(appData, "Claude", "claude_desktop_config.json"));

  // Linux
  const linuxConfigs = getKnownAgentConfigs({
    env: {},
    home: "/home/testuser",
    os: "linux",
  });
  const linuxClaudeDesktop = linuxConfigs.find((c) => c.name === "claude-desktop");
  assert.ok(linuxClaudeDesktop);
  assert.equal(linuxClaudeDesktop.path, "/home/testuser/.config/Claude/claude_desktop_config.json");

  // macOS
  const macConfigs = getKnownAgentConfigs({
    env: {},
    home: "/Users/testuser",
    os: "darwin",
  });
  const macClaudeDesktop = macConfigs.find((c) => c.name === "claude-desktop");
  assert.ok(macClaudeDesktop);
  assert.equal(macClaudeDesktop.path, "/Users/testuser/Library/Application Support/Claude/claude_desktop_config.json");
});

