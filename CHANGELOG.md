# Changelog

## [0.2.5] - 2026-10-29

- **Prompt library creativity & agent ergonomics:** added direct `recipe`/`look`/`values`/`twist`/`includeNegatives` support to MCP `generate_image` and CLI `gen` (auto-mapping `ratio` to `size`), added `composePrompt()` to layer any look's `styleLock`/`doNotClone` onto any job layout, exposed native MCP `prompts` (`prompts/list`, `prompts/get`) and `resources` (`brushrouter://categories`, `brushrouter://slots`, `brushrouter://recipes[/<id>]`), added diverse `mode: "brainstorm"` / `diverse: true` exploration and zero-hit `suggestions`, relaxed aesthetic slots in `fill()` into open creative suggestions (keeping strict validation on `ratio`), and layered optional user/project custom recipes from `~/.config/brushrouter/recipes/` and `.brushrouter/recipes/` (plus `BRUSHROUTER_EXTRA_RECIPES_DIRS`) on top of built-ins.
- **Security hardening:** contained `codex-cli` and `gemini` output-path resolution inside their scratch directories (`isPathInside`) to prevent arbitrary local file reads, added output magic-byte validation and `redact()` error scrubbing to `gemini`; added SSRF and redirect-hop validation (`assertSafeImageDownloadUrl`) to provider image downloads and own-property checks (`Object.hasOwn`) to `resolvePath`; guarded `deepMerge` against prototype-polluting keys; switched Windows OAuth browser launch from `cmd /c start` to `rundll32.exe` with URL scheme validation and `timingSafeEqual` state checks; validated `gptweb2api` git refs and HTTPS release/checksum verification (`timingSafeEqual`); enforced `chmodSync(0o600)` after `codex` `persistAuth()`, guarded non-object `keys.json` in `saveKey()`, and enforced `readBodyCapped()` limits on the `arrayBuffer()` fallback.
- **Installer & CLI fixes:** fixed `install.sh` failing under `set -u` when invoked without arguments (`$1: unbound variable`), fixed unknown CLI commands printing `[object Object]`, wired `--images` into `gen --dry-run` ordering, made `batch --dry-run` enforce `--provider`/`--fallback` and configured per-provider concurrency, added `--offset` (and `limit`/`offset`/`hasMore` JSON fields) to `prompts`, and enabled free-plan `gptweb2api` routing in `brushrouter login`.
- **Provider, OAuth & router hardening:** fixed `gptweb2api` `credentialMode()` throwing instead of falling back to cookie-only auth or returning `auth: "needs-login"` from `probe()`, switched `gptweb2api` source-build `git`/`go` invocations from `exec` to `execFile`, bounded sidecar stderr retention, added timeouts to GitHub/`healthz` fetches, and prevented orphan sidecar leaks when `shutdownSidecar()` races with startup; fixed `codex` token refresh persistence for non-`openai` `pi`/`omp` auth keys, cleared `fetchWithTimeout` abort timers when `codex` SSE streams settle, and added 401 token-refresh retry on the direct Codex images endpoint; hardened `codex-cli` process settlement, stdin `EPIPE` handling, reference-image validation, and output magic-byte checks; fixed `oauth` `runLogin()` to bind the callback server before opening the browser, use `execFile`, and time out token exchange; made `fal` and `gemini` fail loudly with `UNSUPPORTED` when given reference images; stripped trailing slashes from OpenRouter `probe()` `baseUrl`; applied the transparent-background prompt hint in `batchGenerate`, cached per-provider concurrency limits, and avoided sleeping for cooldowns on incompatible providers.
- **Validation, parity, performance & redaction:** switched `saveImage` to atomic `wx` creation to close concurrent overwrite races, read `readImageAsDataUrl` from the already-opened descriptor, eliminated O(N^2) stdin byte-length rescanning in `serveMcp`, added regular-file and size checks to `assertImageFile`, used `safeParseMessage` when reporting corrupt `keys.json` and JSONC MCP configs (removing the duplicate `invalid JSON:` prefix) and guarded non-object MCP config JSON, validated `generate_image` (`prompt`, `count`, `concurrency`, non-directory `out`) and `batch_generate_images` (`prompts`/`items`, `concurrency`) fail-fast in both sync and async MCP modes, exposed per-item `images` in the `batch_generate_images` MCP schema, stored MCP job `savedPath` entries as arrays instead of `"; "`-joined strings, fixed `injectRuleToFile` marker matching and error redaction, guarded zero-dimension `sizeToAspectRatio` / multi-slash OpenRouter `baseUrl`, and updated stale `enabled: false` comments in `src/config.js`.

- **Breaking — disabled routes:** `enabled: false` now also refuses an explicit `--provider` and `batch --provider`, with a `PROVIDER_DISABLED` error; `--fallback` cannot bypass it.
- **Breaking — project config:** `brushrouter.config.json` is filtered by an allow-list (model, priority, size, timeout, concurrency). Endpoints, binaries, credentials, headers and bodies are dropped with a warning.
- **MCP `count`:** implemented (max 8) — each variation gets its own file (`out-1.png`…), partial failures are reported, and `isError` is true only when none succeeded.
- **MCP paging:** `find_image_prompts` gains `offset`/`hasMore`; `limit` is validated, and `total` now counts matches instead of the page length.
- **MCP jobs:** retention is measured from completion, a job that never settles fails after 6 h, an evicted payload is re-cached, and a missing image reports an error instead of a success with no image.
- **JSON-RPC:** batch arrays are answered per element, and notifications no longer receive a response.
- **CLI:** `gen` rejects multiple bare prompts and a directory passed to `-o`; `batch` rejects malformed JSON instead of sending it as a prompt.
- **CLI:** a leading flag no longer swallows the command (`--json providers` now runs), and piped output is flushed before every exit.
- **`setup`:** `--dry-run` stops at the plan (no login, keys, route flips or `npm link`), and the command exits after its last prompt instead of hanging.
- **Config paths:** `init`, `doctor` and key storage resolve `BRUSHROUTER_*` at use time, not to the import-time default the loader never read.
- **Routing:** a 404 from a wrong `baseUrl` is reported as `BAD_URL` instead of being retried as a modality signal across every model.
- **Providers:** image bytes are validated before saving, URL templates are percent-encoded (`#`/`&` in a prompt used to truncate or inject), and reference images fail loudly rather than silently vanish.
- **Timeouts:** `fetchWithTimeout` now covers the body, so a 200 followed by a stall no longer hangs.
- **Security:** OAuth rejects `?error=` and a bad state before rendering success and forces `auth.json` and its directory to 0600/0700; redaction covers AWS key shapes and secret-named fields of any length or type; JSON-RPC `id` and `progressToken` round-trip verbatim.
- **Fixes:** Gemini CLI `stdout` `ReferenceError`, unhandled `error` events on spawned children, a batch retry timer that let Node exit mid-run, a corrupt key store being overwritten, and `update` exiting 0 on failure.

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
