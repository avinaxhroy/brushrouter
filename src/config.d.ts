export interface ProviderConfig {
  enabled?: boolean;
  model?: string | null;
  timeoutMs?: number;
  concurrency?: number;
  [key: string]: unknown;
}

interface CliProviderConfig extends ProviderConfig {
  cli?: string | null;
}

interface AuthFileProviderConfig extends ProviderConfig {
  authFile?: string | null;
}

interface ApiKeyProviderConfig extends ProviderConfig {
  apiKey?: string | null;
  baseUrl?: string;
}

export interface ProviderConfigs {
  "codex-cli": CliProviderConfig;
  codex: AuthFileProviderConfig & {
    clientId?: string | null;
    endpoint?: string;
  };
  gemini: CliProviderConfig;
  openrouter: ApiKeyProviderConfig & {
    models?: string[];
    resolution?: string | null;
  };
  fal: ApiKeyProviderConfig;
  gptweb2api: AuthFileProviderConfig & {
    bin?: string | null;
    cookie?: string | null;
    ref?: string | null;
    projectId?: string | null;
    idleMs?: number;
  };
  "custom-http": ProviderConfig & {
    name?: string;
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    response?: string;
    apiKey?: string | null;
    keyHeader?: string;
    keyPrefix?: string;
    supportsRefImages?: boolean;
  };
}

export type ProviderId = keyof ProviderConfigs;
export type ProviderSettings = Partial<ProviderConfigs> & Record<string, ProviderConfig | undefined>;

export interface HistoryConfig {
  enabled?: boolean;
  maxEntries?: number;
}

export type PricingConfig = Record<string, number>;

export interface ConfigOverrides {
  priority?: string[];
  instructions?: string;
  providers?: ProviderSettings;
  history?: HistoryConfig;
  pricing?: PricingConfig;
  [key: string]: unknown;
}

export interface Config extends ConfigOverrides {
  priority: string[];
}

export interface LoadedConfig extends Config {
  instructions: string;
  providers: ProviderConfigs & Record<string, ProviderConfig | undefined>;
  history: HistoryConfig;
  pricing: PricingConfig;
}

export interface LoadConfigOptions {
  cwd?: string;
  overrides?: ConfigOverrides;
  userConfig?: ConfigOverrides | null;
}

type UndefinedOverride<Overrides, Key extends PropertyKey> = Overrides extends unknown
  ? Key extends keyof Overrides
    ? undefined extends Overrides[Key] ? undefined : never
    : never
  : never;

type PresentValue<Input, Key extends PropertyKey> = Input extends unknown
  ? Key extends keyof Input ? NonNullable<Input[Key]> : never
  : never;

type ResolvedConfig<Overrides> = ConfigOverrides & {
  priority: string[] | UndefinedOverride<Overrides, "priority">;
  instructions: string | UndefinedOverride<Overrides, "instructions">;
  history: HistoryConfig | UndefinedOverride<Overrides, "history">;
  pricing: PricingConfig | UndefinedOverride<Overrides, "pricing">;
  providers: ({
    [Id in ProviderId]: ProviderConfigs[Id]
      | UndefinedOverride<PresentValue<Overrides, "providers">, Id>
      | UndefinedOverride<Overrides, "providers">;
  } & Record<string, ProviderConfig | undefined>) | UndefinedOverride<Overrides, "providers">;
};

export function getConfigDir(): string;
export function getUserConfigPath(): string;
export function getKeysPath(): string;
export function getHistoryPath(): string;

export const CONFIG_DIR: string;
export const USER_CONFIG_PATH: string;
export const KEYS_PATH: string;
export const PROJECT_CONFIG_NAME: "brushrouter.config.json";
export const DEFAULT_CONFIG: LoadedConfig;

export function loadConfig<Options extends LoadConfigOptions = {}>(
  options?: Options,
): ResolvedConfig<PresentValue<Options, "overrides" | "userConfig">>;
export function providerConfig<Id extends ProviderId>(config: Pick<Config, "providers">, name: Id): ProviderConfigs[Id];
export function providerConfig(config: Pick<Config, "providers">, name: string): ProviderConfig;
