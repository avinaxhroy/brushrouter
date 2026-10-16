#!/usr/bin/env node
// Study the published prompt corpus that our recipe design was derived from.
//
// The corpus in data/prompts/ is a DEV FIXTURE. It is not shipped in the npm
// tarball and nothing at runtime reads it. It is here for two reasons:
//
//   1. Provenance. The recipes in data/recipes/ are written by us, but their
//      *shape* came from reading 150 published prompts. This script is how that
//      claim is checked rather than asserted, and it re-verifies the pinned
//      corpus hash so a silently-moved upstream fails loudly.
//   2. Coverage. It reports which craft dimensions real prompts use per
//      category, so we can see whether our recipes cover them.
//
// Usage:
//   node scripts/analyze-corpus.mjs            # analyse the vendored copy
//   node scripts/analyze-corpus.mjs --check    # re-fetch and verify the pin
//   node scripts/analyze-corpus.mjs --fetch    # re-vendor from the pinned commit

import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "data", "prompts");
const RECIPES = join(HERE, "..", "data", "recipes");

const REPO = "youart-open-source/awesome-gpt-image-2-5-prompts";
// Pinned. A branch would make the hash check meaningless the moment upstream moves.
const COMMIT = "f7f6276ff3d82cea2d837b89cf2dd097dd9766ac";
const RAW = `https://raw.githubusercontent.com/${REPO}/${COMMIT}`;

const FILES = [
  ["data/prompts.json", "prompts.json"],
  ["data/prompts.schema.json", "prompts.schema.json"],
  ["ATTRIBUTION.md", "ATTRIBUTION.md"],
  ["LICENSES/CC0-1.0.txt", "LICENSES/CC0-1.0.txt"],
  ["LICENSES/CC-BY-4.0.txt", "LICENSES/CC-BY-4.0.txt"],
  ["LICENSES/LicenseRef-Prompt-Authors-No-Grant.txt", "LICENSES/LicenseRef-Prompt-Authors-No-Grant.txt"],
  ["LICENSES/LicenseRef-YouArt-Curation-No-Grant.txt", "LICENSES/LicenseRef-YouArt-Curation-No-Grant.txt"],
  ["provenance/README.md", "provenance/README.md"],
  ["provenance/evolink-e2a269ad-LICENSE.txt", "provenance/evolink-e2a269ad-LICENSE.txt"],
  ["provenance/youmind-41572075-LICENSE.txt", "provenance/youmind-41572075-LICENSE.txt"],
];

// The algorithm the upstream documents in _meta.corpusSha256Algorithm: each row
// projected onto the schema's `required` key list, keys sorted, rows sorted,
// joined with "\n", hashed as UTF-8. Key order in the file and row order in the
// array are deliberately irrelevant to the result.
export function corpusSha256(corpus, requiredKeys) {
  const rows = corpus.prompts.map((row) => {
    const picked = {};
    for (const k of [...requiredKeys].sort()) picked[k] = row[k];
    return JSON.stringify(picked);
  });
  rows.sort();
  return createHash("sha256").update(rows.join("\n"), "utf8").digest("hex");
}

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

