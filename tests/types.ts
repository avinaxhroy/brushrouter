import type { Buffer } from "node:buffer";
import {
  PROVIDERS,
  batchGenerate,
  buildReplayRequest,
  computeStats,
  generate,
  planAttemptOrder,
  findRecipes as findRecipesFromRoot,
  type ProviderId,
} from "brushrouter";
import { getHistoryPath, loadConfig, providerConfig } from "brushrouter/config";
import { HISTORY_SCHEMA_VERSION, getHistoryEntry, listHistory, tryRecordHistory } from "brushrouter/history";
import { OPAQUE_BYTES, redact, redactValue, registerSecret, safeError } from "brushrouter/redact";
import {
  TokenIndex,
  composePrompt,
  fill,
  findRecipes,
  getRecipe,
  listCategories,
  publicRecipe,
  renderResult,
} from "brushrouter/library";

const config = loadConfig({
  userConfig: null,
  overrides: {
    priority: ["custom-http", "codex-cli"],
    providers: { "custom-http": { url: "https://example.com/images", headers: { Accept: "image/png" } } },
    history: { enabled: false },
    pricing: { "custom-http": 0.02 },
  },
});
const url: string | undefined = providerConfig(config, "custom-http").url;
const defaultsPriority: string[] = loadConfig().priority;
const clearedPriority = loadConfig({ overrides: { priority: undefined } }).priority;
// @ts-expect-error An explicit undefined can overwrite an existing priority.
const requiredPriority: string[] = clearedPriority;
const clearedFal = loadConfig({ userConfig: { providers: { fal: undefined } } }).providers.fal;
// @ts-expect-error An explicit undefined can also overwrite a provider entry.
clearedFal.enabled;
const clearedProviders = loadConfig({ userConfig: { providers: undefined } }).providers;
// @ts-expect-error The provider map may no longer include the default entries.
clearedProviders?.fal.enabled;
const ids: ProviderId[] = await planAttemptOrder(config, { images: ["reference.png"] });
const models: string[] = PROVIDERS.openrouter.defaultModels;
const generated = await generate({
  prompt: "A snowy owl",
  seed: 42,
  history: { path: getHistoryPath(), source: "api" },
  onProgress(message, percent) {
    const status: string = `${message}: ${percent.toFixed(0)}%`;
  },
}, config);
const bytes: Buffer = generated.buffer;
const imagesUsed: boolean = generated.meta.imagesUsed;
const duration: number = generated.durationMs;
const historyId: string | undefined = generated.historyId;

const batch = await batchGenerate({
  items: ["A snowy owl", { id: "second", prompt: "A dragon", out: "dragon.png", seed: 42 }],
  retainBuffers: false,
  onItemFail(result) {
    const error: string = result.error;
  },
}, config);
for (const result of batch.results) {
  if (result.ok) {
    const bytes: Buffer | null = result.buffer;
    const path: string | null = result.savedPath;
    const bytesWritten: number = result.bytes;
  } else {
    const code: string | undefined = result.code;
    // @ts-expect-error Failed items do not carry image bytes.
    result.buffer;
  }
}
const emptyTotal: number = (await batchGenerate({ items: [] }, config)).total;

const entries = listHistory({ limit: 0 }, { path: getHistoryPath() }).entries;
const firstEntry = entries.at(0);
const recorded = tryRecordHistory({ prompt: "Snowy owl", ok: true, seed: "42" }, { cfg: config });
if (firstEntry && recorded) {
  const version: typeof HISTORY_SCHEMA_VERSION = firstEntry.v;
  const replay = buildReplayRequest(recorded, { noImages: true });
  const seed: number | undefined = replay.seed;
  generate({ ...replay, history: { replayOf: replay.replayOf } }, config);
}
const latency: number | null = computeStats().summary.latencyMs.p95;
// @ts-expect-error History selectors are strings, even for relative lookups.
getHistoryEntry(1);

const literal: "example" = registerSecret("example");
const text: string = redact(42);
const absent: null = redact(null);
const opaqueBlock = { [OPAQUE_BYTES]: true, data: "bytes" };
const redacted: unknown = redactValue(opaqueBlock);
const errorText: string = safeError(new Error("example"));

const recipe = getRecipe("logo-mark");
const prompt: string = fill(recipe, { values: { ratio: "1:1", subject: "An owl" } }).text;
const gist: string = publicRecipe(recipe).gist;
const fullPrompt: string = publicRecipe(recipe, { full: true }).prompt;
const missing: string[] = composePrompt({ recipeId: recipe.id }).missing;
const label: string = listCategories({ kind: "job" })[0]!.label;
const matches: boolean = new TokenIndex(new Set(["portrait"])).matches("portraits");

const results = findRecipes({ query: "zzz-not-a-recipe", limit: 0 });
if (!results.matched) {
  const noRows: [] = results.rows;
  const noMore: false = results.hasMore;
  const suggestions: string[] = results.suggestions.categories;
}
const display: string = renderResult(results);
const sameSearch: typeof findRecipes = findRecipesFromRoot;
const categories = findRecipes({ mode: "categories" });
if (categories.mode === "categories") {
  const limit: null = categories.limit;
  const offset: 0 = categories.offset;
  const hasMore: undefined = categories.hasMore;
  const rows: [] = categories.rows;
} else if (categories.mode === "one" && categories.matched) {
  const limit: 1 = categories.limit;
  const hasMore: false = categories.hasMore;
}

// @ts-expect-error A generation must include a prompt.
generate({ provider: "codex" });
// @ts-expect-error Only registered provider IDs can be requested.
generate({ prompt: "An owl", provider: "unknown" });
// @ts-expect-error Known configuration fields are checked inside overrides.
loadConfig({ overrides: { providers: { fal: { enabled: "yes" } } } });
// @ts-expect-error Redaction converts non-null inputs to strings.
const number: number = redact(42);
// @ts-expect-error Composition requires a recipe or a look.
composePrompt({ values: {} });
// @ts-expect-error Search modes are restricted to the runtime vocabulary.
findRecipes({ mode: "all" });
