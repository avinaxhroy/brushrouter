// Secret redaction.
//
// SECURITY INVARIANT: a model (or any agent) that calls brushrouter must never
// receive credentials. That applies to stdout, stderr, error messages, MCP tool
// results, and `--json` payloads.
//
// Two layers of defence:
//   1. Value registry — every secret brushrouter actually reads is registered by
//      value, and is redacted even if it appears inside an unrelated string
//      (e.g. a server echoing it back in an error body).
//   2. Shape patterns — well-known token shapes are redacted even if we never
//      read them, so a token we didn't know about still can't leak.
//
// Redaction is applied at the boundaries (CLI printing, MCP responses, error
// construction). Providers should still avoid touching secrets at all.

// Values we have seen and must never echo.
const registry = new Set();
let sortedRegistry = [];

function updateSortedRegistry() {
  sortedRegistry = [...registry].sort((a, b) => b.length - a.length);
}

// Anything shorter than this is too generic to redact by value (redacting a
// 4-char string would mangle ordinary prose).
const MIN_REGISTRY_LEN = 8;
// Shortest possible match in SHAPE_PATTERNS is 15 characters (e.g. xox*-* or sk-*).
const MIN_SHAPE_LEN = 15;

export function registerSecret(value) {
  if (typeof value === "string" && value.length >= MIN_REGISTRY_LEN) {
    if (!registry.has(value)) {
      registry.add(value);
      updateSortedRegistry();
    }
  }
  return value;
}

export function registerSecrets(values) {
  let added = false;
  for (const v of values || []) {
    if (typeof v === "string" && v.length >= MIN_REGISTRY_LEN && !registry.has(v)) {
      registry.add(v);
      added = true;
    }
  }
  if (added) updateSortedRegistry();
}

export function clearSecrets() {
  registry.clear();
  sortedRegistry = [];
}

// Token shapes. Kept deliberately conservative so we never mangle a file path
// or a model name.
const SHAPE_PATTERNS = [
  // OAuth bearer tokens and API keys
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "sk-***"],
  [/\bsk-or-v1-[A-Za-z0-9]{16,}\b/g, "sk-or-v1-***"],
  [/\bsess-[A-Za-z0-9_-]{16,}\b/g, "sess-***"],
  [/\bthk_[A-Za-z0-9_-]{16,}\b/g, "thk_***"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "xox***"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "gh***"],
  [/\bAIza[A-Za-z0-9_-]{30,}\b/g, "AIza***"],
  // JWTs (header.payload.signature) — access/id tokens are JWTs.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "eyJ***.***.***"],
  // Authorization headers. Only unambiguous auth schemes are matched here —
  // bare words like "Key" or "Token" appear in ordinary prose and would cause
  // false positives (e.g. "Key auto-discovered").
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 ***"],
  // Header/query forms: api_key=... , access_token=... , ?key=...
  [/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|auth[_-]?token|token)\s*[=:]\s*["']?([A-Za-z0-9._~+/=-]{16,})["']?/gi, "$1=***"],
  // Common JSON/env secret fields: "refresh_token": "...."
  [
    /("(?:access_token|refresh_token|id_token|api_?key|client_secret|password|authorization|bearer|secret)"\s*:\s*)"[^"]*"/gi,
    '$1"***"',
  ],
  // Google OAuth access/refresh tokens. These match no generic shape, and the
  // Antigravity provider reads them off disk, so they need their own rule.
  [/\bya29\.[A-Za-z0-9._-]{20,}/g, "ya29.***"],
  [/\b1\/\/[A-Za-z0-9_-]{20,}/g, "1//***"],
  [/\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|FAL_KEY|GEMINI_API_KEY|BRUSHROUTER_[A-Z_]*KEY)\s*=\s*\S+/g, "$1=***"],
];

export function redact(input) {
  if (input == null) return input;
  let s = typeof input === "string" ? input : String(input);
  // Fast path: no registered secret or token shape pattern can match strings shorter than MIN_REGISTRY_LEN.
  if (s.length < MIN_REGISTRY_LEN) return s;

  // 1. exact registered values (longest first, so substrings don't leave tails)
  for (const secret of sortedRegistry) {
    if (secret.length > s.length) continue;
    if (s.includes(secret)) s = s.replaceAll(secret, "***");
  }
  // Fast path: skip regex evaluations if the string is shorter than any known token shape.
  if (s.length < MIN_SHAPE_LEN) return s;

  // 2. known shapes
  for (const [re, replacement] of SHAPE_PATTERNS) s = s.replace(re, replacement);
  return s;
}

// A marker for an object whose `data` field holds bytes brushrouter produced
// itself (base64 image data in an MCP content block).
//
// Why it exists: `data` is the only multi-megabyte string brushrouter emits, and
// redactValue() runs twelve token-shape regexes over every string it sees —
// measured at ~10ms per megabyte, paid again on every `image_result` poll.
//
// Why it is safe: this is an explicit marker set by our own code, not a guess
// about content. A provider or a caller cannot set it, so no credential can
// smuggle itself past redaction by *looking* like base64. It also exempts one
// field of one object — every other field (including `mimeType`, which comes
// from the provider) is still redacted.
export const OPAQUE_BYTES = Symbol("brushrouter.opaqueBytes");

// Deep-redact a value for machine-readable output. Keys that are *named* like
// secrets are replaced wholesale; everything else is string-redacted.
const SECRET_KEY_RE = /(token|secret|password|apikey|api_key|authorization|bearer|credential|private)/i;

// Recursion stops here so a pathological or cyclic structure cannot blow the
// stack. The limit must fail *closed*: the guard used to return the subtree raw,
// which meant a credential nested deeper than the limit reached the model
// untouched. A string leaf is now redacted at any depth, and a container past
// the limit collapses to a marker rather than passing through.
const MAX_REDACT_DEPTH = 8;

export function redactValue(value, depth = 0) {
  if (typeof value === "string") return redact(value);
  if (value == null || typeof value !== "object") return value;
  if (depth > MAX_REDACT_DEPTH) return "***";
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  const opaque = value[OPAQUE_BYTES] === true;
  const out = {};
  for (const k of Object.keys(value)) {
    const v = value[k];
    if (opaque && k === "data" && typeof v === "string") {
      out[k] = v;
      continue;
    }
    if (SECRET_KEY_RE.test(k) && typeof v === "string" && v.length >= MIN_REGISTRY_LEN) {
      out[k] = "***";
    } else {
      out[k] = redactValue(v, depth + 1);
    }
  }
  return out;
}

// A safe error string for humans and models.
export function safeError(err) {
  const msg = err?.message || String(err);
  return redact(msg);
}

// A parse-error message that is safe to show. V8 quotes the input it choked on
// back at you — `Unexpected token 'S', "SECRETVALUE..." is not valid JSON` —
// and that fragment is file content we never meant to print. Redaction cannot
// help: it is not a known secret, just an unknown slice of a file. So drop
// whatever the parser quoted back and keep the useful part.
export function safeParseMessage(err) {
  return redact(String(err?.message || err)).replace(/"[^"]*"/g, '"…"');
}
