// Tests for the prompt library (src/library.js) and the data it serves: our own
// recipes (kind "job") and the vendored styles (kind "look").
//
// The headline guarantee under test is the one the design exists for: an agent
// holding no reference image is never blocked. Every recipe must produce a
// usable prompt from text alone; `image` is an optional upgrade, never a
// requirement.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import {
  loadRecipes,
  resetRecipesCache,
  findRecipes,
  listCategories,
  getRecipe,
  publicRecipe,
  fill,
  gistOf,
  renderResult,
  renderCategories,
  categoryIds,
  recipeIds,
  RECIPES_DIR,
  STYLES_FILE,
} from "../src/library.js";
import { validateRecipes } from "../scripts/check-recipes.mjs";

const lib = loadRecipes();

// The library holds two kinds. Our own recipes ("job") carry the schema we
// author and the no-image guarantee; the vendored styles ("look") are a separate
// kind with their own invariants. The job tests below are *scoped* rather than
// loosened, because a guarantee that holds for 27 of 164 entries is not a
// guarantee — and one that claims to hold for all 164 would be a lie.
const jobs = lib.recipes.filter((r) => r.kind === "job");
const looks = lib.recipes.filter((r) => r.kind === "look");
const jobCats = lib.categories.filter((c) => c.kind === "job");
const lookCats = lib.categories.filter((c) => c.kind === "look");

// ---------------------------------------------------------------------------
// The data is internally consistent
// ---------------------------------------------------------------------------

test("every recipe file satisfies the schema invariants", () => {
  const { ok, problems, stats } = validateRecipes();
  assert.deepEqual(problems, [], `recipe problems:\n  ${problems.join("\n  ")}`);
  assert.ok(ok);
  assert.equal(stats.categories, 9, "expected 9 categories");
  assert.equal(stats.recipes, 27, "expected 3 recipes per category");
});

test("the library loads both kinds with a stable order", () => {
  assert.equal(jobCats.length, 9);
  assert.equal(jobs.length, 27);
  assert.equal(lookCats.length, 6);
  assert.equal(looks.length, 137);
  assert.deepEqual(categoryIds("job"), [
    "ad-creative",
    "character-design",
    "ecommerce-product",
    "illustration",
    "infographic",
    "portrait",
    "poster",
    "typography-text",
    "ui-mockup",
  ]);
  assert.equal(new Set(categoryIds()).size, 15, "job and look categories must be disjoint");
  assert.ok(lib.recipes.every((r) => r.kind === "job" || r.kind === "look"), "every entry declares a kind");
  // Ids must be unique, or id lookup is ambiguous across kinds.
  assert.equal(new Set(recipeIds()).size, recipeIds().length);
});

test("every job category has at least three recipes and a searchable alias list", () => {
  // listCategories() enriches each entry with the shapes it actually offers;
  // the raw lib.categories entries do not carry that.
  for (const c of listCategories({ kind: "job" })) {
    assert.ok(c.count >= 3, `${c.id} has only ${c.count} recipes`);
    assert.ok(c.intent && c.intent.length > 20, `${c.id} has no useful intent`);
    assert.ok(lib.categoryById.get(c.id).aliases.length >= 5, `${c.id} has too few aliases to be searchable`);
    assert.ok(c.shapes.length >= 1 && c.shapes.every((s) => s.means), `${c.id} has an unknown shape`);
  }
});

// ---------------------------------------------------------------------------
// THE GUARANTEE: no reference image is never a blocker
// ---------------------------------------------------------------------------

test("every recipe is runnable from text alone, with no image", () => {
  for (const r of jobs) {
    assert.ok(typeof r.text === "string" && r.text.length > 200, `${r.id} has no usable text skeleton`);
    const f = fill(r, { input: "text" });
    assert.equal(f.usedImage, false, `${r.id} used the image path when input was text`);
    assert.ok(f.text.length > 200, `${r.id} produced no prompt from text`);
    // Only the two free slots may remain; an unfilled design slot would mean a
    // literal "{ratio}" reaching the image model.
    const leftover = f.missing.filter((m) => !lib.freeSlots.includes(m));
    assert.deepEqual(leftover, [], `${r.id} left design slots unfilled: ${leftover.join(", ")}`);
  }
});

