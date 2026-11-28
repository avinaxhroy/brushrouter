import type { HistoryConfig, PricingConfig, ProviderId } from "./config.js";

export const HISTORY_SCHEMA_VERSION: 1;
export const SUBSCRIPTION_PROVIDERS: Set<string>;
export const DEFAULT_MODEL_PRICING_USD: Record<string, number>;

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export type UsageInput = Partial<Record<
  keyof Usage | "prompt_tokens" | "completion_tokens" | "total_tokens" | "input_tokens" | "output_tokens" | "cost",
  number | string | null
>> & Record<string, unknown>;

export type CostSource = "provider" | "configured" | "subscription" | "estimated" | "unknown" | "none";

interface CostEstimate {
  costUsd: number | null;
  costSource: CostSource;
}

export interface CostOptions {
  provider?: string | null;
  model?: string | null;
  usage?: UsageInput | Usage | null;
  costUsd?: number | string | null;
  pricing?: PricingConfig | null;
}

export interface HistoryMetadata {
  source?: string | null;
  recipe?: string | null;
  look?: string | null;
  values?: Record<string, unknown> | null;
  twist?: string | null;
  out?: string | null;
  replayOf?: string | null;
  batchId?: string | null;
}

export interface HistoryAttempt {
  provider: ProviderId | null;
  outcome: string;
  model?: string | null;
  reason?: string;
  code?: string;
  durationMs?: number;
}

export interface HistoryRecord extends Required<HistoryMetadata>, CostEstimate {
  v: typeof HISTORY_SCHEMA_VERSION;
  id: string;
  ts: string;
  source: string;
  ok: boolean;
  prompt: string;
  provider: ProviderId | null;
  requestedProvider: ProviderId | null;
  model: string | null;
  requestedModel: string | null;
  size: string | null;
  actualSize: string | null;
  quality: string | null;
  background: string | null;
  seed: number | null;
  images: string[];
  imagesUsed: boolean;
  bytes: number | null;
  mime: string | null;
  durationMs: number | null;
  attempts: HistoryAttempt[];
  usage: Usage | null;
  error: string | null;
  errorCode: string | null;
}

export interface HistoryRecordInput extends Partial<Omit<HistoryRecord, "v" | "seed" | "images" | "attempts" | "usage" | "costUsd">> {
  seed?: number | string | null;
  images?: readonly string[] | null;
  attempts?: readonly Partial<HistoryAttempt>[] | null;
  usage?: UsageInput | Usage | null;
  costUsd?: number | string | null;
  pricing?: PricingConfig | null;
}

interface HistoryPathOptions {
  path?: string;
}

interface HistoryClockOptions extends HistoryPathOptions {
  now?: number;
}

export interface HistoryRecordOptions extends HistoryPathOptions {
  cfg?: { history?: HistoryConfig; pricing?: PricingConfig } | null;
  cwd?: string;
}

export interface HistoryData {
  entries: HistoryRecord[];
  corruptLines: number;
  path: string;
}

export interface HistoryFilters {
  provider?: string | null;
  model?: string | null;
  status?: "ok" | "failed" | null;
  source?: string | null;
  batchId?: string | null;
  replayOf?: string | null;
  since?: string | null;
  until?: string | null;
  query?: string | null;
}

export interface HistoryListFilters extends HistoryFilters {
  order?: "asc" | "desc";
  limit?: number | null;
  offset?: number | null;
}

