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

export interface ConfigOverrides {
  priority?: string[];
  instructions?: string;
  providers?: ProviderSettings;
  [key: string]: unknown;
}

export interface Config extends ConfigOverrides {
  priority: string[];
}

export interface LoadedConfig extends Config {
  instructions: string;
  providers: ProviderConfigs & Record<string, ProviderConfig | undefined>;
}

export interface LoadConfigOptions {
  cwd?: string;
  overrides?: ConfigOverrides;
  userConfig?: ConfigOverrides | null;
}

export function getConfigDir(): string;
export function getUserConfigPath(): string;
export function getKeysPath(): string;

export const CONFIG_DIR: string;
export const USER_CONFIG_PATH: string;
export const KEYS_PATH: string;
export const PROJECT_CONFIG_NAME: "brushrouter.config.json";
export const DEFAULT_CONFIG: LoadedConfig;

export function loadConfig(options?: LoadConfigOptions): LoadedConfig;
export function providerConfig<Id extends ProviderId>(config: Pick<Config, "providers">, name: Id): ProviderConfigs[Id];
export function providerConfig(config: Pick<Config, "providers">, name: string): ProviderConfig;