test("supplying the free slots finishes every recipe with nothing left to fill", () => {
  for (const r of jobs) {
    const values = { subject: "a test subject", text: "TEST" };
    const f = fill(r, { values });
    assert.deepEqual(f.missing, [], `${r.id} still wants ${f.missing.join(", ")}`);
    assert.ok(!/\{\w+\}/.test(f.text), `${r.id} shipped a literal placeholder: ${f.text.match(/\{\w+\}/)}`);
  }
});

test("every declared default is one of the slot's offered options", () => {
  for (const r of jobs) {
    for (const [slot, value] of Object.entries(r.defaults || {})) {
      const spec = lib.slots[slot];
      assert.ok(spec, `${r.id} defaults unknown slot ${slot}`);
      assert.ok(spec.options.includes(value), `${r.id} default ${slot}="${value}" is not an offered option`);
    }
  }
});

test("a recipe that takes an image says what it accepts and what to preserve", () => {
  const withImage = jobs.filter((r) => r.image);
  assert.equal(withImage.length, 19, "expected 19 image-capable recipes");
  for (const r of withImage) {
    assert.ok(r.image.accepts, `${r.id} does not say what the image should be`);
    assert.ok(r.image.preserve.length >= 3, `${r.id} does not say what must survive`);
    assert.ok(r.image.skeleton.length > 150, `${r.id} image path is too thin to use`);
    const f = fill(r, { input: "image" });
    assert.equal(f.usedImage, true, `${r.id} did not switch to the image path`);
  }
});

