# brushrouter — Technical Design

How brushrouter works and why it is built the way it is. Written for someone who wants to modify, audit, or port it.

## 1. Problem

Image generation is fragmented across incompatible access models:

| access model | example | auth | billing |
|---|---|---|---|
| Bundled native CLI | Codex CLI inside the ChatGPT/Codex app | app's own login | subscription |
| First-party HTTP API | Codex `/backend-api/codex/responses` | OAuth bearer | subscription |
| Third-party CLI | Antigravity (`agy`), Gemini CLI | CLI's own OAuth | plan |
| Aggregator API | OpenRouter | API key | pay-per-use |
| Direct vendor API | fal.ai | API key | pay-per-use |
| Web session | chatgpt.com Images tab | browser cookies | web bucket |

Users have some of these, differing per machine, and should not have to remember which. Design requirements:

1. Auto-route across whatever is present; explicit override via `--provider`.
2. Auto-connect on first install; ask for credentials only if nothing is found.
3. No hardcoding — no paths, usernames, binaries, or model names baked in.
4. A model must never see a credential.

## 2. Architecture

```
bin/brushrouter.js          CLI entry: parse args, dispatch commands
  ├── src/config.js         layered config resolution (no secrets)
  ├── src/router.js         provider registry + attempt ordering
  ├── src/library.js        prompt library: recipes + looks, search, slot filling
  ├── src/mcp.js            stdio MCP server (JSON-RPC 2.0)
  ├── src/util/
  │     ├── common.js       JWT decode, mime detect, collision-safe save, SSE reader
  │     ├── discover.js     runtime discovery of CLIs, app bundles
  │     ├── keys.js         credential discovery + 0600 store (never prints)
  │     └── redact.js       secret redaction (values + shapes)
  ├── data/recipes/         27 authored recipes in 9 categories (shipped)
  ├── data/styles/          137 vendored looks, MIT + ATTRIBUTION.md (shipped)
  ├── data/prompts/         150-prompt analysis corpus (dev fixture, not shipped)
  └── src/providers/
        ├── codex-cli.js    native: drives the app's bundled Codex CLI
        ├── codex.js        direct Codex backend call
        ├── gemini.js       Google CLIs (agy / gemini)
        └── http.js         openrouter / fal / custom-http
```

### Provider contract

Every provider implements:

```js
{
  id, label, kind, note,
  async probe(cfg)  -> { available, auth, detail, expires?, ... },   // cheap, credential-free
  async generate({ prompt, size, quality, images, out, cwd, onProgress }, cfg)
                    -> { buffer: Buffer, meta: { provider, model, ... } }
}
```

`probe()` must be cheap and must not consume quota. In auto mode the router uses it to skip dead providers before attempting generation.

### Routing

`generate()` in `src/router.js`:

- **Explicit** (`--provider X`): attempt only `X` — or `X` first, then the rest of `priority`, when `--fallback` is given.
- **Auto**: walk `cfg.priority`, skip providers that are `enabled: false` or fail `probe()`, try each until one succeeds.

Every attempt is recorded, so the CLI and the MCP response can both report the full trail (`codex-cli=failed → codex=failed → gemini=ok`).

## 3. Native first

The first implementation drove headless Chromium against `chatgpt.com` with a persisted login and scraped the generated image out of the page. That route was removed: it broke on DOM changes, cost a full browser, and put brushrouter in the position of handling a live web session.

The replacement insight: **the ChatGPT/Codex desktop app bundles the official Codex CLI as a signed binary.**

```
/Applications/ChatGPT.app/Contents/Resources/codex
  -> codex-cli 0.155.0-alpha.2.6
  -> feature `image_generation` = stable
  -> `codex login status` -> "Logged in using ChatGPT"
```

The vendor already ships a supported, authenticated interface for exactly this task. Driving a second browser was re-implementing it, worse:

| | browser route | native route |
|---|---|---|
| breaks when web UI changes | yes | no |
| extra login | yes | no (reuses app login) |
| credentials touched by brushrouter | yes (session) | no (child process owns them) |
| resource cost | full browser | one CLI process |
| vendor support | none | it *is* the vendor's interface |

