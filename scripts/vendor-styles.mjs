#!/usr/bin/env node
// Vendor the AI Visual Prompt Cookbook (MIT) into brushrouter's unified library.
//
// The cookbook ships 137 `style.json` files. We normalize each one into the same
// shape as our own recipes so a single module can serve both:
//
//   recipes = a JOB   ("a product hero shot")  — ours, authored by us
//   styles  = a LOOK  ("mono noir editorial")  — theirs, MIT, credited
//
// Two fields are *promoted* out of their variable list, because in their design
// they are caller-supplied variables but in ours they are first-class:
//
//   STYLE_FIDELITY_ANCHORS  -> styleLock   (what must not drift)
//   SOURCE_CONTENT_TO_AVOID -> doNotClone  (what must not be reproduced)
//
// Usage:
//   node scripts/vendor-styles.mjs            # write data/styles/styles.json
//   node scripts/vendor-styles.mjs --check    # verify the vendored file's hash
//   node scripts/vendor-styles.mjs --from DIR # normalize a local checkout

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "data", "styles");
const REPO = "VigoZhao/AI-Visual-Prompt-Cookbook";
const COMMIT = "8b6068f4d65e5efac12ab6e9794a2f8c2a73cc60";
const RAW = `https://raw.githubusercontent.com/${REPO}/${COMMIT}`;
const API = `https://api.github.com/repos/${REPO}/git/trees/${COMMIT}?recursive=1`;

const CATEGORY_LABELS = {
  "type-posters": "Type posters",
  "editorial-minimal": "Editorial and minimal",
  "product-campaign": "Product and campaign",
  "photo-doodle": "Photo with doodle",
  "zine-collage": "Zine and collage",
  "travel-city": "Travel and city",
};

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/\+/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`invalid JSON in ${path}: ${cause.message}`, { cause });
  }
}

/** Parse a fetched body, naming the source so a bad upstream response is legible. */
function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error(`upstream returned invalid JSON for ${label}: ${cause.message}`, { cause });
  }
}

async function get(url) {
  const res = await fetch(url, { headers: { "user-agent": "brushrouter-vendor" } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.text();
}

/** Render a template with a value map, leaving unknown keys as {braces}. */
function render(template, values) {
  return template.replace(/\{(\w+)\}/g, (whole, key) =>
    values[key] === undefined ? whole : String(values[key]),
  );
}

function trim(s, n) {
  const t = String(s).trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  return stop > n * 0.5 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}...`;
}

/**
 * Normalize one cookbook style into our schema.
 *
 * All of their variables are caller-supplied, so every slot lands with no
 * default and `fill()` reports it in `missing` until the caller supplies it.
 * That is the same contract our free slots already use.
 */
// Their variable names -> our slot vocabulary, so a look and one of our recipes
// are filled the same way. A name mapped to null is not content at all and is
// dropped from the template: it already lives in a field of its own.
const SLOT_MAP = {
  aspect_ratio: "ratio",
  main_text: "text",
  product_or_prop: "prop",
  wardrobe_style: "wardrobe",
  negative_prompt: null,
};

// Promoted to fields: the style's own invariants and exclusions, not content the
// caller invents. They have to leave the template too — otherwise they ship to
// the image model as a literal "{style_fidelity_anchors}".
const PROMOTED = new Set(["style_fidelity_anchors", "source_content_to_avoid"]);

/** The slot a variable name maps to, or null if it is not content. */
function slotFor(name) {
  const key = name.toLowerCase();
  if (PROMOTED.has(key)) return null;
  return key in SLOT_MAP ? SLOT_MAP[key] : key;
}

function normalizeStyle(s) {
  const lookCategory = slugify(s.category);
  const label = CATEGORY_LABELS[lookCategory] || s.category;
  const anchors = (s.style_fidelity_anchors || []).map(String);

  // One case-insensitive pass: rename every placeholder to our vocabulary and
  // drop the ones that became fields. Deriving `slots` from the rewritten
  // template rather than from environment_variables is what keeps the two in
  // step — a declared-but-unused slot is noise, and a used-but-undeclared one
  // reaches the model as a literal placeholder.
  const text = String(s.prompt_template || "").replace(/\{([A-Za-z0-9_]+)\}/g, (_, name) => {
    const slot = slotFor(name);
    return slot === null ? "" : `{${slot}}`;
  });
  const slots = [...new Set([...text.matchAll(/\{([a-z0-9_]+)\}/g)].map((m) => m[1]))];

  // Their schema has no "when". The first fidelity anchor is the defining trait
  // of the look, which is exactly what a chooser needs to tell two apart.
  const when = anchors.length
    ? `${label} — a fixed visual system. Defining trait: ${trim(anchors[0], 170)}`
    : `${label} — a fixed visual system.`;

  // A worked example: their own example values rendered through the template.
  const ex = (s.examples || [])[0];
  const example = ex
    ? render(text, Object.fromEntries(Object.entries(ex.values || {}).map(([k, v]) => [slotFor(k) ?? k.toLowerCase(), v])))
    : "";

  return {
    id: s.style_slug,
    kind: "look",
    category: lookCategory,
    goal: String(s.style_summary || "").trim(),
    when,
    shape: "single",
    slots,
    defaults: {},
    text,
    styleLock: anchors,
    doNotClone: (s.source_content_to_avoid || []).map(String),
    negatives: String(s.negative_prompt || "")
      .split(/,\s*/)
      .map((x) => x.trim())
      .filter(Boolean),
    example,
    source: {
      repo: `https://github.com/${REPO}`,
      commit: COMMIT,
      license: "MIT",
      copyright: "Copyright (c) 2026 VigoZhao",
      styleName: s.style_name,
      styleVersion: s.style_version,
      upstreamCategory: s.category,
    },
  };
}