test("every job category offers at least one recipe that can use a reference image", () => {
  for (const c of jobCats) {
    const n = jobs.filter((r) => r.category === c.id && r.image).length;
    assert.ok(n >= 1, `${c.id} has no image-capable recipe`);
  }
  // Look categories are text-driven on purpose: a style takes content slots, not
  // a reference photo, so they are not required to offer an image path.
  assert.ok(looks.every((r) => !r.image), "a vendored look should not claim an image path");
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

test("a specific query lands on the right recipe", () => {
  const cases = [
    ["product hero shot on marble", "ecommerce-product"],
    ["character turnaround sheet", "character-design"],
    ["logo for my coffee brand", "typography-text"],
    ["explain how a gearbox works", "infographic"],
    ["mobile app dashboard screen", "ui-mockup"],
    ["children's book illustration", "illustration"],
    ["studio headshot", "portrait"],
    ["concert poster", "poster"],
    ["instagram ad for a sneaker", "ad-creative"],
  ];
  for (const [query, expected] of cases) {
    const top = findRecipes({ query, limit: 1 }).rows[0];
    assert.ok(top, `"${query}" matched nothing`);
    assert.equal(top.category, expected, `"${query}" landed on ${top.category} (${top.id})`);
  }
});

test("aliases bridge words that appear nowhere in the recipe text", () => {
  // "dashboard" and "wireframe" are not in any ui-mockup recipe's own words, so
  // only the alias map can connect them.
  for (const q of ["dashboard", "wireframe", "landing page"]) {
    assert.equal(findRecipes({ query: q, limit: 1 }).rows[0]?.category, "ui-mockup", `"${q}" missed ui-mockup`);
  }
  assert.equal(findRecipes({ query: "mascot", limit: 1 }).rows[0]?.category, "character-design");
  assert.equal(findRecipes({ query: "watercolour", limit: 1 }).rows[0]?.category, "illustration");
});

test("slot defaults are searchable, so a style request finds recipes that use it", () => {
  // "analogue film photograph" is a render default on exactly one recipe, so
  // only the option-scoring path can find it.
  const top = findRecipes({ query: "analogue film photograph", limit: 1 }).rows[0];
  assert.ok(top, "analogue film photograph matched nothing");
  assert.equal(top.id, "editorial-portrait");
  assert.ok(Object.values(top.defaults).includes("analogue film photograph"));
});

test("an unmatched query reports nothing available", () => {
  const r = findRecipes({ query: "qqzzxx flibbertigibbet wobbleflux" });
  assert.equal(r.matched, false);
  assert.deepEqual(r.rows, []);
  assert.equal(r.total, 0);
  assert.equal(r.available, 0);
  const text = renderResult(r);
  assert.match(text, /Nothing matched/);
  assert.match(text, /categories/, "the empty result should point at the category map");
});

test("an empty query explores the library instead of returning nothing", () => {
  const r = findRecipes({});
  assert.equal(r.matched, true);
  assert.equal(r.rows.length, 4);
  assert.ok(r.rows.every((x) => x.id));
});

test("mode \"one\" returns exactly one recipe regardless of limit", () => {
  assert.equal(findRecipes({ mode: "one" }).rows.length, 1);
  assert.equal(findRecipes({ query: "poster", mode: "one", limit: 9 }).rows.length, 1);
});

test("mode \"categories\" returns the map, not recipes", () => {
  const r = findRecipes({ mode: "categories" });
  assert.equal(r.mode, "categories");
  assert.deepEqual(r.rows, []);
  assert.equal(r.total, lib.categories.length);
  assert.equal(findRecipes({ mode: "categories", kind: "job" }).total, 9, "the map should narrow with kind");
});

test("limit is respected, clamped, and reports how many actually matched", () => {
  assert.equal(findRecipes({ limit: 2 }).rows.length, 2);
  assert.equal(findRecipes({ limit: 0 }).rows.length, 1, "limit 0 should still return one row");
  // The cap protects the caller's context; `available` still tells the truth.
  const big = findRecipes({ limit: 100 });
  assert.equal(big.rows.length, 10, "limit is capped at 10");
  assert.equal(big.available, lib.recipes.length, "available should report the uncapped match count");
  const small = findRecipes({ category: "infographic", limit: 10 });
  assert.equal(small.rows.length, 3);
  assert.equal(small.available, 3);
});

test("category and shape filters are strict", () => {
  const infographic = findRecipes({ category: "infographic", limit: 10 }).rows;
  assert.equal(infographic.length, 3);
  assert.ok(infographic.every((r) => r.category === "infographic"));

  const sheets = findRecipes({ shape: "sheet", limit: 10 }).rows;
  assert.ok(sheets.length >= 1);
  assert.ok(sheets.every((r) => r.shape === "sheet"));

  assert.throws(() => findRecipes({ category: "nope" }), /unknown category/);
  assert.throws(() => findRecipes({ shape: "hexagon" }), /unknown shape/);
});

test("input:\"image\" narrows to image-capable recipes without emptying any category", () => {
  // Compare within a category that mixes both kinds, so the limit cap cannot
  // mask the filtering. infographic is 1 of 3 image-capable.
  const all = findRecipes({ category: "infographic", limit: 10 });
  const withImage = findRecipes({ category: "infographic", input: "image", limit: 10 });
  assert.equal(all.available, 3);
  assert.equal(withImage.available, 1);
  assert.ok(withImage.rows.every((r) => r.image), "input:image returned a recipe with no image path");

  // Globally: 19 of 27 recipes take an image, so filtering must narrow the pool.
  assert.equal(findRecipes({ input: "image", limit: 10 }).available, 19);

  // Every job category keeps at least one option even when the user has an image.
  for (const c of jobCats) {
    const n = findRecipes({ category: c.id, input: "image", limit: 10 }).rows.length;
    assert.ok(n >= 1, `input:image left category ${c.id} empty`);
  }
});

test("input:\"text\" keeps every recipe, because all of them run without an image", () => {
  assert.equal(findRecipes({ input: "text", limit: 10 }).available, lib.recipes.length);
  assert.equal(findRecipes({ limit: 10 }).available, lib.recipes.length, "text is the default");
});

test("invalid mode and input are rejected", () => {
  assert.throws(() => findRecipes({ mode: "sideways" }), /unknown mode/);
  assert.throws(() => findRecipes({ input: "video" }), /unknown input/);
});

// ---------------------------------------------------------------------------
// Lookup by id
// ---------------------------------------------------------------------------

test("every recipe is reachable by id and the id round-trips", () => {
  for (const id of recipeIds()) {
    const r = getRecipe(id);
    assert.equal(r.id, id);
    const found = findRecipes({ id }).rows[0];
    assert.equal(found.id, id);
    assert.equal(found.category, r.category);
  }
  assert.throws(() => getRecipe("does-not-exist"), /unknown recipe id/);
});

test("an id lookup overrides query and mode", () => {
  const r = findRecipes({ id: "logo-mark", query: "character turnaround", mode: "related" });
  assert.equal(r.mode, "one");
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].id, "logo-mark");
});