`src/providers/codex-cli.js` spawns the discovered CLI, asks it to write an image to a known path, and reads the bytes back. It parses `--json` output only for the image location and passes any surfaced text through the redactor.

One limitation, reported rather than hidden: the Codex backend exposes a single rate-limit bucket to the app-server protocol (`account/rateLimits/read` reports one bucket named `codex`, shared by text and native image generation). When it is exhausted, the native route fails with `usage_limit_reached` and the router falls through. The separate image-generation web bucket is covered below.

## 4. The ChatGPT image bucket

The desktop app tracks image generation in its own rate-limit bucket, distinct from the text bucket. That is why the web Images tab can keep working after text is exhausted. Evidence, from the shipped bundle and direct experiment:

1. The app bundle defines a separate limit id `image_gen` with its own `usageLimitExceeded` / `resetsAt` and a `banner_type` of `image_generation_limit_reached`. The app-server protocol (`codex app-server generate-json-schema`) models it: `ImageGenerationThreadItem` and `ImageGenerationFailure` carry `limitId` and `resetsAt`.
2. **`codex app-server`** (JSON-RPC over stdio: `initialize` → `thread/start` → `turn/start` with an image prompt) fails with the *text* limit: `codexErrorInfo: usageLimitExceeded`. The app-server path bills against the text bucket.
3. **The standalone `gpt-image` MCP server** (`gpt-image serve`, registered by Codex as a tool server) posts to the same endpoint — `https://chatgpt.com/backend-api/codex/responses` — and returns the same `429 usage_limit_reached`. Same bucket, different door.

No token, socket, or CLI subcommand exposes the `image_gen` bucket to an outside program through the app-server protocol. The route that does reach a separate image allowance is the web conversation API.

### The sentinel stack (what gates the web route)

The Images tab reaches `/backend-api/f/conversation` with a `conduitToken` and a requirements token — all solvable in-process from a plain bearer token, no browser required:

1. `chat-requirements/prepare`: a SHA3-512 proof-of-work over an 18-field fingerprint, plus the requirements token returned by the call.
2. `/backend-api/f/conversation/prepare`: yields the conduit token.

All three parts (PoW grinding, requirements token, conduit token) cost tens of milliseconds of local computation. Open-source implementations that validate this: `5yu4n/gptweb2api` (MIT, vendored here as the `gptweb2api` route) and `yukkcat/chatgpt2api` (AGPL — reference only, do not port code).

`gptweb2api` exists because the codex routes are gated by subscription: it is the browserless route to the web bucket for **free accounts**. It is off by default. It inherits churn risk: the sentinel SDK is version-pinned and changes, so if OpenAI re-hardens the path (Turnstile, or re-introduced attestation) this route dies with it.

### Chat cleanup for gptweb2api generations

Every browserless image generation is an ordinary **persistent** ChatGPT conversation (temporary chats offer no image tool), so each generation leaves a chat in the account history. Two mitigations, verified live against the sentinel/WAF stack:

- **Headless delete is not possible.** `PATCH /backend-api/conversation/{id}` (`is_visible: false`, same as the web UI) and `GET /backend-api/conversations` both return a WAF 403 for browserless traffic, while generation POSTs on `/backend-api/f/conversation` pass. The vendored hide hook (`scripts/gptweb2api-hideconversations.patch`) therefore only works when the gateway runs with a real browser-session cookie (`BRUSHROUTER_GPTWEB_COOKIE`) or behind a relay, and silently no-ops otherwise; rejections log one line to the sidecar's stderr. Opt out with `GPTWEB_AUTO_HIDE_CONVERSATIONS=0`.
- **Workspace anchoring.** Set `providers.gptweb2api.projectId` (or `BRUSHROUTER_GPTWEB_PROJECT_ID`) to a project id (`g-p-...`); the gateway sends `project_id` in the generation turn, so throwaway image chats land inside that workspace folder instead of main history. If OpenAI ignores the field, generation still succeeds and the setting is inert.

## 5. Security model

**Invariant: no credential may reach a model, a log, or a file brushrouter writes as output.**

### Secrets are separate from configuration

