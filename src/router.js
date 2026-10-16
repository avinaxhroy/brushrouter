// The router: picks a provider and generates, with automatic fallback.
//
// Routing model (per user request): AUTO + explicit override.
//   * --provider <id>  => use exactly that provider (no silent fallback unless
//                         --fallback is passed).
//   * otherwise        => walk cfg.priority, skipping providers that are
//                         disabled or unavailable, and try each in turn.

import { loadConfig, providerConfig, getUserConfigPath } from "./config.js";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { saveImage, batchItemPath } from "./util/common.js";
import { codexCliProvider } from "./providers/codex-cli.js";
import { codexProvider, readAuth } from "./providers/codex.js";
import { gptweb2apiProvider } from "./providers/gptweb2api.js";
import { geminiProvider } from "./providers/gemini.js";
import { openrouterProvider, falProvider, customHttpProvider } from "./providers/http.js";

export const PROVIDERS = {
  "codex-cli": codexCliProvider,
  codex: codexProvider,
  gptweb2api: gptweb2apiProvider,
  gemini: geminiProvider,
  openrouter: openrouterProvider,
  fal: falProvider,
  "custom-http": customHttpProvider,
};

export function listProviderIds() {
  return Object.keys(PROVIDERS);
}

export async function probeAll(cfg) {
  // Probes are independent — each spawns a process or makes a request of its
  // own — so running them together costs the slowest probe instead of the sum.
  // `Promise.all` preserves this order, which callers (doctor, routes) display.
  return Promise.all(
    listProviderIds().map(async (id) => {
      const p = PROVIDERS[id];
      const pcfg = providerConfig(cfg, id);
      let status;
      try {
        status = await p.probe(pcfg);
      } catch (e) {
        status = { available: false, auth: "error", detail: e.message };
      }
      return {
        id,
        label: p.label,
        kind: p.kind,
        note: p.note,
        supportsImages: p.supportsImages !== false,
        enabled: pcfg.enabled !== false,
        ...status,
      };
    }),
  );
}

// Exported so the CLI's `gen --dry-run` reports the exact order the router
// would use instead of re-deriving it.
export async function planAttemptOrder(cfg, { provider, fallback, images = [] } = {}) {
  return attemptOrder(cfg, { provider, fallback, images });
}

// Build the ordered attempt list for a request.
async function attemptOrder(cfg, { provider, fallback, images }) {
  const all = listProviderIds();
  const allSet = new Set(all);
  if (provider) {
    if (!PROVIDERS[provider]) throw new Error(`unknown provider "${provider}" (known: ${all.join(", ")})`);
    if (!fallback) return [provider];
    const rest = cfg.priority.filter((p) => p !== provider && allSet.has(p) && providerConfig(cfg, p).enabled !== false);
    return [provider, ...rest];
  }
  let enabled = cfg.priority.filter((p) => allSet.has(p) && providerConfig(cfg, p).enabled !== false);
  // A free ChatGPT login can only generate through the gptweb2api web bucket
  // (Codex paths are paid-gated and their probes refuse them); it is the
  // account-based "login you already pay for" equivalent, so lead with it
  // rather than leave it at its default last spot behind metered key routes.
  if (enabled.includes("gptweb2api")) {
    try {
      if (readAuth(providerConfig(cfg, "codex")).plan === "free") {
        enabled = ["gptweb2api", ...enabled.filter((p) => p !== "gptweb2api")];
      }
    } catch {} // no ChatGPT auth on this machine — keep the configured order
  }
  if (images?.length) {
    const capable = enabled.filter((p) => PROVIDERS[p]?.supportsImages !== false);
    const incapable = enabled.filter((p) => PROVIDERS[p]?.supportsImages === false);
    enabled = [...capable, ...incapable];
  }
  return enabled;
}

