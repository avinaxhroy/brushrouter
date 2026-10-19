// Packaging guard: anything the shipped code resolves relative to the package
// root has to be inside the published tarball.
//
// package.json "files" is an allowlist, so a runtime-read file that lives
// outside src/ is silently excluded from the npm tarball unless it is added
// there. That is exactly how scripts/gptweb2api-hideconversations.patch went
// missing from published releases: the source-build path skipped the cleanup
// hook with no warning, while a git clone got it. These tests fail on the next
// occurrence instead of letting it ship.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { HIDE_CONVERSATIONS_PATCH } from "../src/providers/gptweb2api.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

// npm always packs these regardless of "files".
const ALWAYS_SHIPPED = new Set(["package.json", "README.md", "LICENSE"]);

const rel = (abs) => relative(ROOT, abs).split(sep).join("/");

function walkJs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJs(full));
    else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

function isShipped(target) {
  if (ALWAYS_SHIPPED.has(target)) return true;
  return (pkg.files || []).some((entry) => {
    const clean = entry.replace(/^\.\//, "").replace(/\/+$/, "");
    return target === clean || target.startsWith(`${clean}/`);
  });
}

test("every package-relative path resolved by shipped code is in the tarball", () => {
  const offenders = [];
  let found = 0;
  for (const file of [...walkJs(join(ROOT, "src")), ...walkJs(join(ROOT, "bin"))]) {
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(/new URL\(\s*"(\.[^"]*)"\s*,\s*import\.meta\.url\s*\)/g)) {
      found++;
      const target = rel(resolve(dirname(file), m[1]));
      if (!isShipped(target)) offenders.push(`${rel(file)} -> ${target}`);
    }
  }
  assert.ok(found >= 2, `expected to find package-relative path resolutions, found ${found}`);
  assert.deepEqual(offenders, [], `shipped code reads files that npm would not pack:\n  ${offenders.join("\n  ")}`);
});

test("the gptweb2api cleanup patch is present and shipped", () => {
  assert.ok(existsSync(HIDE_CONVERSATIONS_PATCH), `missing from the checkout: ${HIDE_CONVERSATIONS_PATCH}`);
  assert.ok(
    isShipped(rel(HIDE_CONVERSATIONS_PATCH)),
    'scripts/gptweb2api-hideconversations.patch is not covered by package.json "files"',
  );
});

test('every package.json "files" entry exists on disk', () => {
  const missing = (pkg.files || []).filter((entry) => !existsSync(join(ROOT, entry.replace(/\/+$/, ""))));
  assert.deepEqual(missing, [], `files entries that do not exist: ${missing.join(", ")}`);
});

test("files entries resolve to files or directories, not accidentally empty paths", () => {
  for (const entry of pkg.files || []) {
    const full = join(ROOT, entry.replace(/\/+$/, ""));
    assert.ok(existsSync(full), `${entry} does not exist`);
    const kind = statSync(full).isDirectory() ? "dir" : "file";
    assert.ok(kind === "dir" || kind === "file", `${entry} has an unexpected type`);
  }
});
