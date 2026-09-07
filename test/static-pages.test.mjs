// Hand-authored static pages: the path rules, and the two-copy lifecycle.
//
//   node --test test/static-pages.test.mjs
//
// These bypass the content model, so the guards on where one may land are the
// whole safety story: a page that overwrites index.html, escapes its prefix, or
// shadows a real post is worse than one that was refused.

import test from "node:test";
import assert from "node:assert/strict";

import {
  putStaticPage, listStaticPages, readStaticPage, removeStaticPage, stageStaticPages,
  checkStaticPath, StaticPageRejected, STATIC_PREFIX, GENERATED_PATHS,
} from "../shared/static-pages.mjs";

function fakeStore() {
  const objects = new Map();
  return {
    objects,
    async putText(key, body) { objects.set(key, body); },
    async getText(key) { return objects.has(key) ? objects.get(key) : null; },
    async remove(key) { objects.delete(key); },
    async list(prefix = "") {
      return [...objects.keys()].filter((k) => k.startsWith(prefix))
        .map((k) => ({ key: k, size: objects.get(k).length }));
    },
  };
}

const PAGE = "<!doctype html><html><body><h1>T-shirts</h1></body></html>";

// ------------------------------------------------------------------ the path
test("a path must be relative, traversal-free and extensioned", () => {
  assert.equal(checkStaticPath("shop/tees.html"), "shop/tees.html");
  assert.equal(checkStaticPath("/pricing.html"), "pricing.html", "a leading slash is tolerated");

  for (const bad of [
    "", "   ", "../secret.html", "shop/../../etc/passwd", "shop\\tees.html",
    "shop/", "no-extension", "a/b/c/d/e/f/g.html", "-leading.html",
  ]) {
    assert.throws(() => checkStaticPath(bad), StaticPageRejected, `should refuse: ${JSON.stringify(bad)}`);
  }
});

test("the renderer's own filenames are refused", () => {
  for (const p of GENERATED_PATHS) {
    assert.throws(() => checkStaticPath(p), StaticPageRejected, p);
  }
  // Otherwise the next rebuild silently overwrites it and the upload looks lost.
  for (const p of ["assets/style.css", "admin/index.html", "_internal/x.json", "media/a.html"]) {
    assert.throws(() => checkStaticPath(p), StaticPageRejected, p);
  }
});

test("a static page cannot shadow a post or page that renders to the same file", () => {
  const slugs = ["about", "2026-01-01-hello"];
  assert.throws(() => checkStaticPath("about.html", { slugs }), StaticPageRejected);
  assert.throws(() => checkStaticPath("2026-01-01-hello.html", { slugs }), StaticPageRejected);
  assert.equal(checkStaticPath("pricing.html", { slugs }), "pricing.html");
});

// ------------------------------------------------------------------ lifecycle
test("an upload writes both the source and the staged copy", async () => {
  const store = fakeStore();
  const { path, bytes } = await putStaticPage(store, "shop/tees.html", PAGE);

  assert.equal(path, "shop/tees.html");
  assert.equal(bytes, PAGE.length);
  // The source is held under _internal/, which SKIP_PREFIXES excludes from
  // publish; the staged copy is what a changeset promotes.
  assert.equal(store.objects.get(`${STATIC_PREFIX}shop/tees.html`), PAGE);
  assert.equal(store.objects.get("shop/tees.html"), PAGE,
    "staged immediately, so it shows up in the changeset now rather than after the next save");
});

test("the body is published verbatim, markup and script and all", async () => {
  const store = fakeStore();
  const raw = '<!doctype html><script>calculatePrice()</script><style>b{color:red}</style>';
  await putStaticPage(store, "calc.html", raw);
  assert.equal(store.objects.get("calc.html"), raw, "nothing sanitized, nothing templated");
});

test("an empty or non-text body is refused", async () => {
  const store = fakeStore();
  await assert.rejects(() => putStaticPage(store, "a.html", "   "), StaticPageRejected);
  await assert.rejects(() => putStaticPage(store, "a.html", null), StaticPageRejected);
  await assert.rejects(() => putStaticPage(store, "a.html", { html: PAGE }), StaticPageRejected);
  assert.equal(store.objects.size, 0);
});

test("re-uploading replaces both copies", async () => {
  const store = fakeStore();
  await putStaticPage(store, "pricing.html", PAGE);
  await putStaticPage(store, "pricing.html", "<p>v2</p>");
  assert.equal(store.objects.get("pricing.html"), "<p>v2</p>");
  assert.equal(store.objects.get(`${STATIC_PREFIX}pricing.html`), "<p>v2</p>");
  assert.equal((await listStaticPages(store)).length, 1);
});

test("listing and reading round-trip", async () => {
  const store = fakeStore();
  await putStaticPage(store, "b.html", PAGE);
  await putStaticPage(store, "a.html", PAGE);
  assert.deepEqual((await listStaticPages(store)).map((p) => p.path), ["a.html", "b.html"]);
  assert.equal(await readStaticPage(store, "a.html"), PAGE);
  assert.equal(await readStaticPage(store, "missing.html"), null);
});

test("deleting removes the staged copy too, so nothing is orphaned", async () => {
  const store = fakeStore();
  await putStaticPage(store, "pricing.html", PAGE);
  await removeStaticPage(store, "pricing.html");

  assert.equal(store.objects.size, 0,
    "a source-only delete would leave a file that publishes forever and lists nowhere");
  assert.deepEqual(await listStaticPages(store), []);
  await assert.rejects(() => removeStaticPage(store, "pricing.html"), StaticPageRejected);
});

test("re-staging restores a staged copy that went missing", async () => {
  const store = fakeStore();
  await putStaticPage(store, "pricing.html", PAGE);
  store.objects.delete("pricing.html");

  const staged = await stageStaticPages(store);
  assert.deepEqual(staged, ["pricing.html"]);
  assert.equal(store.objects.get("pricing.html"), PAGE);
});

test("re-staging a site with no static pages does nothing", async () => {
  assert.deepEqual(await stageStaticPages(fakeStore()), []);
});