// A malformed upstream response should say so, rather than surfacing a bare
// SyntaxError from 60 lines away.
async function getJson(url) {
  const text = (await get(url)).toString("utf8");
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${url} is not valid JSON: ${e.message}`);
  }
}

function readJson(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(`cannot read ${path}: ${cause.message}`, { cause });
  }
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new Error(`invalid JSON in ${path}: ${cause.message}`, { cause });
  }
}

// ---------------------------------------------------------------------------
// The analysis. Each block answers one question that shaped the recipe schema.
// ---------------------------------------------------------------------------

function analyze(corpus) {
  const rows = corpus.prompts;

  // 1. Is the reusable asset the individual prompt, or the shared structure?
  //    If most prompts are assembled from the same named sections, copying texts
  //    is the wrong unit of reuse. Two header conventions appear in the corpus:
  //    CJK-bracket "【NAME: description】" and plain "Label: description".
  const CJK_HEADER = /^【([^:：】]{2,60})/;
  const LABEL_HEADER = /^([A-Z][A-Za-z0-9 /&'()\u2019-]{2,45})\s*[:：]/;
  const headers = rows.map((r) => {
    const found = new Set();
    for (const line of r.prompt.split("\n")) {
      const t = line.trim();
      const m = t.match(CJK_HEADER) || t.match(LABEL_HEADER);
      if (m) found.add(m[1].trim());
    }
    return found;
  });
  const vocab = new Map();
  for (const set of headers) for (const h of set) vocab.set(h, (vocab.get(h) || 0) + 1);
  const withHeaders = headers.filter((s) => s.size > 0).length;
  const shared = [...vocab.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);

  // 2. The gap our design exists to close: how many prompts need a reference
  //    image, and how many say what to do when there isn't one?
  const IMAGE_DEP = /(uploaded|supplied|provided|attached|given)\s+(\w+\s+){0,2}(image|photo|reference|picture)|reference\s+(image|photo|picture)|\{\{[A-Z_]+\}\}|\{[A-Z][A-Z_]+\}/i;
  const NO_IMAGE_GUIDE = /without (a|an|the) (reference|source|uploaded)|if (you )?(don't|do not) have|no reference image|text[- ]only/i;
  const needsImage = rows.filter((r) => IMAGE_DEP.test(r.prompt));
  const handlesNoImage = rows.filter((r) => NO_IMAGE_GUIDE.test(r.prompt));

  // 3. Placeholder syntax actually in use — a prompt library has to understand
  //    the conventions its users already write.
  const syntax = {
    "curly {name}": (r) => /\{[a-z][a-z0-9_]*\}/i.test(r.prompt),
    "[BRACKET]": (r) => /\[[A-Z][A-Z0-9 _-]{1,30}\]/.test(r.prompt),
    "{argument name=...}": (r) => /\{argument\s+name=/i.test(r.prompt),
    "<angle>": (r) => /<[a-z][a-z0-9_ -]{1,30}>/i.test(r.prompt),
  };

  // 4. Craft dimensions per category. This is what tells us whether our recipes
  //    cover the things practitioners actually specify.
  const dims = {
    "exact text": /\b(text|lettering|wordmark|spell|typograph|logo)\b/i,
    negatives: /\b(negative prompt|avoid|do not|don't|no text|no watermark)\b/i,
    lighting: /\b(light|lighting|shadow|lit|illuminat)\b/i,
    "aspect ratio": /\b(\d+:\d+|aspect ratio|portrait orientation|landscape orientation)\b/i,
    material: /\b(material|texture|fabric|metal|glass|wood|ceramic|surface)\b/i,
    camera: /\b(camera|lens|focal|depth of field|bokeh|aperture|shutter)\b/i,
    "colour palette": /\b(palette|colou?r scheme|hue|tone|grading)\b/i,
  };
  const perCategory = new Map();
  for (const r of rows) {
    const c = perCategory.get(r.category) || { n: 0, hits: {} };
    c.n++;
    for (const [name, re] of Object.entries(dims)) if (re.test(r.prompt)) c.hits[name] = (c.hits[name] || 0) + 1;
    perCategory.set(r.category, c);
  }

  // 5. Output shape: is this prompt asking for one image, a grid of panels, a
  //    reference sheet, or a designed page? Drives the `shape` field.
  const shapes = {
    grid: /\b(\d+\s*[x×]\s*\d+\s*(grid|panels?|layout)|grid of|panel(s)? (layout|grid)|collage|multiple views|split into \w+ panels)\b/i,
    sheet: /\b(character sheet|model sheet|turnaround|reference sheet|expression sheet|pose reference sheet)\b/i,
    document: /\b(infographic|flyer|menu|poster layout|page layout|case study|spec sheet|brand book)\b/i,
  };

  // 6. Does our slot vocabulary cover the header terms the corpus actually
  //    uses? Header names are SLOT names ("Lighting", "Composition"), so they
  //    are compared against our slot keys and labels as well as our option
  //    values. Word-level matching, not substring: "Aspect ratio" must not be
  //    considered covered by the option "isometric illustration".
  const slotsFile = readJson(join(RECIPES, "slots.json"));
  const ourWords = new Set();
  for (const [key, spec] of Object.entries(slotsFile.slots)) {
    for (const w of `${key} ${spec.label || ""}`.toLowerCase().split(/[^a-z]+/)) if (w.length > 2) ourWords.add(w);
    for (const o of spec.options || []) for (const w of o.toLowerCase().split(/[^a-z]+/)) if (w.length > 2) ourWords.add(w);
  }
  const uncovered = shared.filter(([h]) => {
    const words = h.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);
    // Non-Latin headers cannot be word-matched; flag them for a human read.
    if (!words.length) return true;
    return !words.some((w) => ourWords.has(w) || [...ourWords].some((o) => o.startsWith(w) || w.startsWith(o)));
  });

  return { rows, withHeaders, shared, needsImage, handlesNoImage, syntax, perCategory, shapes, uncovered, slotsFile, dimNames: Object.keys(dims) };
}

function report(a) {
  const n = a.rows.length;
  console.log(`corpus: ${n} prompts\n`);

  console.log("1. Is the reusable asset the prompt text, or the structure?");
  console.log(`   ${a.withHeaders}/${n} prompts are assembled from named section headers`);
  console.log(`   (\u3010NAME: description\u3011 or "Label: description"). ${a.shared.length} header terms recur 3+ times:`);
  for (const [h, c] of a.shared.slice(0, 12)) console.log(`     ${String(c).padStart(3)}x  ${h}`);
  console.log(`   -> the shared skeleton is the reusable asset, so we ship recipes, not prompt texts.\n`);

  console.log("2. The gap that motivated the design");
  console.log(`   ${a.needsImage.length}/${n} prompts expect a reference image.`);
  console.log(`   ${a.handlesNoImage.length}/${n} prompts say what to do when the user has no image.`);
  console.log(`   -> an agent with no photo was blocked or guessing. Our recipes make the text path mandatory`);
  console.log(`      and the image path an optional upgrade.\n`);

  console.log("3. Placeholder syntax in use");
  for (const [name, test] of Object.entries(a.syntax)) {
    console.log(`   ${String(a.rows.filter(test).length).padStart(3)}x  ${name}`);
  }
  console.log("");

  console.log("4. Output shape implied");
  for (const [name, re] of Object.entries(a.shapes)) {
    console.log(`   ${String(a.rows.filter((r) => re.test(r.prompt)).length).padStart(3)}x  ${name}`);
  }
  console.log("");

  console.log("5. Craft dimensions per category (share of prompts that specify each)");
  const head = ["category", "n", ...a.dimNames];
  console.log(`   ${head.map((h) => h.padEnd(14)).join("")}`);
  for (const [cat, c] of [...a.perCategory.entries()].sort()) {
    const cells = a.dimNames.map((d) => `${Math.round(((c.hits[d] || 0) / c.n) * 100)}%`);
    console.log(`   ${[cat, String(c.n), ...cells].map((v) => String(v).padEnd(14)).join("")}`);
  }
  console.log("");

  console.log("6. Header vocabulary with no matching slot in our dictionary");
  if (!a.uncovered.length) console.log("   (none — every recurring header term maps to one of our slots)");
  else for (const [h, c] of a.uncovered) console.log(`   ${String(c).padStart(3)}x  ${h}`);
  console.log("");
  console.log("   Most of these are not slot vocabulary and are not gaps:");
  console.log("     Goal / Constraints / Negative prompt -> the recipe's own goal and negatives fields");
  console.log("     Canvas                              -> ratio + background + the recipe's shape");
  console.log("     Characters / Outfit / IMPORTANT     -> the free `subject` slot, by design");
  console.log("   A genuine gap this check did find: \"Color palette\" had no route to the");
  console.log("   grading slot, so that slot's label now reads \"Colour grading and palette\".");
  console.log("");
}

async function main() {
  const argv = process.argv;
  const mode = argv.includes("--check") ? "check" : argv.includes("--fetch") ? "fetch" : "analyze";

  if (mode === "analyze") {
    const corpus = readJson(join(OUT, "prompts.json"));
    report(analyze(corpus));
    return;
  }

  console.log(`${mode === "fetch" ? "fetching" : "checking"} ${REPO}@${COMMIT.slice(0, 8)}\n`);
  const schema = await getJson(`${RAW}/data/prompts.schema.json`);
  const required = schema.properties.prompts.items.required;
  const body = await get(`${RAW}/data/prompts.json`);
  let corpus;
  try {
    corpus = JSON.parse(body.toString("utf8"));
  } catch (e) {
    throw new Error(`upstream prompts.json is not valid JSON: ${e.message}`);
  }

  const meta = corpus._meta;
  const expected = meta.corpusSha256;
  const actual = corpusSha256(corpus, required);
  if (actual !== expected) {
    console.error(`hash mismatch — refusing to proceed`);
    console.error(`  upstream says: ${expected}`);
    console.error(`  we computed:   ${actual}`);
    console.error(`  The upstream moved or the schema's key list changed. Read the diff before bumping COMMIT.`);
    process.exit(1);
  }
  console.log(`✓ corpusSha256 verified (${actual.slice(0, 16)}...)`);
  console.log(`  ${meta.rowCount} prompts · ${meta.categoryCount} categories · ${meta.authorCount} authors · dated ${meta.corpusDate}`);

  if (mode === "check") {
    if (!existsSync(join(OUT, "prompts.json"))) {
      console.error(`\nvendored copy missing at ${OUT}/prompts.json — run with --fetch`);
      process.exit(1);
    }
    const onDisk = createHash("sha256").update(readFileSync(join(OUT, "prompts.json"))).digest("hex");
    const fetched = createHash("sha256").update(body).digest("hex");
    if (onDisk !== fetched) {
      console.error(`\nvendored copy differs from upstream@${COMMIT.slice(0, 8)} — re-run with --fetch`);
      process.exit(1);
    }
    console.log("✓ vendored copy matches upstream byte-for-byte");
    return;
  }

  mkdirSync(join(OUT, "LICENSES"), { recursive: true });
  mkdirSync(join(OUT, "provenance"), { recursive: true });
  for (const [src, dest] of FILES) {
    const buf = dest === "prompts.json" ? body : await get(`${RAW}/${src}`);
    writeFileSync(join(OUT, dest), buf);
    console.log(`  wrote data/prompts/${dest} (${(buf.length / 1024).toFixed(0)} KB)`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
