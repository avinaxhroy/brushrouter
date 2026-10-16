// The prompt library: what brushrouter hands an agent so it can write a good
// image prompt instead of guessing at one.
//
// ONE LIBRARY, TWO KINDS OF THING. Both are "prompt assets you fill in", which
// is why they share a module and a schema, but they answer different questions:
//
//   kind "job"  (data/recipes/)  a JOB  — "give me a product hero shot"
//   kind "look" (data/styles/)   a LOOK — "give me the mono-noir editorial system"
//
// A job is a layout we authored; a look is a fixed visual system borrowed from
// someone else's style and filled with your content. Jobs are ours. Looks are
// vendored under MIT and every result carries the upstream credit.
//
// WHAT THIS IS NOT: a copy of somebody else's prompt collection. Those exist,
// and reading 150 of them taught us the thing worth keeping — the *structure*.
// Roughly 95% of published image prompts are assembled from the same small set
// of named slots. So the reusable asset is the skeleton, not any individual
// prompt text. The jobs in data/recipes/ are written by us.
//
// TWO INVARIANTS, and they are the whole point:
//   1. Every entry has a `text` skeleton, so an agent holding no source image
//      is never blocked. (The corpus we studied failed this: 33 of 150 prompts
//      required a reference image and none of them said what to do without one.)
//   2. `image` is an *optional upgrade* layered on top of `text`, never a
//      requirement. When the caller does have a photo, `image.skeleton` swaps in
//      and `image.preserve` states what must survive the trip.
//
// Everything here is a pure function over data/. No network, no model call, no
// index: 27 jobs and 137 looks is a linear scan.
//
// WHY `styleLock` AND `doNotClone` EXIST. Two mechanisms we did not have until
// we read the cookbook:
//   styleLock   the invariants that must survive every generation. Models lose
//               the middle of a long prompt, so the style's defining traits get
//               re-stated next to the content rather than left implicit.
//   doNotClone  the content that must not be reproduced — the source a style was
//               distilled from. Distinct from `negatives`, which are craft
//               negatives (no watermark, no extra limbs). A look that clones its
//               source image is a licensing problem, not a quality one.