export async function generate({ prompt, size, quality, background, images, out, cwd = process.cwd(), provider, model, fallback = false, onProgress }, cfgIn) {
  const cfg = cfgIn || loadConfig({ cwd });
  const order = await attemptOrder(cfg, { provider, fallback, images });
  if (!order.length) {
    const err = new Error("no providers enabled — check your config");
    err.code = "NO_PROVIDERS";
    throw err;
  }
  const attempts = [];
  let lastErr;
  for (const id of order) {
    const p = PROVIDERS[id];
    const pcfg = providerConfig(cfg, id);
    if (!provider || id !== provider) {
      // In auto mode (or fallback mode for secondary providers), skip providers that are clearly unavailable.
      const status = await p.probe(pcfg).catch((e) => ({ available: false, detail: e.message }));
      if (!status.available) {
        attempts.push({ provider: id, outcome: "skipped", reason: status.detail });
        onProgress?.(`skipping ${id}: ${status.detail}`, 5);
        continue;
      }
    }
    onProgress?.(`using ${id}...`, 10);
    // codex takes background as an API field; every other route can only put it
    // in the prompt, so say it there rather than drop the request.
    const promptForProvider =
      background === "transparent" && id !== "codex"
        ? `${prompt} Generate the image with a fully transparent background (no scene behind the subject, RGBA output).`
        : prompt;
    try {
      const result = await p.generate({ prompt: promptForProvider, size, quality, background, images, out, cwd, model, onProgress }, pcfg);
      // Contract check: a provider must return actual image bytes. A provider
      // that accidentally returns an Error object (or nothing) must be treated
      // as a failure here, not silently spread into a buffer-less result.
      if (!result || !Buffer.isBuffer(result.buffer) || result.buffer.length === 0) {
        const e = new Error(`${id} returned no image data`);
        e.code = "FAILED";
        throw e;
      }
      attempts.push({ provider: id, outcome: "ok", model: result.meta?.model });
      // Tell the caller whether the reference images it passed actually reached
      // the provider, so a drop is reportable instead of silent.
      const meta = { ...result.meta, imagesUsed: p.supportsImages !== false && Boolean(images?.length) };
      return { ...result, meta, provider: id, attempts };
    } catch (e) {
      lastErr = e;
      attempts.push({ provider: id, outcome: "failed", reason: e.message, code: e.code });
      onProgress?.(`${id} failed: ${e.message}`, 10);
      if (provider && !fallback) break; // explicit request, no fallback asked for
    }
  }
  const summary = attempts.map((a) => `${a.provider}: ${a.outcome}${a.reason ? ` (${a.reason})` : ""}`).join("; ");
  const err = new Error(`all providers failed -> ${summary}`);
  err.attempts = attempts;
  err.cause = lastErr;
  err.code = lastErr?.code || "ALL_FAILED";
  throw err;
}

export const DEFAULT_PROVIDER_CONCURRENCY = {
  "codex-cli": 1,
  codex: 1,
  gemini: 1,
  gptweb2api: 2,
  openrouter: 4,
  fal: 4,
  "custom-http": 2,
};

export function isRateLimitError(err) {
  if (!err) return false;
  if (err.code === "QUOTA" || err.code === "RATE_LIMIT" || err.code === "NO_CREDITS" || err.code === "USAGE_LIMIT_REACHED") return true;
  const msg = `${err.message || ""} ${err.code || ""}`;
  return /429|rate[-_\s]?limit|usage[-_\s]?limit|resource[-_\s]?exhausted|too many requests|quota/i.test(msg);
}