- `src/config.js` reads only non-secret settings. A config file is safe to commit.
- Credentials come from the environment, from a `0600` file (`~/.config/brushrouter/keys.json`, directory `0700`), or from an auth store another tool already maintains.
- `src/util/keys.js` never returns a key to a caller that prints it; `describeKey()` yields only `sk-o…****** (73 chars)`.
- Shape validation rejects placeholders and mismatched formats, so a proxy token sitting in `OPENAI_API_KEY` is not mistaken for a real OpenAI key.

### Redaction at every boundary

`src/util/redact.js` applies two layers:

1. **Value registry.** Every secret actually read is registered; `redact()` replaces it by exact value (longest-first, so no tail survives). This catches a key echoed back inside an unrelated error body.
2. **Shape patterns.** JWTs, `sk-…`, `sk-or-v1-…`, `sess-…`, `gh*_…`, `AIza…`, `Bearer …`/`Basic …`, and `"refresh_token": "…"`-style JSON fields are redacted even if never registered, so an unknown token cannot leak.

`redactValue()` additionally masks any field *named* like a secret (`apiKey`, `token`, `authorization`, …) wholesale.

Boundaries where redaction applies: CLI error output, attempt reasons, `--json` payloads, `providers`, `doctor`, `setup`, and the fatal handler; MCP `tools/call` result strings and the entire response object before serialization; provider failure messages, which are built from redacted text. Tests assert a fake secret does not survive each path.

### The strongest guarantee: not reading secrets at all

The native `codex-cli` and `gemini` providers never read a token. They spawn a process that authenticates itself and read a file. There is no credential for brushrouter to mishandle — this is the preferred shape for any provider added later.

## 6. Discovery

`src/util/discover.js` resolves capabilities from the environment, not constants.

**Codex CLI** search order: explicit config → `BRUSHROUTER_CODEX_CLI` → `$PATH` → `~/.codex/bin`, `~/.local/bin` → every `.app` under `/Applications`, `~/Applications`, and `BRUSHROUTER_APP_DIRS` (checking `Contents/Resources/codex`, `Contents/MacOS/codex`, `Contents/Resources/bin/codex`) → the npm global root (via `npm root -g`) → `~/.cache/codex-runtimes/*`. A candidate is accepted only if it runs and identifies itself as `codex`, so an unrelated binary on `$PATH` cannot be mistaken for it.

**Browsers** are not discovered: their only consumer (the `native-web` browser-session route) was removed once `gptweb2api` covered the same web Images bucket without a browser.

**Google CLIs** are found on `$PATH` (`agy`, `antigravity`, `gemini`).

Because discovery is generic, the same code works on a fresh machine with no personal paths.

## 7. Provider details

### `codex-cli` (native, preferred)

Spawns the discovered CLI in `codex exec --json --skip-git-repo-check -C <tmp>` with an instruction to write the image to an absolute path. Image resolution order: the exact requested path → a `savedPath`/`saved_path` in the JSON stream → inline base64 → the newest image under the scratch dir. Errors are classified into `QUOTA`, `NO_AUTH`, `MODEL`, `TIMEOUT`, `FAILED` from the CLI's own output.

### `codex` (direct backend)

Calls the Codex responses endpoint with an existing OAuth token. Two properties, both learned from real breakage:

- **The OAuth client id is derived from the token's own `aud`/`client_id` claim** (`jwtClientId`), so a stale hardcoded id can never break refresh. A static override exists but is not the default.
- **The orchestrator model is resolved at runtime** (env → `~/.codex/config.toml` → fallback list), and the *only* error that triggers trying the next model is a genuine "model not found". Quota and auth errors are never retried against another model — that would burn time and produce misleading diagnostics.

### `gemini`

Delegates to an installed Google CLI, preferring `agy` (Antigravity). Login is detected from Antigravity's standalone OAuth token file; absence yields a clear `needs-login` status. Google's retired Gemini CLI individual free tier is reported as `DEPRECATED` with an explanation rather than a generic failure. Google tokens are never read by brushrouter.