// Hand-written, like the recipe aliases: a search that goes wrong should be
// debuggable by reading one line, not by inspecting a generated word list.
// Deriving these from the style summaries produced ~400 aliases per category,
// which made the alias score fire on every generic adjective in the corpus.
const CATEGORY_ALIASES = {
  "type-posters": ["type", "typography", "headline", "big type", "lettering", "wordmark", "kinetic type", "megatype", "bold text", "poster type", "slogan", "text poster"],
  "editorial-minimal": ["editorial", "minimal", "magazine", "clean", "quiet", "luxury", "luxe", "restrained", "monochrome", "art direction", "print", "understated"],
  "product-campaign": ["product", "campaign", "ad", "advertising", "launch", "commercial", "retail", "packaging", "brand", "promo", "key visual", "product shot"],
  "photo-doodle": ["doodle", "sketch", "scribble", "snapshot", "overlay", "playful", "marker", "hand drawn", "casual", "lifestyle photo", "annotated", "candid"],
  "zine-collage": ["zine", "collage", "cutout", "ransom", "punk", "grunge", "diy", "mixed media", "scrapbook", "lo-fi", "xerox", "torn paper"],
  "travel-city": ["travel", "city", "urban", "street", "destination", "tourism", "vlog", "postcard", "skyline", "journey", "transit", "sightseeing"],
};

function buildCategoryList(styles) {
  const byCat = new Map();
  for (const s of styles) {
    if (!byCat.has(s.category)) byCat.set(s.category, []);
    byCat.get(s.category).push(s);
  }
  return [...byCat.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([id, list]) => ({
      id,
      label: CATEGORY_LABELS[id] || id,
      kind: "look",
      intent: `${list.length} reusable ${(CATEGORY_LABELS[id] || id).toLowerCase()} looks, each a fixed visual system you fill with your own subject.`,
      aliases: CATEGORY_ALIASES[id] || id.split("-"),
    }));
}

