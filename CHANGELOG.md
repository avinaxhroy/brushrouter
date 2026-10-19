# Changelog

## [0.2.1] - 2026-10-19

- Packaging fix: `scripts/gptweb2api-hideconversations.patch` is now included in the npm tarball. It previously existed only in git checkouts, so `npm install` silently skipped the hide-conversations hook and left throwaway image chats in ChatGPT account history while git-clone installs got the cleanup.
- Packaging guard: New `tests/packaging.test.js` resolves every package-relative path read by shipped code and fails if `package.json` `"files"` would exclude it, so a runtime-read file outside `src/` can no longer be dropped from a release unnoticed.
- Clearer failure: The source-build vendor path now logs a warning when the hide-conversations patch is absent instead of continuing without it.

## [0.2.0] - 2026-10-19

- DeepSeek Harness (DSH) support: `brushrouter install` detects and wires brushrouter into DeepSeek Harness profiles (`~/.dsh/profiles/<profile>/cordis.patch.yml`) using its YAML patch format, with `BRUSHROUTER_DSH_PROFILE` override support, idempotent marker blocks, and config backups.
- Smart harness detection in `brushrouter rules`: Probes for installed coding tool harnesses (Claude Code, Codex CLI, Gemini CLI, Cursor, Windsurf, Copilot, Junie, DeepSeek Harness, Pi, Oh-My-Pi, OpenCode) before injecting guidance, ensuring only relevant rule files are updated by default.
- Expanded coding tool rule targets: Added definitions for `gemini-global` (`~/.gemini/GEMINI.md`), `dsh-global` (`~/.dsh/AGENTS.md`), `project-copilot` (`.github/copilot-instructions.md`), `project-junie` (`.junie/guidelines.md`), and `project-cursor-mdc` (`.cursor/rules/brushrouter.mdc`).
- Advanced `rules` CLI targeting flags: `--all` (target every known harness even if undetected), `--only <ids>` (cherry-pick specific targets), `--global` / `--project` filters, and `-v` / `--verbose` to inspect skip rationale.
- Safer `--create` scoping: Bare `brushrouter rules --create` restricts creation to project-level files (such as `AGENTS.md`); global rule file creation requires explicit `--global` or `--all`.
- Dynamic MCP version: `src/mcp.js` now dynamically resolves `serverInfo.version` from `package.json`.
- Credential safety: Increased `MAX_REDACT_DEPTH` from 8 to 32 to support deeply nested configuration objects safely without premature pruning.
- Test harness isolation: Isolated `HOME` directory during `install.sh` automated tests.
- Documentation: Added `CONTRIBUTING.md` guide and updated `README.md` with DeepSeek Harness configuration and `rules` command examples.

## [0.1.0] - 2026-02-18

Initial public release.

- Provider-agnostic image generation router: ChatGPT (Codex CLI + direct backend), Antigravity/Gemini CLI, OpenRouter, fal.ai, vendored ChatGPT web gateway, and custom HTTP template endpoints, with automatic fallback between connected routes.
- Prompt library: 27 tested job recipes + 137 visual looks vendored from VigoZhao/AI-Visual-Prompt-Cookbook (pinned commit, license + attribution intact).
- MCP server (`brushrouter serve`) with `generate_image` (sync/async by job id), `image_result`, and `find_image_prompts`; one-command agent wiring via `brushrouter install` (Claude Code, Claude Desktop, Cursor, Windsurf, OpenCode, Pi, Oh-My-Pi, Cline, Roo Code).
- Credential safety: browser-login OAuth for ChatGPT, redactor on every emitted string, keys in a `0600` store, zero tokens inside the MCP surface.
- CLI: `gen`, `batch`, `prompts`, `routes`, `models`, `providers`, `doctor`, `setup`, `rules`, `update`.
