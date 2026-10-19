// Injection of brushrouter usage guidance into AI coding tools.
//
// DESIGN PRINCIPLES:
// 1. Clean & precise: concise instructions (~60 tokens), no context bulkup.
// 2. Safe & bounded: bounded by <!-- BRUSHROUTER_START --> and <!-- BRUSHROUTER_END -->.
// 3. Idempotent: running multiple times updates in-place without duplicating.
// 4. Zero loss: creates a backup (.bak-<timestamp>) before modifying any file.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";

export const RULE_START_MARKER = "<!-- BRUSHROUTER_START -->";
export const RULE_END_MARKER = "<!-- BRUSHROUTER_END -->";

export const BRUSHROUTER_RULE_BODY = `## Image Generation (brushrouter)
Use the \`brushrouter\` MCP server (\`generate_image\`, \`find_image_prompts\`) or CLI \`brushrouter gen "<prompt>" -o <path>\` for creating or editing any images, UI mockups, icons, or diagrams. Avoid manual script creation or ad-hoc web scraping for image tasks. For long generations, pass \`async: true\` and check \`image_result\`.`;

export const BRUSHROUTER_RULE_SNIPPET = `${RULE_START_MARKER}\n${BRUSHROUTER_RULE_BODY}\n${RULE_END_MARKER}`;

/**
 * Returns known coding tool rule file locations (both global and project-level).
 *
 * Each target carries a `probe`: a zero-arg predicate answering "is this harness
 * installed/relevant here?". `rules` is smart by default — it only writes where
 * the file exists OR the probe is true — and the user overrides with --all,
 * --global, --project, or --only <ids>.
 */
export function getKnownRuleTargets({ cwd = process.cwd(), home = homedir(), os = platform(), env = process.env } = {}) {
  const dir = (...parts) => existsSync(join(...parts));
  const appDir = (leaf) => dirHomeApp(home, os, env, leaf);
  const vscodeDir = dir(appDir("Code"));
  const jetbrainsDir = dir(appDir("JetBrains"));
  const anyTool = () => dir(home, ".claude") || dir(home, ".codex") || dir(home, ".gemini") || dir(home, ".pi") ||
    dir(home, ".omp") || dir(home, ".cursor") || dir(home, ".codeium") || dir(home, ".config", "opencode") ||
    existsSync(join(home, ".cursorrules"));

  return [
    // Global rule files
    {
      id: "omp-global",
      name: "Oh-My-Pi Global Rules",
      path: join(home, ".omp", "agent", "AGENTS.md"),
      scope: "global",
      probe: () => dir(home, ".omp"),
    },
    {
      id: "pi-global",
      name: "Pi Global Rules",
      path: join(home, ".pi", "agent", "AGENTS.md"),
      scope: "global",
      probe: () => dir(home, ".pi"),
    },
    {
      id: "codex-global",
      name: "Codex CLI Global Rules",
      path: join(home, ".codex", "AGENTS.md"),
      scope: "global",
      probe: () => dir(home, ".codex"),
    },
    {
      id: "dsh-global",
      name: "DeepSeek Harness (DSH) Global Rules",
      path: join(home, ".dsh", "AGENTS.md"),
      scope: "global",
      probe: () => dir(home, ".dsh"),
    },
    {
      id: "claude-global",
      name: "Claude Code Global Rules",
      path: join(home, ".claude", "CLAUDE.md"),
      scope: "global",
      probe: () => dir(home, ".claude"),
    },
    {
      id: "gemini-global",
      name: "Gemini CLI Global Rules",
      path: join(home, ".gemini", "GEMINI.md"),
      scope: "global",
      probe: () => dir(home, ".gemini"),
    },
    {
      id: "cursor-global",
      name: "Cursor Global Rules",
      path: join(home, ".cursorrules"),
      scope: "global",
      probe: () => dir(home, ".cursor") || existsSync(join(home, ".cursorrules")),
    },
    // Project-level rule files
    {
      id: "project-agents",
      name: "Project AGENTS.md",
      path: join(cwd, "AGENTS.md"),
      scope: "project",
      probe: anyTool,
    },
    {
      id: "project-claude",
      name: "Project CLAUDE.md",
      path: join(cwd, "CLAUDE.md"),
      scope: "project",
      probe: () => dir(home, ".claude"),
    },
    {
      id: "project-gemini",
      name: "Project GEMINI.md",
      path: join(cwd, "GEMINI.md"),
      scope: "project",
      probe: () => dir(home, ".gemini"),
    },
    {
      id: "project-cursor",
      name: "Project .cursorrules",
      path: join(cwd, ".cursorrules"),
      scope: "project",
      probe: () => dir(home, ".cursor") || existsSync(join(cwd, ".cursorrules")),
    },
    {
      id: "project-cursor-mdc",
      name: "Project Cursor Rule (.cursor/rules/brushrouter.mdc)",
      path: join(cwd, ".cursor", "rules", "brushrouter.mdc"),
      scope: "project",
      probe: () => dir(home, ".cursor"),
    },
    {
      id: "project-windsurf",
      name: "Project .windsurfrules",
      path: join(cwd, ".windsurfrules"),
      scope: "project",
      probe: () => dir(home, ".codeium"),
    },
    {
      id: "project-copilot",
      name: "Project Copilot Instructions (.github/copilot-instructions.md)",
      path: join(cwd, ".github", "copilot-instructions.md"),
      scope: "project",
      probe: () => dir(cwd, ".github") || dir(vscodeDir),
    },
    {
      id: "project-junie",
      name: "Project Junie Guidelines (.junie/guidelines.md)",
      path: join(cwd, ".junie", "guidelines.md"),
      scope: "project",
      probe: () => dir(cwd, ".junie") || dir(jetbrainsDir),
    },
  ];
}