export interface HistoryList extends HistoryData {
  total: number;
  matched: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface ReplayOverrides {
  prompt?: string | null;
  twist?: string | null;
  seed?: number | string | null;
  noImages?: boolean;
  images?: readonly string[];
  provider?: ProviderId | null;
  model?: string | null;
  size?: string;
  quality?: string;
  background?: string;
  fallback?: boolean;
  out?: string | null;
}

export interface ReplayRequest {
  prompt: string;
  seed: number | undefined;
  images: readonly string[];
  provider: ProviderId | undefined;
  model: string | undefined;
  size: string | undefined;
  quality: string | undefined;
  background: string | undefined;
  fallback: boolean;
  out: string | undefined;
  replayOf: string;
  recipe: string | null;
  look: string | null;
  values: Record<string, unknown> | null;
  twist: string | null;
}

export interface PruneHistoryOptions extends HistoryClockOptions {
  keep?: number | string | null;
  beforeDays?: number | string | null;
  dryRun?: boolean;
}

export interface PrunedHistory {
  before: number;
  after: number;
  removed: number;
  dryRun: boolean;
  path: string;
}

export interface LatencyStats {
  avg: number | null;
  p50: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
  samples: number;
}

interface OutcomeStats {
  succeeded: number;
  failed: number;
  successRate: number | null;
}

interface SpendStats {
  spendUsd: number | null;
}

export interface ProviderStats extends OutcomeStats, SpendStats {
  provider: string;
  generations: number;
  attempts: number;
  attemptOk: number;
  attemptFailed: number;
  attemptSuccessRate: number | null;
  skipped: number;
  latencyMs: LatencyStats;
  costSources: Record<string, number>;
  models: string[];
  topErrors: { code: string; count: number }[];
}

export interface ModelStats extends OutcomeStats, SpendStats {
  provider: string;
  model: string;
  count: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
}

export interface DailyStats extends OutcomeStats, SpendStats {
  date: string;
  total: number;
  avgLatencyMs: number | null;
}

export interface HistoryStats {
  summary: OutcomeStats & {
    total: number;
    latencyMs: LatencyStats;
    spend: {
      totalUsd: number | null;
      providerUsd: number | null;
      configuredUsd: number | null;
      estimatedUsd: number | null;
      subscriptionCount: number;
      unknownCostCount: number;
    };
    tokens: { prompt: number; completion: number; total: number };
    bytes: number;
    window: { firstTs: string | null; lastTs: string | null };
  };
  providers: ProviderStats[];
  models: ModelStats[];
  daily: DailyStats[];
  corruptLines: number;
  path: string;
}

export function generateHistoryId(): string;
export function generateBatchId(): string;
export function isHistoryDisabled(cfg?: { history?: HistoryConfig } | null): boolean;
export function parseSince(since?: string | null, now?: number): number | null;
export function normalizeUsage(raw: unknown): Usage | null;
export function estimateCost(options?: CostOptions): CostEstimate;
export function buildHistoryRecord(entry: HistoryRecordInput, options?: Omit<HistoryRecordOptions, "path">): HistoryRecord;
export function recordHistory(entry: HistoryRecordInput, options?: HistoryRecordOptions): HistoryRecord | null;
export function tryRecordHistory(entry: HistoryRecordInput, options?: HistoryRecordOptions): HistoryRecord | null;
export function readHistory(options?: HistoryPathOptions): HistoryData;
export function listHistory(filters?: HistoryListFilters, options?: HistoryClockOptions): HistoryList;
/** @throws {Error} If the selector is invalid, ambiguous, or not found. */
export function getHistoryEntry(selector: string, options?: HistoryPathOptions & { cwd?: string }): HistoryRecord;
export function buildReplayRequest(entry: HistoryRecordInput & { id: string }, overrides?: ReplayOverrides): ReplayRequest;
export function pruneHistory(options?: PruneHistoryOptions): PrunedHistory;
export function clearHistory(options?: HistoryPathOptions): { removed: number; path: string };
export function percentile(sorted: readonly number[], p: number): number | null;
export function computeStats(filters?: HistoryFilters, options?: HistoryClockOptions): HistoryStats;
export function formatDurationMs(ms?: number | null): string;
export function formatUsd(usd?: number | null, source?: string | null): string;
export function formatPct(rate?: number | null): string;
export function renderHistoryList(result: HistoryList): string;
export function renderHistoryDetail(entry: HistoryRecord): string;
export function renderStats(stats: HistoryStats): string;