// ---------------------------------------------------------------------------
// Determinism and variety
// ---------------------------------------------------------------------------

test("the same seed and query produce the same pick", () => {
  const a = findRecipes({ mode: "one", seed: 7 }).rows[0].id;
  const b = findRecipes({ mode: "one", seed: 7 }).rows[0].id;
  assert.equal(a, b);
});

test("changing the seed varies the pick", () => {
  const picks = new Set(Array.from({ length: 10 }, (_, i) => findRecipes({ mode: "one", seed: i }).rows[0].id));
  assert.ok(picks.size > 1, "every seed returned the same recipe");
});

test("a scored query is stable across seeds — the seed only breaks ties", () => {
  const base = findRecipes({ query: "product hero shot", limit: 1 }).rows[0].id;
  for (const seed of [1, 2, 3, 4, 5]) {
    assert.equal(findRecipes({ query: "product hero shot", limit: 1, seed }).rows[0].id, base);
  }
});

// ---------------------------------------------------------------------------
// Filling and rendering
// ---------------------------------------------------------------------------

test("values override defaults and reach the output", () => {
  const f = fill(getRecipe("logo-mark"), { values: { text: "NORTHWIND", ratio: "16:9" } });
  assert.match(f.text, /NORTHWIND/);
  assert.match(f.text, /16:9/);
  assert.ok(!f.text.includes("{ratio}"));
  assert.deepEqual(f.missing, []);
});

test("free slots with no value are reported, not silently shipped", () => {
  const f = fill(getRecipe("logo-mark"));
  assert.deepEqual(f.missing, ["text"]);
  assert.match(f.text, /\{text\}/, "an unfilled free slot should stay visible to the caller");
});

test("negatives are appended once and can be turned off", () => {
  const r = getRecipe("logo-mark");
  const withNeg = fill(r).text;
  const without = fill(r, { includeNegatives: false }).text;
  assert.equal(withNeg.split("AVOID —").length, 2, "negatives appended more than once");
  assert.ok(!without.includes("AVOID —"));
});

test("an empty string value does not overwrite a default", () => {
  const f = fill(getRecipe("logo-mark"), { values: { ratio: "   " } });
  assert.match(f.text, /1:1/, "a blank override should fall back to the default");
});

test("gistOf never cuts mid-word and respects its budget", () => {
  for (const r of lib.recipes) {
    const g = gistOf(r, 120);
    assert.ok(g.length <= 120, `${r.id} gist is ${g.length} chars`);
    if (g.endsWith("…")) assert.ok(/\S…$/.test(g), `${r.id} gist cut mid-word`);
  }
});

test("previews stay small; full mode is much larger", () => {
  const r = findRecipes({ query: "product hero shot", mode: "one" });
  const preview = renderResult(r);
  const full = renderResult(r, { full: true, values: { subject: "a kettle" } });
  assert.ok(preview.length < 900, `preview is ${preview.length} chars`);
  assert.ok(full.length > preview.length * 1.5, "full mode is not meaningfully bigger");
  assert.ok(!preview.includes("Create a"), "a preview should not contain the whole skeleton");
  assert.ok(full.includes("Create a"), "full mode should contain the skeleton");
});

test("full render tells the caller which slots are still empty", () => {
  const text = renderResult(findRecipes({ query: "character sheet", mode: "one" }), { full: true });
  assert.match(text, /Still to fill/);
  assert.match(text, /\{subject\}/);
});

