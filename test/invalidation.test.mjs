// Publish invalidates the files it changed, not the whole site
// (admin/lib/invalidation.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { invalidationPaths, invalidationPath, MAX_EXACT_PATHS } from "../admin/lib/invalidation.mjs";

test("a typical publish sends its exact paths, not a wildcard", () => {
  const keys = Array.from({ length: 40 }, (_, i) => `sites/acme/posts/p${i}/index.html`);
  const paths = invalidationPaths(keys, "/sites/acme/*");
  assert.equal(paths.length, 40);
  assert.ok(!paths.some((p) => p.includes("*")));
  assert.equal(paths[0], "/sites/acme/posts/p0/index.html");
});

test("a path changed and removed in one publish is sent once", () => {
  assert.deepEqual(invalidationPaths(["a.html", "a.html"], "/*"), ["/a.html"]);
});

test("only a re-render past the cap falls back to the site wildcard", () => {
  const keys = Array.from({ length: MAX_EXACT_PATHS + 1 }, (_, i) => `sites/acme/${i}.html`);
  assert.deepEqual(invalidationPaths(keys, "/sites/acme/*"), ["/sites/acme/*"]);
  assert.equal(invalidationPaths(keys.slice(1), "/sites/acme/*").length, MAX_EXACT_PATHS);
});

test("unsafe characters are URL-encoded, slashes kept", () => {
  assert.equal(invalidationPath("sites/acme/media/my photo#1.jpg"), "/sites/acme/media/my%20photo%231.jpg");
});
