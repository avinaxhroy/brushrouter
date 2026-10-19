<p align="center">
  <img src="brushrouterlogo.png" alt="BrushRouter — three AI mascots flying toward a raccoon carrying image.png" width="720">
</p>

# brushrouter

**Generate images with the AI you already pay for.** One CLI + MCP server that routes every request to the best image backend on the machine — your ChatGPT subscription, your Google login, your OpenRouter key — in that order, falling back automatically. Logins you already pay for first, the pay-per-image key last. No new API balance, no browser tabs, and no credential ever handed to a model.

```console
$ brushrouter gen "a red fox in snow" -o fox.png
✓ generated with gemini (gemini-3.1-flash-image-preview)
  /home/you/fox.png (image/png, 1250 KB)
```

It also ships a prompt library of 27 tested recipes and 137 vendored visual styles, because routing a bad prompt to a working backend just gets you a bad image faster.

- **Zero new spend** per image on routes that reuse a login you already pay for
- **One command to start** — `brushrouter setup` detects what's installed and connects it
- **No tokens exposed** — models never see your credentials, enforced by a redactor on every output
- **164-prompt library** — an agent asks for "a nice product shot" and gets a tested skeleton to fill in, not its own invention
- **MCP-native** — `brushrouter install` wires it into any agent's image work in one command

## Install

Requires Node.js 20+.

```bash
curl -fsSL https://raw.githubusercontent.com/avinaxhroy/brushrouter/main/install.sh | bash
```

Or manually:

```bash
git clone https://github.com/avinaxhroy/brushrouter.git
cd brushrouter
npm link
brushrouter setup
```

Or instantly via npx: `npx brushrouter setup`.

`setup` auto-detects image backends (ChatGPT desktop CLI, ChatGPT subscriptions, Google/Antigravity CLI, agent auth stores), offers one-command login if none are found, verifies `brushrouter` is on your PATH, wires every detected agent's MCP config, and offers an optional test generation. Diagnose any time:

```bash
brushrouter doctor     # diagnoses all provider backends + agent MCP integrations
```

## Use

```bash
brushrouter gen "<prompt>" [options]

  -p, --provider <id>   Force a provider (see `brushrouter providers`)
  -f, --fallback        With --provider, fall back to others on failure
  -o, --out <path>      Output path (default: brushrouter-<timestamp>.png)
  -s, --size <WxH>      e.g. 1024x1024, auto
  -q, --quality <lvl>   low | medium | high | auto
      --background <b>  opaque | transparent (codex route sends the API field;
                        other routes ask for it in the prompt)
      --images <path>   Reference image for image-to-image (repeatable)
  -m, --model <id>      Pin a model for this call
      --dry-run         Print the route order that would be attempted, then stop
      --force           Overwrite --out instead of writing a new versioned file
      --json            Machine-readable output
  -v, --verbose         Show routing decisions
```

All commands (`br` works everywhere as a shorthand for `brushrouter`):

```bash
br providers        # what is connected, and how
br routes           # which routes auto-routing may use
br models           # model ids (live for OpenRouter)
br prompts          # 27 recipes + 137 looks for briefing an image
br doctor           # full connectivity diagnosis
br setup            # first-run auto-connect
br login            # sign in to ChatGPT for the codex route (browser OAuth, no API key)
br vendor gptweb2api  # install the browserless ChatGPT-web gateway binary
br batch            # generate several prompts in parallel across backends
br init             # write a starter config
br install          # add brushrouter to detected agent MCP configs
br rules            # inject compact guidance into AGENTS.md / .cursorrules
br update           # update to latest version and verify health
br serve            # run as an MCP server on stdio
```

### Reference images

`--images` only works on routes that accept it; `brushrouter providers` marks the ones that don't. Passing it to a route that can't is an error when you forced the provider, a warning when auto-routing picked it.

| route | reference images |
| --- | --- |
| `codex-cli`, `codex` | yes |
| `openrouter` | yes (`input_references` data URLs) |
| `custom-http` | yes (`{image}` data URL in your `body` template) |
| `gemini`, `native-web`, `gptweb2api`, `fal` | no — text-to-image only |