One quirk: `agy` does not reliably honour the working directory — it sometimes writes the image into its own scratch area (`~/.gemini/antigravity-cli/scratch`). The provider therefore resolves the image from several places in order (requested path → the CLI's scratch dir → newest file under the work dir → the path printed in stdout), and each lookup is time-bounded to files created during *this* run so a stale image is never returned.

### `http` (openrouter / fal / custom-http)

Shared machinery: template a request body from `{prompt} {size} {quality} {model} {apiKey} {image}`, send it, then extract the image via a response path (`json:a.b.c`, `b64_json`, or `raw`). `custom-http` is how a user points brushrouter at an API that did not exist when this was written — no code change required.

**OpenRouter has two generation surfaces**, and which one is correct depends on the model:

| model kind | example | endpoint |
|---|---|---|
| multimodal chat | `google/gemini-3.1-flash-image` | `POST /chat/completions` |
| image-only | `meta/muse-image`, `x-ai/grok-imagine-image-2.0` | `POST /images` |

`/api/v1/models` (444 entries) does not list most image-only models, and `/chat/completions` rejects them with *"No endpoints found that support the requested output modalities: image, text"* — which reads like "model does not exist" but means "wrong endpoint". The image catalogue lives at `/api/v1/images/models` (52 entries); generation is `POST /api/v1/images`, returning `data[0].b64_json` or `data[0].url` and accepting `aspect_ratio`, `quality`, `resolution`, `n`, `input_references`.

Rather than maintain a table of which model belongs to which surface (a list that rots), the provider tries chat first and retries `/images` only when the error is specifically the modality rejection. Auth (401/403), region (403) and credit (402) errors are terminal and surfaced verbatim. A user-pinned model is never substituted: if `-m` is given and that model fails, the failure is reported rather than quietly swapped for a working one.

Availability is a property of the account, not the code, and brushrouter reports it rather than working around it — e.g. `meta/muse-image` → `403 This model is not available in your region.`, `x-ai/grok-imagine-image-2.0` → `402 Insufficient credits.` Both route correctly to `/images`; the failure is the account's. `brushrouter models openrouter` fetches the live catalogue so a user sees what their key can reach.

## 8. First-run behaviour

`brushrouter setup`:

1. **Discovers everything** (Codex CLI, Google CLIs, existing API keys) and reports it. On a machine with the ChatGPT app or a Google login, this ends with "You're all set — no credentials needed" and asks nothing.
2. **Prompts only if** no subscription/CLI route exists *and* no key was found. Input is hidden, validated, stored `0600`, never echoed.
3. **Never blocks when non-interactive** (no TTY, or `--yes`). It prints exactly which environment variable or file to use and exits 0, so it is safe in CI and scripted installs.

## 9. Failure semantics

Failures carry a machine-readable `code` so callers can react:

| code | meaning | router behaviour |
|---|---|---|
| `QUOTA` | usage limit reached | try next provider |
| `NO_AUTH` | missing/expired credentials | try next provider |
| `DEPRECATED` | upstream tier retired | try next provider, explain |
| `MODEL` | model not found | (codex) retry next model, then next provider |
| `TIMEOUT` | exceeded `timeoutMs` | try next provider |
| `ALL_FAILED` | every attempt failed | throw with the full attempt trail |

The thrown error carries `attempts`, so CLI and MCP output show precisely what was tried and why it failed.

## 10. The prompt library (`src/library.js`)

A router that only forwards a prompt is a pipe. It does not fix the failure upstream of routing: an agent asked for "a nice product shot" writes a worse prompt than 110 humans already published and tested. So the router also hands the agent a skeleton to fill in — the model gets a recipe, not just transport.

The library holds two entry kinds behind one schema, one index, one `fill()`, one renderer, and one search:

| `kind` | what it is | count | source |
|---|---|---|---|
| `job` | a layout to fill in | 27 | written here, derived from corpus analysis |
| `look` | a fixed visual system to borrow | 137 | vendored from an MIT cookbook |

`kind` is an orthogonal filter, not a separate code path — splitting them meant two libraries that drift until "search" means two different things.

### Corpus analysis, and what it decided

Before writing the recipes, `scripts/analyze-corpus.mjs` analysed 150 published prompts. Two findings decided the design:

1. **69 of 150 are assembled from the same named section headers** (`【NAME: description】` or `Label: description`); 23 header terms recur three or more times (*Visual style* 13×, *Goal*/*Canvas*/*Constraints* 12×, *Layout* 11×, *Lighting* 8×, *Composition* 7×, *Typography* 5×). The reusable asset is the structure, not the prose. Copying 150 prompts would have shipped someone else's text; deriving the skeleton and writing our own fills gives the same insight without licence entanglement.
2. **28 of 150 require a reference image, and 0 of 150 explain what to do without one** — the most common way an agent gets stuck.

Finding 2 was re-checked against a larger community corpus (`YouMind-OpenLab/ai-image-prompts-skill`, 22,716 prompts): 28.4% expect a reference image and 3 of 22,716 handle its absence — with the same three strategies `image.skeleton` implements (substitute the text, grant creative freedom, fall back to a slot). That corpus is not vendored: none of its entries carries an author to credit. The shipped corpus stays at the pinned commit (`f7f6276`).

Result: 9 categories × 3 recipes = **27 recipes**, each with a `text` skeleton that runs with no image at all, plus an optional `image` upgrade.

### The looks: vendored

Recipes answer *what layout*, not *what it looks like*. Writing 137 visual styles by hand would have meant inventing the thing needed least; `VigoZhao/AI-Visual-Prompt-Cookbook` already publishes 137 tested ones under MIT, so they are vendored, not paraphrased:

- Fetched at a pinned commit (verified by `stylesSha256`), normalized by `scripts/vendor-styles.mjs`, and emitted as **one** file — 137 JSON reads at startup for a library that fits in memory is cost with no benefit.
- The upstream `LICENSE` and `ATTRIBUTION.md` ship alongside; every entry carries `source` (`repo`, `commit`, `license`, `copyright`, `styleName`, `styleVersion`, `upstreamCategory`), and it travels on every result including previews — attribution is a licence condition.
- Looks are optional at load time: a missing `data/styles/styles.json` yields a working jobs-only library.

Two fields in their schema are adopted because they were better than ours:

| field | rendered as | suppressed by `includeNegatives: false`? |
|---|---|---|
| `styleLock` | `STYLE LOCK — …` | no — it is a positive invariant |
| `doNotClone` | `DO NOT REPRODUCE — …` | yes |
| `negatives` | `AVOID — …` | yes |

`styleLock` states what must *survive*, not what to avoid; suppressing it under the negative guard silently dropped the only thing keeping a look on-model.

Normalization was where the real bugs lived. `slots` are derived from the **rewritten template**, not from the upstream `environment_variables` list — a declared-but-unused slot is noise, and a used-but-undeclared one reaches the image model as a literal `{aspect_ratio}`. A case-insensitive pass over the template renames `aspect_ratio → ratio`, `main_text → text`, `product_or_prop → prop`, `wardrobe_style → wardrobe`, and deletes `style_fidelity_anchors`, `source_content_to_avoid`, and `negative_prompt` (those became fields). `background_elements` is deliberately *not* mapped to our `background`: our slot means "what backdrop", theirs means "what decorative elements fill it" — one name for two meanings is worse than two names.

### The schema

```jsonc
{
  "id": "product-hero",
  "kind": "job",                          // job | look
  "goal": "...", "when": "...",
  "shape": "single",                      // single | grid | sheet | document
  "slots": ["ratio", "lighting"],
  "defaults": { "ratio": "1:1", ... },    // always a valid option
  "text": "...{ratio}...",                // always present, always runnable
  "image": {                              // optional upgrade
    "accepts": "a clean product photo on any background",
    "preserve": ["the product's shape and label", ...],
    "skeleton": "..."
  },
  "negatives": ["..."],
  "styleLock": ["..."],                   // looks: invariants that must survive
  "doNotClone": ["..."],                  // looks: source content not to reproduce
  "source": { "repo": "...", "license": "MIT", ... },  // looks: attribution
  "example": "..."
}
```

The invariants are asserted by `scripts/check-recipes.mjs`: `text` must exist and be substantial; an `image` block must name what it `accepts` and at least three things to `preserve`; every `defaults` value must be one of the slot's offered options; every declared slot must appear in `text`. A slot declared but never used is a bug the checker catches — three real ones were found and fixed this way.

Current shape: 27 recipes, 19 image-capable and 8 text-only, across `single` 17 / `grid` 7 / `sheet` 1 / `document` 2; plus 137 looks, all `single`, in 6 categories. `check-recipes.mjs` validates both — a malformed `styles.json` is a hard failure, an absent one is not.

### Free slots

Of the 17 slots, nine carry a curated option list and are filled for the caller. Eight are deliberately free — `subject`, `subject_action`, `text`, `secondary_text`, `prop`, `location`, `wardrobe`, `accent_symbol` — because only the caller knows them. Unfilled, they are returned in `missing` and **left visible as placeholders**; `fill()` never silently emits a literal `{subject}` into a prompt destined for an image model, where it would render as meaningless text.

A look draws **no defaults at all**. The shared slot vocabulary is our studio set (`ratio: "1:1"`, `background: "seamless white"`), and a vendored style's slots are the caller's content: auto-filling them once injected studio defaults into a zine collage. So `fill()` consults the vocabulary only when `kind === "job"`.

### Search: no index, no embeddings

164 rows. A linear scan beats building, loading, or invalidating any index. Embeddings lose at this size for the same reasons a vector store does: model dependency, network call, cold-start cost — to rank 164 documents.

What makes search feel semantic is a hand-written alias map: an agent says *hero shot*, *dashboard*, *flyer*; the library says `product-hero`, `app-screen`, `hero-poster`. Fifteen categories (9 job, 6 look) × ~12 aliases bridge the gap in a few dozen lines of data — deterministic, offline, inspectable per word. The alias map is hand-written on purpose: deriving it from the entries' own summaries produced ~400 aliases per category, which is noise that matches everything.

**Prose may raise a rank; it may never create a match.** With 137 looks carrying 181 KB of descriptive prose, a single incidental stem in the match index turns any query into a confident wrong answer (*water* prefix-matched *watercolour*, *wobble* matched *wobbleflux*). So the index is split:

- **identity** — `id`, `goal`, `when`. The only thing that can create a match.
- **supporting evidence** — style-lock anchors and default slot values. These may only raise the rank of something that already matched; the anchor boost is capped at +3 so it can never outrank a real identity match.

`findRecipes()` filters on `identity > 0` when there is a query; an empty query browses the whole library.

| signal | weight |
|---|---|
| query contains a default slot value verbatim | 5 |
| multi-word alias present ("album cover") | 4 |
| query word in id, goal or when | 3 (fraction-weighted) |
| single-word alias | 2 |
| style-lock anchor token | +1 each, capped +3 |
| query word matches a default value token | 1 |

Name matching is fraction-weighted (`3 * nameHits / queryTokens`) because a flat cap tied a 3-of-3 match to a 2-of-3 match, which made "product hero shot" resolve by seed coin-flip instead of by evidence. Matching is prefix-tolerant over words of four or more characters (`explain` finds `explainer`), but a prefix only counts when the shorter word is ≥ 60% of the longer word's length — so *watercolour* rejects *water* (0.45) while *logos* accepts *logo* (0.8). The exact-default bonus at +5 exists because prefix matching widened recall enough that an entry merely mentioning *film* in prose could outrank the entry whose default value *is* "analogue film photograph".

A query that scores zero everywhere returns nothing, with a pointer to `mode: "categories"`. Falling back to a seed-random recipe would look like an answer and be worse than no answer.

### Modes

| mode | purpose |
|---|---|
| `categories` | the map — cheap, queryless; why an agent knows what to ask for |
| `related` (default) | one best match + alternatives; `limit` sizes the rail |
| `one` | exactly one; a named mode so an agent reading an enum never reasons about `limit: 1` |

- `input: "image"` narrows to recipes that can use a reference photo. Every **job** category retains at least one such recipe, so the filter never dead-ends an agent. `input: "text"` (default) keeps everything.
- `kind` narrows to `job` or `look`. Job-specific invariants are tested against the job subset, because a guarantee holding for 27 of 164 entries is not a guarantee.
- Results are **previews** by default (id, goal, when, what is missing). Full skeletons are large and four of them is a lot of context spent answering "what are my options"; `full` is opt-in, once an id is chosen.
- `limit` is capped at 10 to protect the caller's context; the result also carries `available`, the uncapped match count, so "10 of 10" is distinguishable from "10 of 27".

### The corpus is pinned, hashed, and not shipped

`data/prompts/` is a development fixture. Nothing at runtime reads it; it is excluded from the npm tarball by `package.json`'s `files` list; a test asserts `src/library.js` contains no reference to it. It exists to make the design argument reproducible:

```bash
npm run corpus:analyze   # reproduce the 69/150 and 28/150 findings
npm run corpus:check     # re-fetch at the pinned commit, recompute corpusSha256, compare
npm run corpus:fetch     # re-pin to a newer corpus
```

The corpus is pinned by commit (`f7f6276`) and verified by `corpusSha256`, so "which exact bytes produced these numbers?" stays answerable. Its `ATTRIBUTION.md`, `LICENSES/` and `provenance/` records travel with it: the rows are third-party text (115 CC0, 35 CC-BY) and none of it is quoted in the shipped library.

`data/styles/` is the opposite — it ships, because the looks are the feature. It is pinned by commit (`8b6068f`) and verified by `stylesSha256`; the `files` list ships the upstream `LICENSE` and `ATTRIBUTION.md` with it:

```bash
npm run styles:vendor    # re-vendor from the pinned commit (--from DIR for a checkout)
npm run styles:check     # re-fetch upstream, recompute stylesSha256, compare
npm run recipes:check    # validate every recipe and look against the invariants
```

## 11. Testing

`node --test tests/*.test.js` — 130 tests, zero dependencies. Coverage:

- Utilities: mime detection, collision-safe save, JWT claims, size parsing.
- Config layering, and the invariant that `priority` and the provider registry contain exactly the same ids.
- Provider interface conformance.
- **MCP flush**: the server must not exit on stdin close before async work is written (a real bug that was found and fixed).
- **Provider contract**: a provider returning no image buffer is rejected by the router rather than spread into a buffer-less result.
- **Security**: registered secrets, well-known shapes, deep masking of secret-named fields, `describeKey` never revealing a key body.
- **Portability**: `DEFAULT_CONFIG` contains no personal path, no hardcoded app path, no OAuth client id.
- **Recipe library**: every entry passes `validateRecipes()`; every recipe produces a usable prompt from text alone with no image; supplying the free slots leaves nothing unfilled and no literal `{placeholder}` in the output; every default is an offered option; every image block names what it accepts and what to preserve; every job category retains an image-capable recipe; queries land in the right category; aliases match words no recipe uses; an unmatched query returns nothing; `seed` is reproducible and varied; a scored query is stable across seeds; previews stay small while `full` is substantially larger; and the shipped library never reads the dev corpus.

## 12. Extending

- **Add a provider:** implement the contract, register it in `src/router.js`, add it to `DEFAULT_CONFIG.priority` and `.providers`. Prefer delegating to a CLI that owns its own login — not reading a credential is the strongest security posture.
- **Add a backend without code:** use `custom-http`. That is its purpose.
- **Change routing:** edit `priority`, or set `BRUSHROUTER_PRIORITY`.
- **Add or change a recipe:** edit the relevant `data/recipes/<category>.json`, then `npm run recipes:check` (fails on a declared-but-unused slot, an off-vocabulary default, a missing `text` skeleton, or an image block with no `accepts`/`preserve`). Then run the test suite.
- **Add a category:** create `data/recipes/<id>.json` with its `label`, `intent`, and `aliases`. The aliases live in that file, so a category cannot exist without them; the suite enforces a minimum of five.
- **Add or re-vendor a look:** never hand-edit `data/styles/styles.json` — it is generated. Change `scripts/vendor-styles.mjs` (the `SLOT_MAP`, category aliases) and re-run `npm run styles:vendor`.
- **Re-pin the corpus:** `npm run corpus:fetch`, then `npm run corpus:analyze`. The standing rule: if a source grants no redistribution rights, derive the structure and write your own fills — do not vendor text you cannot redistribute.
- **Add a source of looks:** vendor only under a licence that permits it, ship the licence and attribution, carry `source` on every entry, and pin the commit with a hash.