test("the full render's slot line reflects what was actually supplied", () => {
  const supplied = renderResult(findRecipes({ id: "logo-mark" }), {
    full: true,
    values: { text: "ACME", subject: "a peak" },
  });
  assert.match(supplied, /text=ACME/, "a supplied free slot must not still read as unfilled");
  assert.ok(!supplied.includes("text=..."), "the slot line should never show a bare ellipsis");
  assert.ok(!supplied.includes("text={text}"));

  const bare = renderResult(findRecipes({ id: "logo-mark" }), { full: true });
  assert.match(bare, /text=\{text\}/, "an unfilled free slot should read as {slot}");
});

test("the category map names every category and flags image-capable recipes", () => {
  const text = renderCategories();
  for (const id of categoryIds()) assert.ok(text.includes(id), `map is missing ${id}`);
  assert.match(text, /can also take a reference image/);
  assert.equal(renderResult(findRecipes({ mode: "categories" })), text);
  // The map is kind-scoped too, so an agent can ask for just the recipes or
  // just the looks.
  assert.equal(listCategories({ kind: "job" }).length, 9);
  assert.equal(listCategories({ kind: "look" }).length, 6);
  assert.ok(listCategories().every((c) => c.kind === "job" || c.kind === "look"));
});

// ---------------------------------------------------------------------------
// publicRecipe — what an agent actually receives
// ---------------------------------------------------------------------------

test("publicRecipe leaks no internal scoring fields", () => {
  for (const r of lib.recipes) {
    const pub = publicRecipe(r, { full: true, values: { subject: "x", text: "y" } });
    for (const key of Object.keys(pub)) {
      assert.ok(!key.startsWith("_"), `${r.id} leaked internal field ${key}`);
    }
    assert.ok(!JSON.stringify(pub).includes("_match"), `${r.id} leaked scoring data`);
    assert.ok(pub.acceptsImage === Boolean(r.image), `${r.id} misreports acceptsImage`);
    assert.equal(typeof pub.shapeMeans, "string");
  }
});

test("publicRecipe previews declare what the caller must supply", () => {
  const pub = publicRecipe(getRecipe("character-sheet"));
  assert.deepEqual(pub.fillMe.sort(), ["subject", "text"]);
  assert.deepEqual(pub.missing.sort(), ["subject", "text"]);
  assert.ok(!pub.prompt, "a preview should not include the full prompt");
  assert.ok(pub.gist.length > 0);
});

test("publicRecipe calculates fillMe and missing consistently for image inputs", () => {
  const textPub = publicRecipe(getRecipe("character-sheet"), { input: "text" });
  assert.deepEqual(textPub.fillMe.sort(), ["subject", "text"]);
  assert.deepEqual(textPub.missing.sort(), ["subject", "text"]);

  const imgPub = publicRecipe(getRecipe("character-sheet"), { input: "image" });
  assert.deepEqual(imgPub.fillMe, []);
  assert.deepEqual(imgPub.missing, []);
  assert.equal(imgPub.usedImage, true);
});

test("publicRecipe exposes slotOptions for constrained slots", () => {
  const pub = publicRecipe(getRecipe("social-ad"));
  assert.ok(pub.slotOptions, "slotOptions should be present");
  assert.ok(Array.isArray(pub.slotOptions.ratio), "ratio should have options array");
  assert.ok(pub.slotOptions.ratio.includes("1:1"));
  assert.ok(Array.isArray(pub.slotOptions.composition));
});

test("fill strips Exclude . artifacts and validates slot values", () => {
  const look = looks.find((r) => r.id === "acid-burst-motion-type");
  assert.ok(look, "acid-burst-motion-type should exist");
  const filled = fill(look, { values: { ratio: "1:1", subject: "runner", text: "RUN" } });
  assert.ok(!filled.text.includes("Exclude ."), "Exclude . artifact must be stripped");

  const withInvalid = fill(getRecipe("social-ad"), {
    values: { ratio: "not-a-valid-ratio", nonexistent: "val" },
  });
  assert.equal(withInvalid.invalidValues.length, 2);
  assert.ok(withInvalid.invalidValues.some((iv) => iv.slot === "ratio"));
  assert.ok(withInvalid.invalidValues.some((iv) => iv.slot === "nonexistent"));
});