### Transparent backgrounds

```bash
brushrouter gen "a red paper lantern sticker" --background transparent -o sticker.png
```

Best on the `codex`/`codex-cli` routes, where transparent is a real API field (`output_format: "png"` makes the backend honor it). Other routes can only ask in the prompt, so check the file. Even with the field set, the model decides — subject-shaped prompts (*sticker*, *isolated object*) reliably come back RGBA; full-scene wording may stay flattened.

### Codex size behavior

Codex doesn't take pixel dimensions and reads aspect ratio from the prompt. brushrouter appends your `-s 1672x941` as "width 1672 pixels, height 941 pixels (16:9)" — common aspect ratios land exactly or within 1px; other exact pixel counts aren't guaranteed.

### Pinning a model

`brushrouter models` lists what each provider can do; for OpenRouter the list is live, so it shows exactly what your key can reach.

```bash
brushrouter models openrouter
brushrouter gen "a red fox" -p openrouter -m x-ai/grok-imagine-image-2.0
```

A pin (`-m`, or `providers.<id>.model` in config) is never silently swapped. With no pin, brushrouter walks a preference list and takes the first model that works. Pins are honored by `codex-cli`, `codex`, `openrouter`, `gemini`, and `custom-http`; `gptweb2api` reports that it ignored the pin rather than pretending otherwise.

Models are resolved at runtime, not hardcoded — the Codex backend reads your `~/.codex/config.toml`, and a different model is only tried when the error is specifically "model not found". Quota (`429 usage_limit_reached`), auth (`401`), and regional/balance errors are reported as-is and never masked by a retry.

### Turning routes off

```bash
brushrouter routes                    # show state, in auto-routing order
brushrouter routes disable gptweb2api # skip it during auto-routing
brushrouter routes enable  gptweb2api
```

A disabled route is still reachable with `--provider <id>`. Non-interactive: `BRUSHROUTER_DISABLE=gemini,fal` and `BRUSHROUTER_ENABLE=openrouter`.

## Auth sources for ChatGPT routes

The `codex` and `codex-cli` routes use ChatGPT browser login — **no API key anywhere**. Credentials come from the first of:

1. `providers.codex.authFile` in config, or `BRUSHROUTER_CODEX_AUTH_FILE` (explicit)
2. **`~/.config/brushrouter/auth.json` — written by `brushrouter login`**
3. `~/.codex/auth.json` — Codex CLI / ChatGPT desktop app
4. `~/.local/share/opencode/auth.json` — OpenCode login
5. `~/.omp/agent/auth.json`, `~/.pi/agent/auth.json` — pi and oh-my-pi OAuth logins

`brushrouter login` opens a browser and signs in via the codex CLI's public OAuth client (PKCE, localhost:1455 callback) — nothing else to install, and the token refreshes itself. It prints `plan go/plus/...` so you know which subscription is billing the route. Sign out by deleting `~/.config/brushrouter/auth.json`. Free-plan users get a plain "plan-gated" message, not a raw 403.

## Providers

| id | needs | notes |
| --- | --- | --- |
| `codex-cli` | ChatGPT/Codex desktop app | **Native, preferred.** Drives the app's own signed CLI — already logged in, brushrouter never sees the token. |
| `codex` | ChatGPT login with a paid plan (`brushrouter login`, or any login on disk) | Direct backend call (`gpt-image-2`). Shares the Codex text quota. |
| `gemini` | Antigravity (`agy`) or Gemini CLI login | Delegates to the CLI; Google tokens never touch brushrouter. |
| `openrouter` | `sk-or-...` key | Off by default — the only route billed per request. Key auto-discovered from env or existing agent stores. |
| `fal` | fal.ai key | |
| `gptweb2api` | ChatGPT login (free plans work) + vendored gateway — `brushrouter vendor gptweb2api` | Off by default. Browserless web-session route, separate quota bucket (~2-3 free-plan images/day; see `docs/TECHNICAL.md`). |
| `custom-http` | your own endpoint | Template-based; point it at any image API. |

Default auto-routing order:

```text
codex-cli → codex → gemini → openrouter → fal → gptweb2api → custom-http
```

Three routes are off by default: `openrouter` (spends money), `gptweb2api` (needs `vendor`), `custom-http` (needs an endpoint). Enable with `brushrouter routes enable openrouter`. The `priority` list is authoritative — anything not listed is never auto-selected, though `--provider` still works.

OpenRouter runs two generation surfaces: multimodal chat models on `/chat/completions`, image-only models on `/images`. A "no endpoints found for output modalities" rejection is auto-retried on `/images`; auth, region, and credit errors are surfaced as they came.

## The prompt library

An agent asked for "a nice product shot" will invent a worse prompt than one already tested. So the tool that routes the generation also hands the agent a skeleton to fill in.

164 entries:

| `kind` | what it is | count | source |
| --- | --- | --- | --- |
| `job` | a layout to fill in — a product shot, a character sheet | 27 | written here |
| `look` | a fixed visual system to borrow — an editorial or poster style | 137 | vendored, MIT |

```bash
brushrouter prompts                        # the map: what kinds of image exist
brushrouter prompts "product hero shot"    # 1 best match + 3 similar
brushrouter prompts "flyer" -n 1           # force exactly one
brushrouter prompts -c infographic --full  # a whole category, full skeletons
brushrouter prompts --input image          # only recipes that can use a photo
brushrouter prompts --kind look "mono noir editorial"
brushrouter prompts --id logo-mark --full --set text=ACME --set subject="a peak"
```

Design facts, briefly: every recipe works with no reference image (each has a text skeleton, plus an optional `image` upgrade naming what it accepts); unfilled `{slots}` are reported in `missing` rather than shipped to the image model; a query that matches nothing returns nothing — search is lexical with a hand-written alias map (*hero shot* → `product-hero`, *dashboard* → `app-screen`). Results are previews by default (id, goal, when to use it, missing slots, credit); `--full` for the skeleton; `limit` is capped at 10 because this fills the caller's context window.

Modes: `--mode categories` for a vague request, `--mode related` (default) for one best match plus alternatives, `--mode one` for a single entry.

### Attribution

