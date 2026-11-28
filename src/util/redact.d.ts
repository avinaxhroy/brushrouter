export function registerSecret<T>(value: T): T;
export function registerSecrets(values?: Iterable<unknown> | null): void;
export function clearSecrets(): void;

export function redact<T extends null | undefined>(input: T): T;
export function redact(input: {}): string;
export function redact(input?: unknown): string | null | undefined;

export const OPAQUE_BYTES: unique symbol;

export function redactValue(value: string, depth?: number): string;
export function redactValue<T extends number | boolean | bigint | symbol | null | undefined>(value: T, depth?: number): T;
export function redactValue(value: unknown, depth?: number): unknown;

export function safeError(err: unknown): string;
export function safeParseMessage(err: unknown): string;