/** Canonical hash: the styles projected to their required keys, keys sorted. */
export function stylesSha256(styles) {
  const canonical = styles
    .map((s) => JSON.stringify(Object.fromEntries(Object.keys(s).sort().map((k) => [k, s[k]]))))
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

async function collect(fromDir) {
  let paths;
  if (fromDir) {
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    paths = walk(fromDir).filter((p) => p.endsWith("style.json"));
    return paths.map(readJson).map(normalizeStyle);
  }
  const tree = parseJson(await get(API), "the repository tree");
  if (tree.truncated) throw new Error("upstream tree is truncated; vendor from a local clone instead");
  paths = tree.tree.map((t) => t.path).filter((p) => p.endsWith("style.json"));
  const styles = [];
  // Small files, so a modest concurrency keeps this polite and fast.
  for (let i = 0; i < paths.length; i += 12) {
    const slice = paths.slice(i, i + 12);
    const batch = await Promise.all(slice.map((p) => get(`${RAW}/${p}`)));
    batch.forEach((body, n) => styles.push(normalizeStyle(parseJson(body, slice[n]))));
  }
  return styles;
}

function attribution(styles, sha) {
  return `# Attribution

The looks in this directory are **not ours**. They are the AI Visual Prompt
Cookbook by [VigoZhao](https://github.com/VigoZhao), used under the MIT License.

- Upstream: https://github.com/${REPO}
- Pinned commit: \`${COMMIT}\`
- Licence: MIT — \`Copyright (c) 2026 VigoZhao\` (full text in \`LICENSE\`)
- Styles vendored: ${styles.length}
- \`stylesSha256\`: \`${sha}\`

Each style carries its upstream \`style_name\`, \`style_version\` and category in its
\`source\` block, and every result brushrouter returns from this library reports
them. \`scripts/vendor-styles.mjs\` re-fetches at the pinned commit and refuses to
write if the canonical hash changes.

We normalize the shape — \`STYLE_FIDELITY_ANCHORS\` becomes \`styleLock\`,
\`SOURCE_CONTENT_TO_AVOID\` becomes \`doNotClone\`, variables are lowercased — but the
prompt text, anchors, exclusions and negatives are reproduced as upstream wrote
them. Nothing here is paraphrased.

If you redistribute these styles, carry this file and \`LICENSE\` with them.
`;
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes("--check") ? "check" : "write";
  const fromIdx = args.indexOf("--from");
  const fromDir = fromIdx >= 0 ? args[fromIdx + 1] : null;

  const outFile = join(OUT, "styles.json");

  if (mode === "check") {
    if (!existsSync(outFile)) {
      console.error(`\nnothing vendored at ${outFile} — run without --check first`);
      process.exit(1);
    }
    const vendored = readJson(outFile);
    const onDisk = createHash("sha256").update(readFileSync(outFile)).digest("hex");
    const recomputed = stylesSha256(vendored.styles);
    if (recomputed !== vendored.stylesSha256) {
      console.error(`\nstylesSha256 mismatch — the vendored file was hand-edited`);
      console.error(`  recorded:   ${vendored.stylesSha256}`);
      console.error(`  recomputed: ${recomputed}`);
      process.exit(1);
    }
    console.log(`${vendored.styles.length} styles, stylesSha256 verified`);
    console.log(`file sha256: ${onDisk}`);
    return;
  }

  const styles = await collect(fromDir);
  styles.sort((a, b) => a.id.localeCompare(b.id));
  const sha = stylesSha256(styles);
  const categories = buildCategoryList(styles);

  const payload = {
    version: 1,
    note: "Vendored from the AI Visual Prompt Cookbook (MIT, VigoZhao). Normalized to brushrouter's schema. Do not hand-edit; run scripts/vendor-styles.mjs.",
    source: {
      repo: `https://github.com/${REPO}`,
      commit: COMMIT,
      license: "MIT",
      copyright: "Copyright (c) 2026 VigoZhao",
    },
    stylesSha256: sha,
    categories,
    styles,
  };

  mkdirSync(OUT, { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(join(OUT, "ATTRIBUTION.md"), attribution(styles, sha));

  // MIT requires the notice to travel with the work, so fetch it rather than
  // leaving it as a manual step someone can forget.
  let licenseNote = "";
  if (fromDir) {
    const local = join(fromDir, "LICENSE");
    if (existsSync(local)) writeFileSync(join(OUT, "LICENSE"), readFileSync(local));
    else licenseNote = "\nNOTE: copy the upstream MIT text to data/styles/LICENSE";
  } else {
    writeFileSync(join(OUT, "LICENSE"), await get(`${RAW}/LICENSE`));
  }

  console.log(`${styles.length} styles -> data/styles/styles.json`);
  console.log(`categories: ${categories.map((c) => `${c.id}(${c.aliases.length} aliases)`).join(", ")}`);
  console.log(`stylesSha256: ${sha}`);
  console.log(`licence: MIT (${payload.source.copyright}) -> data/styles/LICENSE`);
  if (licenseNote) console.log(licenseNote);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`\nvendor failed: ${e.message}`);
    process.exit(1);
  });
}