test("router re-exports prompt library API", async () => {
  const router = await import("../src/router.js");
  assert.equal(typeof router.findRecipes, "function");
  assert.equal(typeof router.publicRecipe, "function");
  assert.equal(typeof router.fill, "function");
  assert.equal(typeof router.listCategories, "function");
});

// ---------------------------------------------------------------------------
// Looks — the vendored styles (kind "look")
// ---------------------------------------------------------------------------

test("every look carries the attribution its licence requires", () => {
  for (const r of looks) {
    assert.equal(r.kind, "look");
    assert.ok(r.source, `${r.id} has no source block`);
    assert.match(r.source.repo, /github\.com/);
    assert.equal(r.source.license, "MIT");
    assert.match(r.source.copyright, /VigoZhao/);
    assert.ok(r.source.styleName && r.source.styleVersion, `${r.id} lost its upstream identity`);
    // Attribution must survive into what the caller actually receives, not just
    // sit in the file: this is a licence condition, not a nicety.
    assert.equal(publicRecipe(r).source.license, "MIT");
  }
});

test("every look is usable from text alone, like every recipe", () => {
  for (const r of looks) {
    assert.ok(r.text.length > 200, `${r.id} has no usable text skeleton`);
    assert.ok(r.slots.length > 0, `${r.id} declares no slots`);
    // Every slot a look declares is the caller's content — a vendored style has
    // no defaults of its own — so supplying them all must finish the prompt.
    const values = Object.fromEntries(r.slots.map((s) => [s, "x"]));
    const f = fill(r, { values, input: "text" });
    assert.equal(f.usedImage, false, `${r.id} used an image path it does not have`);
    assert.deepEqual(f.missing, [], `${r.id} still wants ${f.missing.join(", ")}`);
    assert.ok(!/\{\w+\}/.test(f.text), `${r.id} shipped a literal placeholder: ${f.text.match(/\{\w+\}/)}`);
  }
  // A look must not inherit one of our studio defaults.
  const withRatio = looks.find((r) => r.slots.includes("ratio"));
  assert.ok(withRatio, "expected some look to declare a ratio slot");
  assert.ok(fill(withRatio).missing.includes("ratio"), "a look inherited our ratio default");
});

test("the style lock is never dropped, and stays distinct from the avoid-lists", () => {
  const r = looks.find((x) => x.styleLock?.length && x.doNotClone?.length);
  assert.ok(r, "no look carries both a style lock and source-content guards");
  const values = Object.fromEntries(lib.freeSlots.map((s) => [s, "x"]));
  const text = renderResult(findRecipes({ id: r.id }), { full: true, values });
  assert.match(text, /STYLE LOCK/);
  assert.match(text, /DO NOT REPRODUCE/);
  // Three distinct ideas: keep these (lock), never copy that (doNotClone), and
  // avoid these artefacts (negatives). Merging them would lose the distinction.
  assert.ok(text.indexOf("STYLE LOCK") < text.indexOf("DO NOT REPRODUCE"), "the lock should precede the clone guard");
  // The lock is a positive invariant, so turning the avoid-lists off must not
  // take it with them.
  const noNeg = fill(r, { includeNegatives: false }).text;
  assert.ok(!noNeg.includes("AVOID —"), "includeNegatives:false still emitted craft negatives");
  assert.ok(!noNeg.includes("DO NOT REPRODUCE"), "includeNegatives:false still emitted the clone guard");
  assert.ok(noNeg.includes("STYLE LOCK"), "includeNegatives:false must not drop the style lock");
});

test("kind filters cleanly in both directions", () => {
  const onlyJobs = findRecipes({ query: "product hero shot", kind: "job", limit: 10 });
  assert.ok(onlyJobs.rows.length > 0 && onlyJobs.rows.every((r) => r.kind === "job"));
  const onlyLooks = findRecipes({ query: "product hero shot", kind: "look", limit: 10 });
  assert.ok(onlyLooks.rows.every((r) => r.kind === "look"));
  assert.throws(() => findRecipes({ kind: "sculpture" }), /unknown kind/);
  assert.equal(categoryIds("look").length, 6);
});

