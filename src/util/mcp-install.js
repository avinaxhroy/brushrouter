// Agent MCP configuration discovery and installation.
//
// Detects installed AI agents across macOS, Linux, and Windows, and configures
// the brushrouter MCP server with zero manual JSON editing.
//
// Supported agents:
//   * Claude Code CLI (~/.claude.json)
//   * Claude Desktop (macOS, Linux, Windows)
//   * Cursor (~/.cursor/mcp.json)
//   * Oh-My-Pi (~/.omp/agent/mcp.json)
//   * Pi (~/.pi/agent/mcp.json)
//   * Windsurf (~/.codeium/windsurf/mcp_config.json)
//   * OpenCode (~/.config/opencode/mcp.json)
//   * CommandCode (~/.commandcode/mcp.json)
//   * Shared MCP (~/.config/mcp/mcp.json)
//   * Glass (~/.glass/mcp.json)
//   * Cline VS Code extension (macOS, Linux, Windows)
//   * Roo Code VS Code extension (macOS, Linux, Windows)
//   * Zed Editor (~/.config/zed/settings.json)
//   * Custom paths via BRUSHROUTER_MCP_CONFIGS
//
// Invariants:
//   * NEVER overwrite or remove other MCP servers.
//   * Always create a timestamped backup before modifying any existing file.
//   * Create valid JSON files if the agent directory exists but the config doesn't.
//   * Redact errors before displaying.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { isOnPath } from "./discover.js";
import { redact } from "./redact.js";

/**
 * Safely strip single-line (//) and multi-line comments from JSONC text
 * without stripping URLs or strings containing // or /*.
 */
export function stripJsonComments(text) {
  if (typeof text !== "string") return "";
  return text.replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) => (g ? "" : m));
}

export function safeParseJsonc(text) {
  const stripped = stripJsonComments(text).replace(/,\s*([\]}])/g, "$1");
  return JSON.parse(stripped);
}

/**
 * Resolve the absolute path to bin/brushrouter.js.
 */
export function getBinPath() {
  return fileURLToPath(new URL("../../bin/brushrouter.js", import.meta.url));
}

/**
 * The MCP entry structure written into agent configuration files.
 */
export function getBrushrouterMcpEntry({ preferPath = true } = {}) {
  if (preferPath && isOnPath("brushrouter")) {
    return { command: "brushrouter", args: ["serve"] };
  }
  return { command: "node", args: [getBinPath(), "serve"] };
}

/**
 * Return all known AI agent MCP configurations for the current operating system.
 */