The 137 looks come from [VigoZhao/AI-Visual-Prompt-Cookbook](https://github.com/VigoZhao/AI-Visual-Prompt-Cookbook), published under MIT. They're vendored — pinned by commit, verified by hash, normalized into the same schema, shipped with the upstream licence and `ATTRIBUTION.md`. Every look carries its credit on the result itself, previews included; the licence requires it. Point `BRUSHROUTER_STYLES_FILE` at nothing and the library runs jobs-only instead of crashing.

Reproduce the data — neither source is read at runtime, neither is hand-edited:

```bash
npm run recipes:check    # validate every recipe and look against the schema
npm run styles:vendor    # re-vendor the looks from the pinned commit
npm run styles:check     # re-fetch upstream, recompute stylesSha256, compare
npm run corpus:analyze   # reproduce the structural findings behind the design
npm run corpus:check     # re-fetch upstream, recompute corpusSha256, compare
```

The 150-prompt corpus in `data/prompts/` is a development fixture, excluded from the npm tarball; nothing at runtime reads it. Schema, retrieval design, and failure modes are in [`docs/TECHNICAL.md`](docs/TECHNICAL.md).

## MCP server

`brushrouter install` detects and wires brushrouter into your installed agents (Claude Code, Claude Desktop, Cursor, Windsurf, OpenCode, Pi, Oh-My-Pi, DeepSeek Harness/DSH, CommandCode, Glass, shared MCP configs). Configs are backed up first (`.bak-...`), comments and formatting preserved, and no existing servers removed. Or add it by hand:

```json
{
  "mcpServers": {
    "brushrouter": { "command": "brushrouter", "args": ["serve"] }
  }
}
```

DeepSeek Harness (DSH) has no mcpServers JSON — its servers are YAML patch entries in `~/.dsh/profiles/<profile>/cordis.patch.yml` (profile defaults to `desktop`; set `BRUSHROUTER_DSH_PROFILE` to change). `brushrouter install --agent dsh` writes the marker-bounded, idempotent block for you, or by hand:

```yaml
- id: mcp-brushrouter
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: brushrouter
    transport: stdio
    command: brushrouter
    args: ["serve"]
    toolCallTimeoutMs: 300000

```
Exposed tools:

- **`generate_image`** — `{ prompt, provider?, model?, fallback?, size?, quality?, out?, images?, async? }`. Returns the saved path plus the image, all text through the redactor. `async: true` returns a `jobId` immediately instead of blocking for a minute or two.
- **`image_result`** — `{ jobId }`. Collects an async generation; poll again on a status while the job runs.
- **`find_image_prompts`** — `{ query?, category?, kind?, input?, shape?, mode?, limit?, full?, id?, values?, seed? }`. Returns previews or a full skeleton to build from before generating. Its description tells the agent every entry works from text alone, that `{braces}` must be filled first, and to pass `input: "image"` only when it actually holds a photo.

An agent's normal loop is `find_image_prompts` → fill the skeleton → `generate_image`. Two separate tools on purpose: the agent reads and changes the prompt instead of a router substituting one.

The `initialize` result also carries an `instructions` string telling the model when to use brushrouter (configurable via `instructions` in config or `BRUSHROUTER_INSTRUCTIONS`; `""` disables). And for rule-file agents, `brushrouter rules` injects ~60 tokens of guidance into the rule files of 12+ harnesses — AGENTS.md (Codex, OpenCode, Zed, Pi, Oh-My-Pi, DeepSeek Harness), CLAUDE.md (Claude Code), GEMINI.md (Gemini CLI), .cursorrules / .cursor rules (Cursor), .windsurfrules (Windsurf), .github/copilot-instructions.md (Copilot), .junie/guidelines.md (Junie) — demarcated so it updates in place:

```bash
brushrouter rules             # syncs guidance where the harness is detected (smart
                              # default: file exists OR the harness is installed)
brushrouter rules -v          # like dry-run detail: see what was skipped and why
brushrouter rules --dry-run   # preview changes
brushrouter rules --create    # create missing *project* rule files (e.g. AGENTS.md)
brushrouter rules --global    # restrict to global rule files (creates globals
                              # alongside --create; bare --create never does)
brushrouter rules --all       # target every known harness, even undetected ones
brushrouter rules --only codex-global,project-agents  # cherry-pick by target id
```

```markdown
<!-- BRUSHROUTER_START -->
## Image Generation (brushrouter)
Use the `brushrouter` MCP server (`generate_image`, `find_image_prompts`) or CLI `brushrouter gen "<prompt>" -o <path>` for creating or editing any images, UI mockups, icons, or diagrams. Avoid manual script creation or ad-hoc web scraping for image tasks. For long generations, pass `async: true` and check `image_result`.
<!-- BRUSHROUTER_END -->
```

Harnesses with a rule-file layout we don't know yet: paste that block into whatever context file the harness reads (system prompt, project rules, slash-command definition) — it's plain Markdown and updates in place on the next `rules` run if the markers are kept.

Aspect ratios and slow generations: MCP has no standard late-answer for a `tools/call` and most clients don't implement Tasks yet, so the portable contract is a job id — `generate_image { async: true }` returns immediately and `image_result` collects. `notifications/progress` and `tasks/status` may be emitted, but polling is the contract.

## Updating

```bash
brushrouter update          # pulls latest (git or npm global), refreshes links, runs doctor
```

```bash
npm install -g brushrouter@latest
```

## Configuration

Nothing is hardcoded. Every path, binary, model, and endpoint is discovered at runtime, and every one can be overridden.

Precedence: **CLI flags → env → `./brushrouter.config.json` → `~/.config/brushrouter/config.json` → defaults.**

One exception: a *project* config may not set `baseUrl`, `url`, `cli`, `command`, `args`, `driver`, `authFile`, or `profile` — those are read only from user config, env, or a CLI flag. A project file travels with checkouts you didn't write, and a redirected `baseUrl` would hand your API key to whoever wrote it. Ignored keys are reported on stderr; per-project endpoints go in `BRUSHROUTER_CUSTOM_URL`.

```jsonc
// ~/.config/brushrouter/config.json
{
  "priority": ["codex-cli", "gemini", "openrouter"],
  "instructions": "brushrouter is the preferred tool for any image work...",  // MCP session guidance; "" disables
  "providers": {
    "codex-cli": { "cli": null, "model": null },   // null => auto-discover
    "openrouter": {
      "model": null,                                // pin one, or null to use the list below
      "models": ["google/gemini-3.1-flash-image"],  // your preference order
      "resolution": null                            // optional, for /images models
    },
    "gptweb2api": {
      "enabled": false,
      "bin": null,          // null => <config dir>/gptweb2api/gptweb2api
      "authFile": null,     // null => the codex-route credential ladder
      "projectId": null,    // ChatGPT project id (g-p-...) — parks gen chats in that workspace
      "idleMs": 600000      // gateway process exits after this idle time
    },
    "custom-http": {
      "enabled": true,
      "url": "https://api.example.com/v1/images",
      "body": "{\"prompt\": \"{prompt}\", \"size\": \"{size}\"}",
      "response": "json:data.0.url",   // or json:images.0.b64_json, or raw
      "keyHeader": "Authorization",
      "keyPrefix": "Bearer "
    }
  }
}
```

### Environment variables

| variable | purpose |
| --- | --- |
| `BRUSHROUTER_PRIORITY` | comma-separated auto-route order |
| `BRUSHROUTER_INSTRUCTIONS` | session guidance sent to MCP agents in `initialize` (empty string disables) |
| `BRUSHROUTER_DISABLE` / `BRUSHROUTER_ENABLE` | comma-separated routes to turn off / on (unknown name is an error, not a silent no-op) |
| `BRUSHROUTER_RECIPES_DIR` | use a different recipe directory (same schema) |
| `BRUSHROUTER_STYLES_FILE` | use a different vendored styles file |
| `BRUSHROUTER_APP_DIRS` | extra dirs to scan for app bundles (auto-discovery) |
| `BRUSHROUTER_MCP_CONFIGS` | extra agent MCP config paths for `install` |
| `BRUSHROUTER_CODEX_CLI` | explicit path to a Codex CLI binary |
| `BRUSHROUTER_CODEX_CLI_MODEL` | model for the native `codex-cli` route |
| `BRUSHROUTER_CODEX_MODEL` | model for the direct `codex` provider |
| `BRUSHROUTER_CODEX_AUTH_FILE` | explicit auth file for the direct `codex` provider |
| `BRUSHROUTER_CODEX_CLIENT_ID` | override the derived OAuth client id |
| `BRUSHROUTER_CODEX_ENDPOINT` | override the Codex responses endpoint |
| `BRUSHROUTER_OAUTH_TOKEN_ENDPOINT` | override the OAuth token endpoint |
| `BRUSHROUTER_ORIGINATOR` | `originator` header sent to the Codex backend |
| `BRUSHROUTER_GEMINI_CLI` / `BRUSHROUTER_GEMINI_MODEL` | Gemini CLI path / model |
| `BRUSHROUTER_OPENROUTER_KEY` / `BRUSHROUTER_OPENROUTER_MODEL` | OpenRouter key / pinned model |
| `BRUSHROUTER_OPENROUTER_MODELS` | comma-separated OpenRouter preference order |
| `BRUSHROUTER_OPENROUTER_RESOLUTION` | image resolution requested from OpenRouter |
| `BRUSHROUTER_FAL_KEY` / `BRUSHROUTER_FAL_MODEL` | fal.ai |
| `BRUSHROUTER_GPTWEB_COOKIE` | cookie fallback for the vendored gptweb2api route |
| `BRUSHROUTER_GPTWEB_PROJECT_ID` | ChatGPT project (`g-p-...`) that anchors gptweb2api generations |
| `BRUSHROUTER_CUSTOM_URL` / `BRUSHROUTER_CUSTOM_KEY` | custom HTTP |
| `BRUSHROUTER_OPENAI_KEY` | fallback key name read for the OpenAI-compatible routes (`OPENAI_API_KEY` also works) |

Discovery scans `$PATH`, `/Applications`, `~/Applications`, the npm global root, and `~/.cache/codex-runtimes`, so a Codex CLI installed any of the usual ways is found without configuration.

## Security

A model never sees your credentials. Design constraint, not a setting:

- Keys live in the environment or a `0600` `~/.config/brushrouter/keys.json` inside a `0700` directory. Config files hold non-secret settings only.
- Every string brushrouter emits — CLI output, `--json`, errors, `doctor`, MCP results — passes through a redactor that strips known secret values and well-known token shapes (JWTs, `sk-...`, `ya29.…`, `Bearer ...`, refresh tokens), plus tokens registered by value from disk. The test suite asserts a fake secret survives no output path.
- `codex-cli` and `gemini` never read a token at all: they spawn a child process that owns its own authentication.
- What it does *not* confine: `--out` writes anywhere you say and `--images` reads any local file that sniffs as an image. Deliberate — the caller is your own agent, which already has those abilities; the MCP tool description states the capability rather than implying a sandbox.

## Limits

brushrouter doesn't pretend a broken backend works.

- Quota (`429 usage_limit_reached`) is reported as quota, with reset time, and never triggers a wasteful model retry.
- Auth (`401`, or not logged in) is reported as auth, with the command to fix it.
- A retired model (`404 model_not_found`) is the only case that tries the next model.
- A deprecated free tier (e.g. Google's retired Gemini CLI individual tier) is labeled as such.

The Codex **text quota and the native image path share a bucket**; when exhausted, the native route says so and routing moves on. The ChatGPT *web* Images bucket is separate, but reaching it needs the gptweb2api route — the app's own conduit is App-Attest protected and can't be forged.

## Why I built this

Image generation is the one thing I refuse to pay per image for. I already pay for ChatGPT and already have a Google login — two capable image generators sitting on this machine — and I was still opening a browser tab or topping up an API balance. So the route order falls straight out of "spend what I already pay for first". The other two rules: ship the prompts too (a free image from a bad prompt is a wasted call), and never let a model see a token or pretend a broken backend works.

## Development

```bash
npm test                        # 144 tests, no dependencies
npm run recipes:check           # validate every recipe and look against the schema
npm run styles:check            # re-fetch the pinned cookbook, verify stylesSha256
node bin/brushrouter.js doctor
```

Zero runtime dependencies, ESM, Node 20+.

## Credits and license

MIT for the code, for the recipe library in `data/recipes/`, and for the normaliser that produces `data/styles/`. We wrote the recipes.

The direct Codex backend image generation integration (`images/generations` and `images/edits` for `gpt-image-2`), subscription auth discovery patterns, and prompt-driven aspect ratio handling were learned from and inspired by [yuji-hatakeyama/opencode-gpt-imagegen](https://github.com/yuji-hatakeyama/opencode-gpt-imagegen).

The 137 looks in `data/styles/` are vendored from [VigoZhao/AI-Visual-Prompt-Cookbook](https://github.com/VigoZhao/AI-Visual-Prompt-Cookbook) at a pinned commit, MIT (`Copyright (c) 2026 VigoZhao`); upstream `LICENSE` and `ATTRIBUTION.md` ship with them.

The 150-prompt corpus in `data/prompts/` is a development fixture, not shipped and not covered by that licence — third-party text redistributed under its upstream terms (115 rows CC0, 35 rows CC-BY, authors credited in `data/prompts/ATTRIBUTION.md`; full terms in `data/prompts/LICENSES/`). Quote a prompt along with its `author` and `sourceUrl`.

## Disclaimer

This is an **unofficial, third-party** tool, not affiliated with or endorsed by OpenAI, Google, OpenRouter, fal.ai, or OpenCode.

It calls the same Codex backend that OpenCode itself uses for ChatGPT subscription chat, through the image generation endpoints that the Codex CLI uses. Use must comply with OpenAI's [Terms of Use](https://openai.com/policies/row-terms-of-use/) and [Usage Policies](https://openai.com/policies/usage-policies/), as well as the terms and policies of any other supported provider.
