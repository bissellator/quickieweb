// Per-site mirror functions (infra/edge/sites/*.js): a custom domain's own
// viewer-request function, for redirects from a site's old URLs.
//
// Loaded from source and evaluated, as test/edge.test.mjs does, so the shipped
// file stays exactly what CloudFront runs.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (f) => new Function(`${readFileSync(path.join(ROOT, f), "utf8")}\nreturn handler;`)();

const req = (uri, querystring = {}) => ({ request: { uri, querystring, headers: {} } });

test("stuckinawoman: old /articles/ URLs 301 to the same file at the root", () => {
  const h = load("infra/edge/sites/stuckinawoman.js");
  for (const slug of ["6981a2e5-birthing-hormones.html", "f5c952a0-swapped-with-my-indian-auntie.html",
    "5f9e034b-easier-life.html", "7a867ba4-transformed-by-the-rancher.html"]) {
    const r = h(req(`/articles/${slug}`));
    assert.equal(r.statusCode, 301);
    assert.equal(r.headers.location.value, `/${slug}`);
  }
});

test("stuckinawoman: query strings survive the redirect", () => {
  const h = load("infra/edge/sites/stuckinawoman.js");
  const r = h(req("/articles/5f9e034b-easier-life.html", {
    utm_source: { value: "reddit" }, ref: { value: "", multiValue: [{ value: "a" }, { value: "b" }] },
  }));
  assert.equal(r.headers.location.value, "/5f9e034b-easier-life.html?utm_source=reddit&ref=a&ref=b");
});

test("stuckinawoman: /articles itself and the old favicon redirect", () => {
  const h = load("infra/edge/sites/stuckinawoman.js");
  assert.equal(h(req("/articles/")).headers.location.value, "/");
  assert.equal(h(req("/articles")).headers.location.value, "/");
  assert.equal(h(req("/favicon.png")).headers.location.value, "/favicon.ico");
});

test("stuckinawoman: keeps mirror-router's index behaviour, leaves real pages alone", () => {
  const h = load("infra/edge/sites/stuckinawoman.js");
  assert.equal(h(req("/")).uri, "/index.html");
  assert.equal(h(req("/tags/age-progression/")).uri, "/tags/age-progression/index.html");
  assert.equal(h(req("/5f9e034b-easier-life.html")).uri, "/5f9e034b-easier-life.html");
  // a page whose own name merely starts with "articles" is not an old URL
  assert.equal(h(req("/articles-of-faith.html")).uri, "/articles-of-faith.html");
});