export async function batchGenerate(
  {
    items,
    concurrency,
    provider,
    fallback = false,
    cooldownMs = 60000,
    outDir,
    force = false,
    retainBuffers = true,
    onProgress,
    onItemStart,
    onItemComplete,
    onItemFail,
    onProviderCooldown,
    cwd = process.cwd(),
  },
  cfgIn,
) {
  const cfg = cfgIn || loadConfig({ cwd });
  if (!Array.isArray(items) || items.length === 0) {
    return { results: [], total: 0, completed: 0, failed: 0 };
  }

  let allowedProviders = [];
  if (provider) {
    if (!PROVIDERS[provider]) throw new Error(`unknown provider "${provider}" (known: ${listProviderIds().join(", ")})`);
    allowedProviders = [provider];
    if (fallback) {
      const allSet = new Set(listProviderIds());
      const rest = cfg.priority.filter((p) => p !== provider && allSet.has(p) && providerConfig(cfg, p).enabled !== false);
      allowedProviders.push(...rest);
    }
  } else {
    const probes = await probeAll(cfg);
    const probeMap = new Map(probes.map((p) => [p.id, p]));
    allowedProviders = cfg.priority.filter((p) => {
      const pr = probeMap.get(p);
      return pr && pr.enabled && pr.available;
    });
  }

  if (!allowedProviders.length) {
    const err = new Error("no providers available for batch");
    err.code = "NO_PROVIDERS";
    throw err;
  }

  function getProviderConcurrency(id) {
    const pcfg = providerConfig(cfg, id);
    if (typeof pcfg.concurrency === "number" && pcfg.concurrency > 0) return pcfg.concurrency;
    return DEFAULT_PROVIDER_CONCURRENCY[id] || 1;
  }

  const globalMax = Number(concurrency) > 0
    ? Number(concurrency)
    : allowedProviders.reduce((sum, id) => sum + getProviderConcurrency(id), 0);

  const queue = items.map((it, idx) => {
    const obj = typeof it === "string" ? { prompt: it } : { ...it };
    let outPath = obj.out;
    if (!outPath && outDir) {
      outPath = batchItemPath(outDir, idx + 1, items.length, obj.prompt);
    }
    return {
      index: idx,
      id: obj.id || `item-${idx + 1}`,
      prompt: obj.prompt,
      size: obj.size,
      quality: obj.quality,
      background: obj.background,
      model: obj.model,
      images: obj.images || [],
      out: outPath,
      attempts: [],
      failedProviders: new Set(),
    };
  });

  const activeCount = new Map(allowedProviders.map((id) => [id, 0]));
  const cooldownUntil = new Map();
  const results = new Array(queue.length);
  const pendingQueue = [...queue];
  let inFlight = 0;
  let doneCount = 0;
  let completedCount = 0;
  let failedCount = 0;
  let retryTimer = null;
  function findFreeProvider(item) {
    const now = Date.now();
    for (const id of allowedProviders) {
      if (item.failedProviders.has(id)) continue;
      const p = PROVIDERS[id];
      if (item.images?.length && p.supportsImages === false) continue;
      const until = cooldownUntil.get(id) || 0;
      if (until > now) continue;
      const active = activeCount.get(id) || 0;
      if (active < getProviderConcurrency(id)) return id;
    }
    return null;
  }

  return new Promise((resolveBatch) => {
    function dispatch() {
      if (doneCount === queue.length) {
        clearTimeout(retryTimer);
        retryTimer = null;
        resolveBatch({
          results,
          total: queue.length,
          completed: completedCount,
          failed: failedCount,
        });
        return;
      }

      while (inFlight < globalMax && pendingQueue.length > 0) {
        let targetItemIdx = -1;
        let chosenProvider = null;
        for (let i = 0; i < pendingQueue.length; i++) {
          const prov = findFreeProvider(pendingQueue[i]);
          if (prov) {
            targetItemIdx = i;
            chosenProvider = prov;
            break;
          }
        }

        if (targetItemIdx === -1 || !chosenProvider) break;

        const [item] = pendingQueue.splice(targetItemIdx, 1);
        activeCount.set(chosenProvider, activeCount.get(chosenProvider) + 1);
        inFlight++;
        executeItem(item, chosenProvider);
      }

      if (pendingQueue.length > 0 && inFlight === 0) {
        const now = Date.now();
        let nextExpiry = Infinity;
        for (const id of allowedProviders) {
          const until = cooldownUntil.get(id) || 0;
          if (until > now) nextExpiry = Math.min(nextExpiry, until - now);
        }
        if (nextExpiry < Infinity) {
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => {
            retryTimer = null;
            dispatch();
          }, Math.max(50, nextExpiry));
          retryTimer.unref?.();
        } else {
          const item = pendingQueue.shift();
          const failure = {
            ok: false,
            index: item.index,
            item,
            error: "all available providers failed or incompatible",
            code: "ALL_FAILED",
            attempts: item.attempts,
          };
          results[item.index] = failure;
          doneCount++;
          failedCount++;
          onItemFail?.(failure);
          dispatch();
        }
      }
    }

    async function executeItem(item, pId) {
      onItemStart?.({ item, index: item.index, provider: pId });
      const p = PROVIDERS[pId];
      const pcfg = providerConfig(cfg, pId);

      try {
        const res = await p.generate(
          {
            prompt: item.prompt,
            size: item.size,
            quality: item.quality,
            background: item.background,
            images: item.images,
            out: item.out,
            cwd,
            model: item.model,
            onProgress: (msg) => onProgress?.(`[${item.index + 1}/${queue.length}] ${pId}: ${msg}`),
          },
          pcfg,
        );

        if (!res || !Buffer.isBuffer(res.buffer) || res.buffer.length === 0) {
          throw new Error(`${pId} returned no image data`);
        }

        item.attempts.push({ provider: pId, outcome: "ok", model: res.meta?.model });

        let saved = null;
        if (item.out) {
          saved = saveImage(item.out, res.buffer, cwd, { force });
        }

        const success = {
          ok: true,
          index: item.index,
          item,
          buffer: retainBuffers ? res.buffer : null,
          savedPath: saved?.savedPath || null,
          provider: pId,
          meta: {
            ...res.meta,
            imagesUsed: p.supportsImages !== false && Boolean(item.images?.length),
          },
          attempts: item.attempts,
        };
        if (!retainBuffers) {
          res.buffer = null;
        }
        results[item.index] = success;
        doneCount++;
        completedCount++;
        onItemComplete?.(success);
      } catch (err) {
        item.attempts.push({ provider: pId, outcome: "failed", reason: err.message, code: err.code });
        item.failedProviders.add(pId);

        if (isRateLimitError(err)) {
          const cd = Date.now() + cooldownMs;
          cooldownUntil.set(pId, cd);
          onProviderCooldown?.({ provider: pId, reason: err.message, cooldownUntil: cd });
        }

        const hasCandidate = allowedProviders.some(
          (cand) => !item.failedProviders.has(cand) && (!item.images?.length || PROVIDERS[cand]?.supportsImages !== false),
        );

        if (hasCandidate && (!provider || fallback)) {
          pendingQueue.unshift(item);
          onProgress?.(`[${item.index + 1}/${queue.length}] ${pId} failed (${err.message}) -> requeuing`);
        } else {
          const failure = {
            ok: false,
            index: item.index,
            item,
            error: err.message,
            code: err.code,
            attempts: item.attempts,
          };
          results[item.index] = failure;
          doneCount++;
          failedCount++;
          onItemFail?.(failure);
        }
      } finally {
        activeCount.set(pId, activeCount.get(pId) - 1);
        inFlight--;
        dispatch();
      }
    }

    dispatch();
  });
}

// Persist a route's enabled flag into the USER config file (never the project
// one — a per-user preference must not be written into a shared checkout).
// Returns the path written. The caller is responsible for messaging.
// `path` is an override used by tests so they never touch the real user config.
export function setRouteEnabled(name, enabled, { path = getUserConfigPath() } = {}) {
  if (!PROVIDERS[name]) {
    const e = new Error(`unknown route "${name}" (known: ${listProviderIds().join(", ")})`);
    e.code = "UNKNOWN_PROVIDER";
    throw e;
  }
  mkdirSync(dirname(path), { recursive: true });
  let data = {};
  if (existsSync(path)) {
    try {
      data = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      const err = new Error(`refusing to overwrite unparseable ${path}: ${e.message}`);
      err.code = "BAD_CONFIG";
      throw err;
    }
  }
  data.providers = data.providers || {};
  data.providers[name] = { ...(data.providers[name] || {}), enabled };
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  return path;
}

export {
  findRecipes,
  getRecipe,
  publicRecipe,
  fill,
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
} from "./library.js";