test("a look is findable by its own distinctive vocabulary", () => {
  const top = findRecipes({ query: "mono noir type portrait poster", limit: 1 }).rows[0];
  assert.ok(top, "the look query matched nothing");
  assert.equal(top.kind, "look");
  assert.ok(top.source.styleName.length > 0, "the look lost its upstream name");
});

test("a nonsense query still returns nothing, even against 137 styles of prose", () => {
  // The regression this guards: with every fidelity anchor indexed, some generic
  // stem in 181KB of prose prefix-matches almost anything ("wobble" matched
  // "wobbleflux"), so one incidental token must never count as a match.
  for (const q of ["qqzzxx flibbertigibbet wobbleflux", "zzzq wibbleflop"]) {
    assert.equal(findRecipes({ query: q }).matched, false, `"${q}" should not match`);
  }
});

test("a deliberate alias outranks an incidental mention in a style's prose", () => {
  // "watercolour" is a hand-written illustration alias, but "water" appears in a
  // megatype editorial style's goal and won on a prefix match until the anchor
  // prose was demoted to a boost that cannot create a match on its own.
  assert.equal(findRecipes({ query: "watercolour", limit: 1 }).rows[0].category, "illustration");
  assert.equal(findRecipes({ query: "dashboard", limit: 1 }).rows[0].category, "ui-mockup");
});

test("a specific query keeps its top pick across seeds", () => {
  // A tie at the top would let the seed shuffle a query that has one right
  // answer, so the scoring must separate a full match from a partial one.
  const picks = new Set(
    [1, 2, 3, 4, 5, 7, 11, 42].map((seed) => findRecipes({ query: "product hero shot", limit: 1, seed }).rows[0].id),
  );
  assert.equal(picks.size, 1, `"product hero shot" shuffled across seeds: ${[...picks].join(", ")}`);
});

test("the library still works when the vendored looks are absent", () => {
  // Looks are optional at load time: a user who prunes data/styles gets a
  // working jobs-only library rather than a crash.
  const entry = new URL("../src/library.js", import.meta.url).href;
  const script = `import { loadRecipes, recipeIds, categoryIds } from ${JSON.stringify(entry)};
const lib = loadRecipes();
console.log(JSON.stringify({ looks: recipeIds("look").length, jobs: recipeIds("job").length, cats: categoryIds().length, source: lib.styleSource }));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, BRUSHROUTER_STYLES_FILE: "/nonexistent/styles.json" },
    encoding: "utf8",
  });
  const r = JSON.parse(out);
  assert.equal(r.looks, 0, "looks should be skipped when the file is missing");
  assert.equal(r.jobs, 27, "jobs must still load without the looks");
  assert.equal(r.cats, 9, "only job categories should remain");
  assert.equal(r.source, null, "no style source should be reported");
});

// ---------------------------------------------------------------------------
// The corpus is a dev fixture and must not be required at runtime
// ---------------------------------------------------------------------------

test("the library reads data/recipes and data/styles, never the dev corpus", () => {
  assert.match(RECIPES_DIR, /data[\\/]recipes$/);
  assert.match(STYLES_FILE, /data[\\/]styles[\\/]styles\.json$/);
  const source = readFileSync(new URL("../src/library.js", import.meta.url), "utf8");
  assert.ok(!source.includes("data/prompts"), "src/library.js must not read the dev corpus");
  assert.ok(!source.includes("data\\prompts"), "src/library.js must not read the dev corpus");
});

test("resetting the cache re-reads from disk and yields the same library", () => {
  const before = recipeIds();
  resetRecipesCache();
  assert.deepEqual(recipeIds(), before);
});

test("categoryIds matches loaded categories with or without pre-populated cache", () => {
  resetRecipesCache();
  const preCats = categoryIds();
  const preJobCats = categoryIds("job");
  const preLookCats = categoryIds("look");

  const lib = loadRecipes();
  assert.deepEqual(preCats, lib.categories.map((c) => c.id));
  assert.deepEqual(preJobCats, lib.categories.filter((c) => c.kind === "job").map((c) => c.id));
  assert.deepEqual(preLookCats, lib.categories.filter((c) => c.kind === "look").map((c) => c.id));
});
