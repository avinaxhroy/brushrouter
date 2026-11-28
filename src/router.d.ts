import type { Buffer } from "node:buffer";
import type { Config, ProviderConfigs, ProviderId } from "./config.js";

export type { ProviderId } from "./config.js";

export type ProviderKind = "native-cli" | "subscription" | "web-session" | "cli-oauth" | "api-key" | "user-defined";

export interface ProviderProbe {
  available: boolean;
  auth: string;
  detail: string;
  expires?: string | null;
  clientId?: string;
}

export interface ProviderStatus extends ProviderProbe {
  id: ProviderId;
  label: string;
  kind: ProviderKind;
  note: string;
  supportsImages: boolean;
  enabled: boolean;
}

export interface Provider<Id extends ProviderId = ProviderId> {
  id: Id;
  label: string;
  kind: ProviderKind;
  note: string;
  supportsImages: boolean;
  probe(config: ProviderConfigs[Id]): Promise<ProviderProbe>;
  generate(options: ProviderGenerateOptions, config: ProviderConfigs[Id]): Promise<ProviderResult>;
}

export interface RoutingOptions {
  provider?: ProviderId;
  fallback?: boolean;
}

export interface AttemptOrderOptions extends RoutingOptions {
  images?: readonly string[];
}

export interface ImageOptions {
  prompt: string;
  size?: string;
  quality?: string;
  background?: string;
  model?: string;
  images?: readonly string[];
  out?: string;
}

export interface ProviderGenerateOptions extends ImageOptions {
  cwd?: string;
  onProgress?: (message: string, percent: number) => void;
}

export interface GenerateOptions extends ProviderGenerateOptions, RoutingOptions {}

export interface ProviderMeta {
  provider?: ProviderId;
  model?: string | null;
  imagesUsed?: boolean;
  sourceUrl?: string | null;
  source?: "inline" | "file";
  endpoint?: string;
  authFile?: string;
  billing?: "subscription" | "web-session";
  cli?: "agy" | "gemini";
  route?: ProviderId;
}

export interface ProviderResult {
  buffer: Buffer;
  meta: ProviderMeta;
}

export interface GenerationMeta extends ProviderMeta {
  imagesUsed: boolean;
}

export type GenerationAttempt = { provider: ProviderId } & (
  | { outcome: "ok"; model?: string | null }
  | { outcome: "skipped"; reason?: string }
  | { outcome: "failed"; reason?: string; code?: string }
);

export interface GenerationResult extends ProviderResult {
  provider: ProviderId;
  meta: GenerationMeta;
  attempts: GenerationAttempt[];
}

export interface BatchImageOptions extends ImageOptions {
  id?: string;
}

export interface BatchItem extends BatchImageOptions {
  id: string;
  index: number;
  images: readonly string[];
  attempts: GenerationAttempt[];
  failedProviders: Set<ProviderId>;
}

interface BatchItemResultBase {
  index: number;
  item: BatchItem;
  attempts: GenerationAttempt[];
}

export interface BatchItemSuccess extends BatchItemResultBase {
  ok: true;
  buffer: Buffer | null;
  savedPath: string | null;
  provider: ProviderId;
  meta: GenerationMeta;
}

export interface BatchItemFailure extends BatchItemResultBase {
  ok: false;
  error: string;
  code?: string;
}

export interface BatchOptions extends RoutingOptions {
  items: readonly (string | BatchImageOptions)[];
  concurrency?: number;
  cooldownMs?: number;
  outDir?: string;
  force?: boolean;
  retainBuffers?: boolean;
  cwd?: string;
  onProgress?: (message: string) => void;
  onItemStart?: (event: { item: BatchItem; index: number; provider: ProviderId }) => void;
  onItemComplete?: (result: BatchItemSuccess) => void;
  onItemFail?: (result: BatchItemFailure) => void;
  onProviderCooldown?: (event: { provider: ProviderId; reason: string; cooldownUntil: number }) => void;
}

export interface BatchResult {
  results: (BatchItemSuccess | BatchItemFailure)[];
  total: number;
  completed: number;
  failed: number;
}

export const PROVIDERS: { [Id in ProviderId]: Provider<Id> } & {
  openrouter: { defaultModels: string[] };
};
export const DEFAULT_PROVIDER_CONCURRENCY: Record<ProviderId, number>;

export function listProviderIds(): ProviderId[];
export function probeAll(config: Config): Promise<ProviderStatus[]>;
export function planAttemptOrder(config: Config, options?: AttemptOrderOptions): Promise<ProviderId[]>;
export function generate(options: GenerateOptions, config?: Config | null): Promise<GenerationResult>;
export function isRateLimitError(err: unknown): boolean;
export function batchGenerate(options: BatchOptions, config?: Config | null): Promise<BatchResult>;
export function setRouteEnabled(name: ProviderId, enabled: boolean, options?: { path?: string }): string;

export {
  findRecipes,
  getRecipe,
  publicRecipe,
  fill,
  composePrompt,
  ratioToSize,
  listCategories,
  loadRecipes,
  recipeCounts,
  categoryIds,
  recipeIds,
  resetRecipesCache,
  renderResult,
  renderRecipe,
  renderCategories,
  RECIPES_DIR,
  STYLES_FILE,
  MODES,
  STRICT_SLOTS,
} from "./library.js";