import { readFileSync, readdirSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Directory holding our own recipe files. Override to point at your own library. */
export const RECIPES_DIR = process.env.BRUSHROUTER_RECIPES_DIR || join(HERE, "..", "data", "recipes");

/** Vendored style file. Optional: without it the library serves jobs only. */
export const STYLES_FILE = process.env.BRUSHROUTER_STYLES_FILE || join(HERE, "..", "data", "styles", "styles.json");

/** The three shapes of result an agent can ask for. */
export const MODES = ["categories", "related", "one"];

/** What the caller brings: a text idea, or a text idea plus a reference image. */
export const INPUTS = ["text", "image"];

/** The two kinds of prompt asset. */
export const KINDS = ["job", "look"];

// Words that carry no signal when scoring a query. Small list on purpose —
// the alias map does the heavy lifting, this only stops "a"/"the"/"of" from
// matching everything.
const STOPWORDS = new Set([
  "a", "an", "and", "any", "as", "at", "be", "but", "by", "can", "do", "for",
  "from", "get", "give", "how", "i", "in", "into", "is", "it", "its", "just",
  "like", "make", "me", "my", "need", "not", "of", "on", "one", "or", "our",
  "out", "please", "show", "so", "some", "that", "the", "their", "them",
  "then", "there", "these", "they", "this", "to", "up", "use", "using", "want",
  "was", "we", "what", "when", "which", "who", "will", "with", "would", "you",
  "your",
]);

const EMPTY_SET = new Set();

function tokens(s) {
  if (!s) return EMPTY_SET;
  const str = String(s).trim();
  if (!str) return EMPTY_SET;
  const arr = str
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  if (arr.length === 0) return EMPTY_SET;
  return new Set(arr);
}

// Token match with light morphology. An agent writes "explain", our alias says
// "explainer"; it writes "illustration", a recipe says "illustrated". Requiring
// exact equality loses those, and a real stemmer is a dependency we do not need
// at this size. Bidirectional prefix matching over words of 4+ characters
// covers the common English inflections without matching "art" to "article".
function tokenMatches(a, b) {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (la < 4 || lb < 4) return false;
  const short = la <= lb ? a : b;
  const long = la <= lb ? b : a;
  return long.startsWith(short) && short.length / long.length >= 0.6;
}

/** Fast prefix-bucketed token index for O(1) exact and O(K) prefix matching */
export class TokenIndex {
  constructor(tokenSet) {
    this.exact = tokenSet;
    this.byPrefix4 = new Map();
    for (const t of tokenSet) {
      if (t.length >= 4) {
        const p4 = t.slice(0, 4);
        let list = this.byPrefix4.get(p4);
        if (!list) {
          list = [];
          this.byPrefix4.set(p4, list);
        }
        list.push(t);
      }
    }
  }

  matches(word) {
    if (this.exact.has(word)) return true;
    const lw = word.length;
    if (lw < 4) return false;
    const candidates = this.byPrefix4.get(word.slice(0, 4));
    if (!candidates) return false;
    for (let i = 0; i < candidates.length; i++) {
      const t = candidates[i];
      const lt = t.length;
      const short = lt <= lw ? t : word;
      const long = lt <= lw ? word : t;
      if (long.startsWith(short) && short.length / long.length >= 0.6) return true;
    }
    return false;
  }
}

function anyTokenMatches(tokens, word) {
  if (tokens instanceof TokenIndex || tokens?._tokenIndex) {
    const idx = tokens instanceof TokenIndex ? tokens : tokens._tokenIndex;
    return idx.matches(word);
  }
  if (tokens.has(word)) return true;
  const lw = word.length;
  if (lw < 4) return false;
  for (const t of tokens) {
    const lt = t.length;
    if (lt < 4) continue;
    const short = lt <= lw ? t : word;
    const long = lt <= lw ? word : t;
    if (long.startsWith(short) && short.length / long.length >= 0.6) return true;
  }
  return false;
}

// Deterministic tie-break and seed-based variety. FNV-1a: tiny, stable across
// runs and platforms, which is what "same seed + same query = same result"
// needs. Not a cryptographic hash and does not need to be.
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function fnv1aSeedBase(seed) {
  let h = 0x811c9dc5;
  const sSeed = String(seed);
  for (let i = 0; i < sSeed.length; i++) {
    h ^= sSeed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= 58; // ':'
  return Math.imul(h, 0x01000193) >>> 0;
}

function fnv1aFromBase(base, str) {
  let h = base;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function readJson(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(`cannot read library file ${path}: ${cause.message}`, { cause });
  }
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new Error(`invalid JSON in ${path}: ${cause.message}`, { cause });
  }
}

const EMPTY_ARRAY = Object.freeze([]);

function parseAliases(aliases) {
  if (!aliases || aliases.length === 0) {
    return { raw: EMPTY_ARRAY, phrase: EMPTY_ARRAY, word: EMPTY_ARRAY };
  }
  const raw = aliases.map((a) => a.toLowerCase());
  const phrase = [];
  const word = [];
  for (const a of raw) {
    if (a.includes(" ")) phrase.push(a);
    else word.push(a);
  }
  return { raw, phrase, word };
}

/** Index one entry: the searchable projections every kind shares. */
function indexEntry(entry, { category, categoryLabel, aliasData, defaultValues = {}, allSlots }) {
  const optVals = entry.defaults ? Object.values(entry.defaults) : EMPTY_ARRAY;
  const optPhrases = optVals.length
    ? optVals.map((v) => normalize(v)).filter((p) => p && p.length >= 4)
    : EMPTY_ARRAY;
  const parsedAliases = aliasData || { raw: EMPTY_ARRAY, phrase: EMPTY_ARRAY, word: EMPTY_ARRAY };
  const matchTokens = tokens(`${entry.id} ${entry.goal} ${entry.when}`);
  const lockTokens = tokens((entry.styleLock || []).join(" "));
  const optTokens = tokens(optVals.join(" "));

  const slotOptions = {};
  if (allSlots) {
    for (const s of entry.slots || []) {
      const spec = allSlots[s];
      if (spec?.options?.length) slotOptions[s] = spec.options;
    }
  }

  const cleanText = (entry.text || "").replace(/\b[Ee]xclude\s*\.\s*/g, "");
  const cleanImageSkeleton = entry.image?.skeleton ? entry.image.skeleton.replace(/\b[Ee]xclude\s*\.\s*/g, "") : null;

  const gistStr = String(entry.goal || entry.when || "");
  let gist200 = gistStr;
  if (gistStr.length > 200) {
    const cut = gistStr.slice(0, 197);
    const space = cut.lastIndexOf(" ");
    gist200 = `${space > 200 * 0.6 ? cut.slice(0, space) : cut}...`;
  }

  return {
    ...entry,
    category: category ?? entry.category,
    categoryLabel,
    _match: matchTokens,
    _matchIndex: new TokenIndex(matchTokens),
    _lock: lockTokens,
    _lockIndex: new TokenIndex(lockTokens),
    _options: optTokens,
    _optionsIndex: new TokenIndex(optTokens),
    _optionPhrases: optPhrases,
    _aliases: parsedAliases.raw,
    _phraseAliases: parsedAliases.phrase,
    _wordAliases: parsedAliases.word,
    _defaultValues: defaultValues,
    _slotOptions: slotOptions,
    _cleanText: cleanText,
    _cleanImageSkeleton: cleanImageSkeleton,
    _gist200: gist200,
  };
}

let cache = null;

/**
 * Load and index the whole library: our jobs plus any vendored looks.
 * Memoized — the library is static, so re-reading it per call would be waste.
 */
export function loadRecipes() {
  if (cache) return cache;
  const slotsFile = readJson(join(RECIPES_DIR, "slots.json"));
  const slots = slotsFile.slots || {};
  const freeSlots = Object.entries(slots).filter(([, s]) => s.free).map(([k]) => k);
  const categories = [];
  const recipes = [];

  const files = readdirSync(RECIPES_DIR)
    .filter((f) => f.endsWith(".json") && f !== "slots.json")
    .sort();

  for (const file of files) {
    const cat = readJson(join(RECIPES_DIR, file));
    const aliasData = parseAliases(cat.aliases);
    categories.push({
      id: cat.id,
      kind: "job",
      label: cat.label,
      intent: cat.intent,
      aliases: cat.aliases || [],
      count: (cat.recipes || []).length,
      recipes: (cat.recipes || []).map((r) => r.id),
      _phraseAliases: aliasData.phrase,
      _wordAliases: aliasData.word,
    });
    for (const r of cat.recipes || []) {
      const defaultValues = {};
      for (const slot of r.slots || []) {
        const spec = slots[slot];
        defaultValues[slot] = spec?.options?.length ? r.defaults?.[slot] ?? spec.options[0] : "";
      }
      const indexed = indexEntry(r, { category: cat.id, categoryLabel: cat.label, aliasData, defaultValues, allSlots: slots });
      recipes.push({ ...indexed, kind: "job" });
    }
  }

  // Looks are optional. A user who prunes data/styles/ gets a working jobs-only
  // library rather than a crash, and the tests can exercise both shapes.
  const styles = [];
  // Parsed once and kept: the file is ~1 MB, and `styleSource` below used to
  // re-read and re-parse it just to reach one string field.
  let stylesFile = null;
  if (existsSync(STYLES_FILE)) {
    stylesFile = readJson(STYLES_FILE);
    const file = stylesFile;
    const meta = new Map((file.categories || []).map((c) => [c.id, { ...c, aliasData: parseAliases(c.aliases) }]));
    const byCat = new Map();
    for (const s of file.styles || []) {
      const cat = meta.get(s.category) || {};
      const defaultValues = {};
      for (const slot of s.slots || []) defaultValues[slot] = "";
      styles.push(
        indexEntry({ ...s, kind: "look" }, { categoryLabel: cat.label || s.category, aliasData: cat.aliasData, defaultValues, allSlots: slots }),
      );
      let catList = byCat.get(s.category);
      if (!catList) {
        catList = [];
        byCat.set(s.category, catList);
      }
      catList.push(s.id);
    }
    for (const [id, ids] of [...byCat.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const catMeta = meta.get(id);
      categories.push({
        id,
        kind: "look",
        label: catMeta?.label || id,
        intent: catMeta?.intent || "",
        aliases: catMeta?.aliases || [],
        count: ids.length,
        recipes: ids,
        _phraseAliases: catMeta?.aliasData?.phrase || EMPTY_ARRAY,
        _wordAliases: catMeta?.aliasData?.word || EMPTY_ARRAY,
      });
    }
  }

  const all = [...recipes, ...styles];
  const byCategory = new Map();
  for (const r of all) {
    let list = byCategory.get(r.category);
    if (!list) {
      list = [];
      byCategory.set(r.category, list);
    }
    list.push(r);
  }

  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const recipeById = new Map(all.map((r) => [r.id, r]));

  const shapes = slotsFile.shapes || {};
  function formatCategory(c) {
    return {
      id: c.id,
      kind: c.kind,
      label: c.label,
      intent: c.intent,
      count: c.count,
      shapes: [...new Set(c.recipes.map((id) => recipeById.get(id)?.shape).filter(Boolean))].map((s) => ({
        id: s,
        means: shapes[s] || s,
      })),
    };
  }

  const precomputedListCategories = {
    all: categories.map(formatCategory),
    job: categories.filter((c) => c.kind === "job").map(formatCategory),
    look: categories.filter((c) => c.kind === "look").map(formatCategory),
  };

  cache = {
    version: slotsFile.version,
    note: slotsFile.note,
    slots,
    freeSlots,
    shapes,
    categories,
    recipes: all,
    recipesByKind: {
      job: recipes,
      look: styles,
    },
    recipesByCategory: byCategory,
    recipesWithImage: all.filter((r) => r.image),
    counts: { job: recipes.length, look: styles.length },
    categoryIds: {
      all: categories.map((c) => c.id),
      job: categories.filter((c) => c.kind === "job").map((c) => c.id),
      look: categories.filter((c) => c.kind === "look").map((c) => c.id),
    },
    recipeIds: {
      all: all.map((r) => r.id),
      job: recipes.map((r) => r.id),
      look: styles.map((r) => r.id),
    },
    listCategories: precomputedListCategories,
    styleSource: stylesFile?.source || null,
    categoryById,
    recipeById,
  };
  return cache;
}

/** Drop the memoized library. For tests and for a swapped RECIPES_DIR. */
export function resetRecipesCache() {
  cache = null;
}

/** Category ids, optionally narrowed to one kind. */
export function categoryIds(kind = null) {
  if (cache) {
    return cache.categoryIds[kind || "all"] || [];
  }
  let jobCats = [];
  if (!kind || kind === "job") {
    try {
      jobCats = readdirSync(RECIPES_DIR)
        .filter((f) => f.endsWith(".json") && f !== "slots.json")
        .sort()
        .map((f) => f.replace(/\.json$/, ""));
    } catch {}
  }
  let lookCats = [];
  if (!kind || kind === "look") {
    try {
      if (existsSync(STYLES_FILE)) {
        const fd = openSync(STYLES_FILE, "r");
        try {
          const buf = Buffer.alloc(8192);
          const bytesRead = readSync(fd, buf, 0, 8192, 0);
          const head = buf.toString("utf8", 0, bytesRead);
          const sIdx = head.indexOf('"styles":');
          if (sIdx > 0) {
            lookCats = [...head.slice(0, sIdx).matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]);
          } else {
            const raw = readFileSync(STYLES_FILE, "utf8");
            lookCats = (JSON.parse(raw).categories || []).map((c) => c.id);
          }
        } finally {
          closeSync(fd);
        }
      }
    } catch {}
  }
  if (kind === "job") return jobCats;
  if (kind === "look") return lookCats;
  return [...jobCats, ...lookCats];
}

/** Every entry id in the library, optionally narrowed to one kind. */
export function recipeIds(kind = null) {
  if (cache) {
    return cache.recipeIds[kind || "all"] || [];
  }
  return loadRecipes().recipeIds[kind || "all"] || [];
}
/** Fast count of recipes by kind, without building search token indexes if not loaded yet. */
export function recipeCounts() {
  if (cache) return cache.counts;
  let job = 0;
  try {
    const files = readdirSync(RECIPES_DIR).filter((f) => f.endsWith(".json") && f !== "slots.json");
    for (const file of files) {
      const cat = readJson(join(RECIPES_DIR, file));
      job += (cat.recipes || []).length;
    }
  } catch {}
  let look = 0;
  try {
    if (existsSync(STYLES_FILE)) {
      const fd = openSync(STYLES_FILE, "r");
      try {
        const buf = Buffer.alloc(4096);
        const bytesRead = readSync(fd, buf, 0, 4096, 0);
        const head = buf.toString("utf8", 0, bytesRead);
        const matches = [...head.matchAll(/"intent":\s*"(\d+)\s+reusable/g)];
        if (matches.length > 0) {
          look = matches.reduce((sum, m) => sum + Number(m[1]), 0);
        } else {
          const raw = readFileSync(STYLES_FILE, "utf8");
          look = (JSON.parse(raw).styles || []).length;
        }
      } finally {
        closeSync(fd);
      }
    }
  } catch {}
  return { job, look };
}

/** The map of what exists — mode "categories". */
export function listCategories({ kind = null } = {}) {
  const lib = loadRecipes();
  return (lib.listCategories[kind || "all"] || []).slice();
}

/** One exact entry by id. Throws rather than returning null: a typo'd id is a
 *  caller bug and should be loud. */
export function getRecipe(id) {
  const { recipeById } = loadRecipes();
  const r = recipeById.get(id);
  if (!r) throw new Error(`unknown recipe id "${id}"`);
  return r;
}

/**
 * Score every entry against a query.
 *
 * Deliberately a hand-written alias map rather than embeddings. At this size a
 * vector store would add a model dependency, a network call and a cold-start
 * cost to rank a list you can read in one screen. The alias map is also
 * *inspectable*: when a search is wrong you can see why and fix one word, which
 * you cannot do with a similarity score.
 */
function scoreRecipe(recipe, normalizedQuery, queryTokens, queryIndex, catAliasScore = 0) {
  let score = 0;
  // `identity` counts only the signals that *name* the entry: its aliases, its
  // id/goal/when, and the values it already defaults to. An entry with no
  // identity hit is not a match at all, however much prose it happens to share
  // with the query — see the filter in findRecipes.
  let identity = 0;

  if (catAliasScore > 0) {
    score += catAliasScore;
    identity += catAliasScore;
  } else if (!queryIndex) {
    for (const phrase of recipe._phraseAliases) {
      if (normalizedQuery.includes(phrase)) {
        score += 4;
        identity += 4;
      }
    }
    for (const word of recipe._wordAliases) {
      if (anyTokenMatches(queryTokens, word)) {
        score += 2;
        identity += 2;
      }
    }
  }

  // How much of the query the entry's own name/goal/when accounts for, as a
  // fraction rather than a count.
  let nameHits = 0;
  const matchIndex = recipe._matchIndex;
  if (matchIndex) {
    for (const t of queryTokens) if (matchIndex.matches(t)) nameHits += 1;
  } else {
    for (const t of queryTokens) if (anyTokenMatches(recipe._match, t)) nameHits += 1;
  }
  if (nameHits > 0) {
    const points = (3 * nameHits) / queryTokens.size;
    score += points;
    identity += points;
  }

  // Asking for exactly what an entry already uses is the strongest signal there is
  const optPhrases = recipe._optionPhrases;
  for (let j = 0; j < optPhrases.length; j++) {
    if (normalizedQuery.includes(optPhrases[j])) {
      score += 5;
      identity += 5;
      break;
    }
  }

  const optIndex = recipe._optionsIndex;
  if (optIndex) {
    for (const t of queryTokens) {
      if (optIndex.matches(t)) {
        score += 1;
        identity += 1;
      }
    }
  } else {
    for (const t of queryTokens) {
      if (anyTokenMatches(recipe._options, t)) {
        score += 1;
        identity += 1;
      }
    }
  }

  // Style-lock anchors are supporting evidence, capped at +3
  let boost = 0;
  if (identity > 0) {
    const lockIndex = recipe._lockIndex;
    if (lockIndex) {
      for (const t of queryTokens) {
        if (boost >= 3) break;
        if (lockIndex.matches(t)) boost += 1;
      }
    } else {
      for (const t of queryTokens) {
        if (boost >= 3) break;
        if (anyTokenMatches(recipe._lock, t)) boost += 1;
      }
    }
  }
  return { score: score + boost, identity };
}

function normalize(q) {
  return String(q).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Find prompt assets.
 *
 * @param {object}  opts
 * @param {string?} opts.query    Free text in the caller's own words.
 * @param {string?} opts.category Restrict to one category id.
 * @param {string?} opts.kind     "job" | "look". Omit for both.
 * @param {string}  opts.input    "text" (default) or "image". "image" keeps only
 *                                entries that accept a reference image; "text"
 *                                keeps everything, because every entry is
 *                                runnable without one.
 * @param {string?} opts.shape    Restrict to single | grid | sheet | document.
 * @param {string}  opts.mode     categories | related | one.
 * @param {number}  opts.limit    Rows in "related" mode, including the best match.
 * @param {number}  opts.seed     Changes the pick when the query is vague or empty.
 * @param {string?} opts.id       Fetch one exact entry; overrides query/mode.
 * @returns {{mode:string, query:string|null, category:string|null, kind:string|null,
 *            input:string, shape:string|null, total:number, available:number,
 *            matched:boolean, rows:object[]}}
 */
export function findRecipes({
  query = null,
  category = null,
  kind = null,
  input = "text",
  shape = null,
  mode = "related",
  limit = 4,
  seed = 0,
  id = null,
} = {}) {
  const lib = loadRecipes();

  if (!MODES.includes(mode)) throw new Error(`unknown mode "${mode}" (use: ${MODES.join(" | ")})`);
  if (!INPUTS.includes(input)) throw new Error(`unknown input "${input}" (use: ${INPUTS.join(" | ")})`);
  if (kind && !KINDS.includes(kind)) throw new Error(`unknown kind "${kind}" (use: ${KINDS.join(" | ")})`);
  if (category && !lib.categoryById.has(category)) {
    throw new Error(`unknown category "${category}" (use: ${lib.categories.map((c) => c.id).join(", ")})`);
  }
  if (shape && !lib.shapes[shape]) {
    throw new Error(`unknown shape "${shape}" (use: ${Object.keys(lib.shapes).join(" | ")})`);
  }
  if (id) {
    return {
      mode: "one",
      query: null,
      category: null,
      kind: null,
      input,
      shape: null,
      total: 1,
      available: 1,
      matched: true,
      rows: [getRecipe(id)],
    };
  }

  let pool = category
    ? (lib.recipesByCategory.get(category) || [])
    : kind
      ? (lib.recipesByKind[kind] || [])
      : (input === "image" ? lib.recipesWithImage : lib.recipes);

  if (kind && category) pool = pool.filter((r) => r.kind === kind);
  if (shape) pool = pool.filter((r) => r.shape === shape);
  if (input === "image" && pool !== lib.recipesWithImage) {
    pool = pool.filter((r) => r.image);
  }
  if (mode === "categories") {
    const n = (lib.categoryIds[kind || "all"] || []).length;
    return { mode, query, category, kind, input, shape, total: n, available: n, matched: true, rows: [] };
  }

  const normalizedQuery = normalize(query || "");
  const queryTokens = tokens(query || "");
  const hasQuery = queryTokens.size > 0;

  let scored;
  if (!hasQuery) {
    // Fast path: with no query, score is 0 and no filtering occurs.
    const seedBase = fnv1aSeedBase(seed);
    scored = new Array(pool.length);
    for (let i = 0; i < pool.length; i++) {
      const row = pool[i];
      scored[i] = {
        row,
        score: 0,
        identity: 0,
        nudge: fnv1aFromBase(seedBase, row.id),
      };
    }
    scored.sort((a, b) => a.nudge - b.nudge || (a.row.id < b.row.id ? -1 : (a.row.id > b.row.id ? 1 : 0)));
  } else {
    const queryIndex = new TokenIndex(queryTokens);
    const seedBase = fnv1aSeedBase(seed);

    // Pre-score categories so all recipes in a category share alias hits without recomputing
    const catScores = new Map();
    const categoriesToScore = category
      ? [lib.categoryById.get(category)].filter(Boolean)
      : kind
        ? lib.categories.filter((c) => c.kind === kind)
        : lib.categories;

    for (let i = 0; i < categoriesToScore.length; i++) {
      const c = categoriesToScore[i];
      let score = 0;
      const phrases = c._phraseAliases || EMPTY_ARRAY;
      for (let j = 0; j < phrases.length; j++) {
        if (normalizedQuery.includes(phrases[j])) score += 4;
      }
      const words = c._wordAliases || EMPTY_ARRAY;
      for (let j = 0; j < words.length; j++) {
        if (queryIndex.matches(words[j])) score += 2;
      }
      catScores.set(c.id, score);
    }

    scored = [];
    for (let i = 0; i < pool.length; i++) {
      const row = pool[i];
      const catScore = catScores.get(row.category) || 0;
      const { score, identity } = scoreRecipe(row, normalizedQuery, queryTokens, queryIndex, catScore);
      if (identity > 0) {
        scored.push({
          row,
          score,
          identity,
          nudge: fnv1aFromBase(seedBase, row.id),
        });
      }
    }

    if (scored.length === 0) {
      return { mode, query, category, kind, input, shape, total: 0, available: 0, matched: false, rows: [] };
    }

    scored.sort((a, b) => b.score - a.score || a.nudge - b.nudge || (a.row.id < b.row.id ? -1 : (a.row.id > b.row.id ? 1 : 0)));
  }

  const requestedLimit = Number(limit);
  const capped = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(10, Math.trunc(requestedLimit))) : 4;
  const rows = mode === "one" ? scored.slice(0, 1) : scored.slice(0, capped);
  return {
    mode,
    query,
    category,
    kind,
    input,
    shape,
    total: rows.length,
    available: scored.length,
    matched: true,
    limit: capped,
    rows: rows.map((s) => s.row),
  };
}

/**
 * Fill a skeleton.
 *
 * Free slots have no default — the caller must supply them — so anything left
 * unfilled is reported in `missing` rather than silently shipped as a literal
 * "{subject}" to the image model.
 *
 * The three trailing blocks are appended in order of how badly getting them
 * wrong hurts: the style lock (drift), what not to clone (a licensing problem),
 * then craft negatives (a quality problem).
 *
 * @returns {{text:string, missing:string[], usedImage:boolean}}
 */
export function fill(recipe, { values = {}, input = "text", includeNegatives = true } = {}) {
  const lib = loadRecipes();
  const useImage = input === "image" && recipe.image;
  const rawSkeleton = useImage ? recipe.image.skeleton : recipe.text;
  const skeleton = rawSkeleton.replace(/\b[Ee]xclude\s*\.\s*/g, "");

  const resolved = { ...(recipe._defaultValues || {}) };
  const invalidValues = [];
  for (const [k, v] of Object.entries(values)) {
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      const valStr = String(v);
      resolved[k] = valStr;
      if (!recipe.slots.includes(k)) {
        invalidValues.push({ slot: k, value: valStr, reason: "unknown slot" });
      } else {
        const spec = lib.slots?.[k];
        if (spec?.options?.length && !spec.options.includes(valStr)) {
          invalidValues.push({ slot: k, value: valStr, reason: `not in offered options (${spec.options.join(", ")})` });
        }
      }
    }
  }
  const missing = [];
  let text = skeleton.replace(/\{(\w+)\}/g, (_, key) => {
    const v = resolved[key];
    if (v === undefined || v === "") {
      missing.push(key);
      return `{${key}}`;
    }
    return v;
  });

  // The style lock is a positive instruction — the invariants that must survive
  // every generation — so it is never gated. Turning the avoid-lists off must
  // not silently drop a caller's style fidelity guarantees.
  if (recipe.styleLock?.length) text += `\n\nSTYLE LOCK — ${recipe.styleLock.join("; ")}.`;
  if (includeNegatives) {
    // Re-stated next to the content, because a model loses the middle of a long
    // prompt — which is exactly the failure this field exists to prevent.
    if (recipe.doNotClone?.length) text += `\n\nDO NOT REPRODUCE — ${recipe.doNotClone.join("; ")}.`;
    if (recipe.negatives?.length) text += `\n\nAVOID — ${recipe.negatives.join("; ")}.`;
  }
  return {
    text,
    missing: [...new Set(missing)],
    usedImage: Boolean(useImage),
    invalidValues,
  };
}

/** A one-line gist, so an agent can judge an entry without the full text. */
export function gistOf(recipe, chars = 200) {
  const s = String(recipe.goal || recipe.when || "");
  if (s.length <= chars) return s;
  // Reserve room for the ellipsis, or the result overshoots the budget the
  // caller asked for. Only visible on long goals, which is why it survived
  // until a 500-char style summary showed up.
  const cut = s.slice(0, chars - 3);
  const space = cut.lastIndexOf(" ");
  return `${space > chars * 0.6 ? cut.slice(0, space) : cut}...`;
}

/** What an agent needs to decide whether to use an entry — no full bodies. */
export function publicRecipe(recipe, { full = false, values = {}, input = "text" } = {}) {
  const lib = loadRecipes();
  const slotOptions = {};
  for (const s of recipe.slots) {
    const spec = lib.slots?.[s];
    if (spec?.options?.length) slotOptions[s] = spec.options;
  }
  const out = {
    id: recipe.id,
    kind: recipe.kind,
    category: recipe.category,
    goal: recipe.goal,
    when: recipe.when,
    shape: recipe.shape,
    shapeMeans: lib.shapes[recipe.shape] || recipe.shape,
    slots: recipe.slots,
    defaults: recipe.defaults || {},
    slotOptions,
    // Whether this entry can take a reference image, and what it would do with
    // one. Stated even on previews: knowing the upgrade exists changes what the
    // agent asks the user for.
    acceptsImage: Boolean(recipe.image),
    imageAccepts: recipe.image?.accepts || null,
    imagePreserves: recipe.image?.preserve || null,
    negatives: recipe.negatives || [],
    // The invariants that must survive, and the source content that must not be
    // reproduced. Both are licence- and fidelity-relevant, so they are on the
    // preview rather than hidden behind full:true.
    styleLock: recipe.styleLock || [],
    doNotClone: recipe.doNotClone || [],
    // Attribution is a licence condition for vendored looks, so it travels with
    // every result, preview included.
    source: recipe.source || null,
  };

  const text = fill(recipe, { values, input });
  out.missing = text.missing;
  out.fillMe = text.missing;
  out.usedImage = text.usedImage;

  if (full) {
    out.prompt = text.text;
    out.example = recipe.example;
    if (text.invalidValues?.length) out.invalidValues = text.invalidValues;
  } else {
    out.gist = gistOf(recipe);
  }
  return out;
}
/** One line describing what a mixed set of rows actually is. */
function describeRows(rows, hasQuery) {
  const order = hasQuery ? " (best match first)" : "";
  const jobs = rows.filter((r) => r.kind === "job").length;
  const looks = rows.length - jobs;
  if (looks === 0) return jobs === 1 ? "1 recipe" : `${jobs} recipes${order}`;
  if (jobs === 0) return looks === 1 ? "1 look" : `${looks} looks${order}`;
  return `${rows.length} matches (${jobs} recipe${jobs === 1 ? "" : "s"}, ${looks} look${looks === 1 ? "" : "s"})`;
}

export function renderCategories(kind = null) {
  const lib = loadRecipes();
  const cats = lib.categories.filter((c) => !kind || c.kind === kind);
  const jobCats = cats.filter((c) => c.kind === "job");
  const lookCats = cats.filter((c) => c.kind === "look");
  const lines = [];

  if (jobCats.length) {
    const n = jobCats.reduce((a, c) => a + c.count, 0);
    lines.push(`RECIPES — a job to do. ${n} recipes across ${jobCats.length} categories. You fill the slots.`, "");
    for (const c of jobCats) {
      lines.push(`${c.id}  —  ${c.label}`);
      lines.push(`   ${c.intent}`);
      const names = c.recipes.map((rid) => lib.recipeById.get(rid)).map((r) => `${r.id}${r.image ? "*" : ""}`);
      lines.push(`   recipes: ${names.join(", ")}`);
      lines.push("");
    }
    lines.push("* = can also take a reference image you already have.");
    lines.push("");
  }

  if (lookCats.length) {
    const n = lookCats.reduce((a, c) => a + c.count, 0);
    lines.push(`LOOKS — a fixed visual system to borrow. ${n} looks across ${lookCats.length} categories. You supply the content.`, "");
    for (const c of lookCats) {
      lines.push(`${c.id}  —  ${c.label}  (${c.count})`);
      lines.push(`   ${c.intent}`);
      // 137 looks will not fit in a context window, so this shows a taste and a
      // count. The category id is the handle for narrowing.
      const sample = c.recipes.slice(0, 5);
      const rest = c.count - sample.length;
      lines.push(`   e.g. ${sample.join(", ")}${rest > 0 ? ` (+${rest} more)` : ""}`);
      lines.push("");
    }
    if (lib.styleSource) {
      lines.push(`Looks are vendored from ${lib.styleSource.repo} under ${lib.styleSource.license} (${lib.styleSource.copyright}).`);
      lines.push("");
    }
  }

  lines.push('Call again with category:"<id>" to narrow, kind:"job" or kind:"look" to pick a side, or query:"<what you want>" to search.');
  return lines.join("\n");
}

export function renderRecipe(recipe, { full = false, values = {}, input = "text", index = null } = {}) {
  const head = index === null ? "" : `${index + 1}. `;
  const tag = recipe.kind === "look" ? "look" : "recipe";
  // Preview mode is deliberately terse. The job here is to let an agent decide
  // "is this the right one?" in one glance — the slot defaults and the full
  // avoid-list belong in full mode, where the agent has already committed.
  if (!full) {
    const lines = [
      `${head}${recipe.id}  (${tag} · ${recipe.category} · ${recipe.shape}${recipe.image ? " · takes an image" : ""})`,
      `   ${recipe.goal}`,
      `   Use when: ${recipe.when}`,
    ];
    const missing = fill(recipe, { values, input }).missing;
    if (missing.length) lines.push(`   You supply: ${missing.map((m) => `{${m}}`).join(", ")}`);
    if (recipe.image) lines.push(`   With a photo: accepts ${recipe.image.accepts}`);
    if (recipe.source) lines.push(`   Credit: ${recipe.source.styleName} — ${recipe.source.repo} (${recipe.source.license})`);
    return lines.join("\n");
  }

  const lines = [
    `${head}${recipe.id}  (${tag} · ${recipe.category} · ${recipe.shape})`,
    `   ${recipe.goal}`,
    `   Use when: ${recipe.when}`,
  ];
  if (recipe.source) {
    lines.push(`   Credit: ${recipe.source.styleName} v${recipe.source.styleVersion} — ${recipe.source.repo} (${recipe.source.license}, ${recipe.source.copyright})`);
  }
  if (recipe.image) {
    lines.push(`   With an image: accepts ${recipe.image.accepts}; preserves ${recipe.image.preserve.join(", ")}.`);
  }
  // Show what each slot actually resolves to for this call: the caller's value
  // if given, else the default, else "{slot}" to match the missing report below.
  // Showing a bare "..." next to a slot the caller just filled is misleading.
  const short = (v) => (String(v).length > 44 ? `${String(v).slice(0, 43).trimEnd()}\u2026` : String(v));
  lines.push(
    `   Slots: ${recipe.slots
      .map((s) => {
        const v = values?.[s] ?? recipe.defaults?.[s];
        return `${s}=${v ? short(v) : `{${s}}`}`;
      })
      .join("  ")}`,
  );
  if (recipe.styleLock?.length) lines.push(`   Style lock: ${recipe.styleLock.join("; ")}`);
  if (recipe.doNotClone?.length) lines.push(`   Do not reproduce: ${recipe.doNotClone.join("; ")}`);
  if (recipe.negatives?.length) lines.push(`   Avoid: ${recipe.negatives.join("; ")}`);
  const f = fill(recipe, { values, input });
  lines.push("");
  lines.push(f.text);
  if (f.missing.length) {
    lines.push("");
    lines.push(`!! Still to fill: ${f.missing.map((m) => `{${m}}`).join(", ")}`);
  }
  if (f.invalidValues?.length) {
    lines.push("");
    lines.push(`!! Invalid slot values: ${f.invalidValues.map((iv) => `${iv.slot}="${iv.value}" (${iv.reason})`).join("; ")}`);
  }
  if (recipe.example) {
    lines.push("");
    lines.push(`Worked example (reference only — not part of prompt): ${recipe.example}`);
  }
  return lines.join("\n");
}

export function renderResult(result, { full = false, values = {}, input = null } = {}) {
  const effInput = input || result.input || "text";
  if (result.mode === "categories") return renderCategories(result.kind || null);
  if (!result.rows.length) {
    // `rows` can be empty while the query DID match — e.g. limit=0, or a
    // non-numeric --limit that parsed to NaN. Saying "nothing matched" there is
    // a lie the caller cannot detect, so branch on the match, not the page.
    const lines = result.matched
      ? [`Matched ${result.available}, but nothing was returned (limit ${result.limit}).`]
      : [`Nothing matched "${result.query}".`];
    if (result.category) lines.push(`(filtered to category "${result.category}")`);
    if (result.kind) lines.push(`(filtered to kind "${result.kind}")`);
    lines.push("");
    if (result.matched) lines.push("Raise limit (or omit it) to see the matches.");
    else {
      lines.push("Nothing matched, so nothing is returned — a wrong prompt is worse than none.");
      lines.push('Call again with mode:"categories" to see what exists, or try different words.');
    }
    return lines.join("\n");
  }
  const blocks = result.rows.map((r, i) => renderRecipe(r, { full, values, input: effInput, index: result.rows.length > 1 ? i : null }));
  const tail = full
    ? ""
    : `\n\nPreviews. Add full:true for the whole skeleton, or id:"<id>" for one entry.`;
  const more = result.available > result.rows.length ? `\n(${result.available} matched; showing ${result.rows.length}. Narrow with category, kind or shape.)` : "";
  return `${describeRows(result.rows, Boolean(result.query))}\n\n${blocks.join("\n\n")}${more}${tail}`;
}
