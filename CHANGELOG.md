# Changelog

## [0.1.0] - 2026-02-18

Initial public release.

- Provider-agnostic image generation router: ChatGPT (Codex CLI + direct backend), Antigravity/Gemini CLI, OpenRouter, fal.ai, vendored ChatGPT web gateway, and custom HTTP template endpoints, with automatic fallback between connected routes.
- Prompt library: 27 tested job recipes + 137 visual looks vendored from VigoZhao/AI-Visual-Prompt-Cookbook (pinned commit, license + attribution intact).
- MCP server (`brushrouter serve`) with `generate_image` (sync/async by job id), `image_result`, and `find_image_prompts`; one-command agent wiring via `brushrouter install` (Claude Code, Claude Desktop, Cursor, Windsurf, OpenCode, Pi, Oh-My-Pi, Cline, Roo Code).
- Credential safety: browser-login OAuth for ChatGPT, redactor on every emitted string, keys in a `0600` store, zero tokens inside the MCP surface.
- CLI: `gen`, `batch`, `prompts`, `routes`, `models`, `providers`, `doctor`, `setup`, `rules`, `update`.