export function getKnownAgentConfigs({ env = process.env, home = homedir(), os = platform() } = {}) {
  const isMac = os === "darwin";
  const isWin = os === "win32";

  // AppData path on Windows
  const appData = env.APPDATA || (isWin ? join(home, "AppData", "Roaming") : "");

  // Base list of standard agent MCP config locations
  const configs = [
    {
      name: "claude",
      label: "Claude Code CLI",
      path: join(home, ".claude.json"),
      key: "mcpServers",
    },
    {
      name: "claude-desktop",
      label: "Claude Desktop",
      path: isMac
        ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
        : isWin && appData
        ? join(appData, "Claude", "claude_desktop_config.json")
        : join(home, ".config", "Claude", "claude_desktop_config.json"),
      key: "mcpServers",
    },
    {
      name: "cursor",
      label: "Cursor",
      path: join(home, ".cursor", "mcp.json"),
      key: "mcpServers",
    },
    {
      name: "omp",
      label: "Oh-My-Pi",
      path: join(home, ".omp", "agent", "mcp.json"),
      key: "mcpServers",
    },
    {
      name: "pi",
      label: "Pi",
      path: join(home, ".pi", "agent", "mcp.json"),
      key: "mcpServers",
    },
    {
      name: "windsurf",
      label: "Windsurf",
      path: join(home, ".codeium", "windsurf", "mcp_config.json"),
      key: "mcpServers",
    },
    {
      name: "opencode",
      label: "OpenCode",
      path: join(home, ".config", "opencode", "mcp.json"),
      key: "mcpServers",
    },
    {
      name: "commandcode",
      label: "CommandCode",
      path: join(home, ".commandcode", "mcp.json"),
      key: "mcpServers",
    },
    {
      name: "shared-mcp",
      label: "Shared MCP",
      path: join(home, ".config", "mcp", "mcp.json"),
      key: "mcpServers",
    },
    {
      name: "glass",
      label: "Glass",
      path: join(home, ".glass", "mcp.json"),
      key: "mcpServers",
    },
    {
      name: "cline",
      label: "Cline (VS Code)",
      path: isMac
        ? join(home, "Library", "Application Support", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json")
        : isWin && appData
        ? join(appData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json")
        : join(home, ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
      key: "mcpServers",
    },
    {
      name: "roo-code",
      label: "Roo Code (VS Code)",
      path: isMac
        ? join(home, "Library", "Application Support", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "cline_mcp_settings.json")
        : isWin && appData
        ? join(appData, "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "cline_mcp_settings.json")
        : join(home, ".config", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "cline_mcp_settings.json"),
      key: "mcpServers",
    },
    {
      name: "zed",
      label: "Zed Editor",
      path: join(home, ".config", "zed", "settings.json"),
      key: "context_servers",
      optInOnly: true, // Editor-wide settings file; modify only when explicitly requested
    },
  ];

  const delimiter = isWin ? ";" : ":";
  const customList = (env.BRUSHROUTER_MCP_CONFIGS || "")
    .split(delimiter)
    .map((s) => s.trim())
    .filter(Boolean);

  customList.forEach((customPath, index) => {
    configs.push({
      name: `custom-${index + 1}`,
      label: `Custom (${customPath})`,
      path: customPath,
      key: "mcpServers",
    });
  });

  return configs;
}

/**
 * Detect all agent configurations and their current status on this system.
 */
export function detectInstalledAgents(options = {}) {
  const configs = Array.isArray(options) ? options : (options?.configs || getKnownAgentConfigs(options));
  return configs.map((agent) => {
    const exists = existsSync(agent.path);
    const parentDir = dirname(agent.path);
    const parentExists = existsSync(parentDir);
    let hasBrushrouter = false;
    let parseError = null;

    if (exists) {
      try {
        const raw = readFileSync(agent.path, "utf8");
        const data = safeParseJsonc(raw);
        const servers = data.mcpServers || data.servers || data.context_servers || {};
        hasBrushrouter = Boolean(servers.brushrouter);
      } catch (e) {
        parseError = redact(e.message);
      }
    }

    return {
      ...agent,
      exists,
      parentExists,
      isInstalled: exists || parentExists,
      hasBrushrouter,
      parseError,
    };
  });
}

/**
 * Install brushrouter MCP entry into a single agent config.
 *
 * @param {object} agent - Agent config object { name, path, key }
 * @param {object} entry - MCP entry { command, args }
 * @param {object} options - { dry: boolean, force: boolean }
 * @returns {object} Result { name, path, status, backup?, error?, key? }
 */
export function installMcpToAgent(agent, entry, { dry = false, force = false } = {}) {
  const exists = existsSync(agent.path);
  const parentDir = dirname(agent.path);
  const parentExists = existsSync(parentDir);

  if (!exists && !parentExists && !force) {
    return { name: agent.name, path: agent.path, status: "not-present" };
  }

  const defaultKey = agent.key || "mcpServers";

  if (!exists) {
    if (dry) {
      return { name: agent.name, path: agent.path, status: "would-create", key: defaultKey };
    }
    try {
      mkdirSync(parentDir, { recursive: true });
      const initial = { [defaultKey]: { brushrouter: entry } };
      writeFileSync(agent.path, JSON.stringify(initial, null, 2) + "\n");
      return { name: agent.name, path: agent.path, status: "created", key: defaultKey };
    } catch (e) {
      return { name: agent.name, path: agent.path, status: "error", error: redact(e.message) };
    }
  }

  let raw;
  try {
    raw = readFileSync(agent.path, "utf8");
  } catch (e) {
    return { name: agent.name, path: agent.path, status: "error", error: redact(e.message) };
  }

  let data;
  try {
    data = safeParseJsonc(raw);
  } catch (e) {
    return { name: agent.name, path: agent.path, status: "error", error: `invalid JSON: ${redact(e.message)}` };
  }

  // Determine which key is in use: mcpServers, servers, or context_servers
  const key = data.mcpServers ? "mcpServers" : data.servers ? "servers" : data.context_servers ? "context_servers" : defaultKey;
  data[key] = data[key] || {};

  const existing = data[key].brushrouter;
  if (existing && JSON.stringify(existing) === JSON.stringify(entry)) {
    return { name: agent.name, path: agent.path, status: "already-installed", key };
  }

  if (dry) {
    return { name: agent.name, path: agent.path, status: "would-update", key };
  }

  const backup = `${agent.path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    writeFileSync(backup, raw);
    data[key].brushrouter = entry;
    writeFileSync(agent.path, JSON.stringify(data, null, 2) + "\n");
    return { name: agent.name, path: agent.path, status: "updated", backup, key };
  } catch (e) {
    return { name: agent.name, path: agent.path, status: "error", error: redact(e.message) };
  }
}