// Per-app config dir under the OS's Application Support / AppData location.
function dirHomeApp(home, os, env, leaf) {
  if (os === "darwin") return join(home, "Library", "Application Support", leaf);
  if (os === "win32" && env.APPDATA) return join(env.APPDATA, leaf);
  return join(home, ".config", leaf);
}

/**
 * Detect which coding tool rule files exist on the current system/project.
 */
export function detectRuleFiles(options = {}) {
  const targets = getKnownRuleTargets(options);
  return targets.map((target) => {
    const exists = existsSync(target.path);
    const parentExists = existsSync(dirname(target.path));
    let hasRule = false;
    let isCurrent = false;
    let installed = false;

    if (target.probe) {
      try {
        installed = Boolean(target.probe());
      } catch {}
    }

    if (exists) {
      try {
        const content = readFileSync(target.path, "utf8");
        hasRule = content.includes(RULE_START_MARKER) && content.includes(RULE_END_MARKER);
        if (hasRule) {
          isCurrent = content.includes(BRUSHROUTER_RULE_BODY);
        }
      } catch {}
    }

    return {
      ...target,
      exists,
      parentExists,
      installed,
      hasRule,
      isCurrent,
    };
  });
}

/**
 * Injects or updates the brushrouter rule snippet in a single file.
 */
export function injectRuleToFile(filePath, { dry = false, create = false } = {}) {
  const exists = existsSync(filePath);
  if (!exists && !create) {
    return { status: "not-present", path: filePath };
  }

  if (!exists && create) {
    if (dry) {
      return { status: "would-create", path: filePath };
    }
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, BRUSHROUTER_RULE_SNIPPET + "\n");
      return { status: "created", path: filePath };
    } catch (e) {
      return { status: "error", error: e.message, path: filePath };
    }
  }

  // File exists: read and inspect
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (e) {
    return { status: "error", error: e.message, path: filePath };
  }

  const startIdx = content.indexOf(RULE_START_MARKER);
  const endIdx = content.indexOf(RULE_END_MARKER);

  if (startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx) {
    const currentBlock = content.slice(startIdx, endIdx + RULE_END_MARKER.length);
    if (currentBlock === BRUSHROUTER_RULE_SNIPPET) {
      return { status: "already-current", path: filePath };
    }
    // Update existing block
    if (dry) {
      return { status: "would-update", path: filePath };
    }
    const newContent = content.slice(0, startIdx) + BRUSHROUTER_RULE_SNIPPET + content.slice(endIdx + RULE_END_MARKER.length);
    const backup = `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      writeFileSync(backup, content);
      writeFileSync(filePath, newContent);
      return { status: "updated", backup, path: filePath };
    } catch (e) {
      return { status: "error", error: e.message, path: filePath };
    }
  }

  // Not present yet: append
  if (dry) {
    return { status: "would-update", path: filePath };
  }

  const separator = content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  const newContent = content + separator + BRUSHROUTER_RULE_SNIPPET + "\n";
  const backup = `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    writeFileSync(backup, content);
    writeFileSync(filePath, newContent);
    return { status: "updated", backup, path: filePath };
  } catch (e) {
    return { status: "error", error: e.message, path: filePath };
  }
}
