// Hand-authored static files: the path rules, and the two-copy lifecycle.
//
//   node --test test/static-pages.test.mjs
//
// These bypass the content model, so the guards on where one may land are the
// whole safety story: a file that escapes its prefix, breaks the console, or
// shadows a real post is worse than one that was refused. Replacing a file the
// template writes (index.html, assets/style.css) is allowed on purpose.

import test from "node:test";
import assert from "node:assert/strict";

import {
  putStaticPage, listStaticPages, readStaticPage, removeStaticPage, stageStaticPages,
  checkStaticPath, checkStaticBody, StaticPageRejected, STATIC_PREFIX, GENERATED_PATHS,
  GENERATED_LIST_KEY,
} from "../shared/static-pages.mjs";

// Holds Buffers, as S3 does. `text(key)` reads one back as a string for the
// assertions; `ops` records the order of writes.
function fakeStore() {
  const objects = new Map();
  const types = new Map();
  const ops = [];
  return {
    objects, types, ops,
    text(key) { return objects.has(key) ? objects.get(key).toString("utf8") : undefined; },
    async putBuffer(key, body, type) {
      objects.set(key, Buffer.from(body));
      types.set(key, type);
      ops.push(`put ${key}`);
    },
    async getText(key) { return objects.has(key) ? objects.get(key).toString("utf8") : null; },
    async exists(key) { return objects.has(key); },
    async remove(key) { objects.delete(key); },
    async copyWithinStaging(from, to) {
      if (!objects.has(from)) throw new Error(`NoSuchKey ${from}`);
      objects.set(to, Buffer.from(objects.get(from)));
      ops.push(`copy ${from} -> ${to}`);
    },
    async list(prefix = "") {
      return [...objects.keys()].filter((k) => k.startsWith(prefix))
        .map((k) => ({ key: k, size: objects.get(k).length }));
    },
  };
}

const PAGE = "<!doctype html><html><body><h1>T-shirts</h1></body></html>";
// The first bytes of a real PNG and a real woff2: not valid UTF-8, so any path
// that turned them into a string on the way through would change them.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80]);
const WOFF2 = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0xc3, 0x28, 0xa0, 0xa1]);

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

test("a static file may replace what the renderer writes", () => {
  // A hand-built home page and its stylesheet, beside console-written posts.
  for (const p of [...GENERATED_PATHS, "assets/style.css", "assets/fonts/x.woff2"]) {
    assert.equal(checkStaticPath(p), p, p);
  }
});

test("the platform's own paths, and what the console reads back, are refused", () => {
  for (const p of ["admin/index.html", "_internal/x.json", "media/a.png", "__qw/session.html",
    "taxonomy.json", "admins.json", "sitedata.json"]) {
    assert.throws(() => checkStaticPath(p), StaticPageRejected, p);
  }
});

test("any type a web page loads is accepted; anything else is refused", () => {
  for (const p of ["a.png", "a.jpg", "a.jpeg", "a.webp", "a.gif", "a.avif", "f.woff2", "f.woff",
    "f.ttf", "f.otf", "m.mjs", "s.map", "site.webmanifest", "d.pdf", "v.mp4", "v.webm", "a.mp3"]) {
    assert.equal(checkStaticPath(p), p, p);
  }
  for (const p of ["run.exe", "x.php", "archive.zip", "x.sh"]) {
    assert.throws(() => checkStaticPath(p), StaticPageRejected, p);
  }
});

test("a static file cannot shadow a post or page that renders to the same file", () => {
  const slugs = ["about", "2026-01-01-hello"];
  assert.throws(() => checkStaticPath("about.html", { slugs }), StaticPageRejected);
  assert.throws(() => checkStaticPath("2026-01-01-hello.html", { slugs }), StaticPageRejected);
  assert.equal(checkStaticPath("pricing.html", { slugs }), "pricing.html");
});

// ------------------------------------------------------------------ the body
test("a binary file sent as text is refused rather than mangled", async () => {
  const store = fakeStore();
  await assert.rejects(() => putStaticPage(store, "a.png", "not really a png"), StaticPageRejected);
  assert.equal(store.objects.size, 0);
});

test("a binary favicon is refused; the platform serves .ico as SVG", () => {
  const ico = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10]);
  assert.throws(() => checkStaticBody("favicon.ico", ico), StaticPageRejected);
  assert.ok(checkStaticBody("favicon.ico", '<svg xmlns="http://www.w3.org/2000/svg"></svg>').length);
});

test("an empty or non-text body is refused", async () => {
  const store = fakeStore();
  await assert.rejects(() => putStaticPage(store, "a.html", "   "), StaticPageRejected);
  await assert.rejects(() => putStaticPage(store, "a.html", null), StaticPageRejected);
  await assert.rejects(() => putStaticPage(store, "a.html", { html: PAGE }), StaticPageRejected);
  await assert.rejects(() => putStaticPage(store, "a.png", Buffer.alloc(0)), StaticPageRejected);
  assert.equal(store.objects.size, 0);
});

// ------------------------------------------------------------------ lifecycle
test("an upload writes both the source and the staged copy", async () => {
  const store = fakeStore();
  const { path, bytes, replaces } = await putStaticPage(store, "shop/tees.html", PAGE);

  assert.equal(path, "shop/tees.html");
  assert.equal(bytes, PAGE.length);
  assert.equal(replaces, false);
  // The source is held under _internal/, which SKIP_PREFIXES excludes from
  // publish; the staged copy is what a changeset promotes.
  assert.equal(store.text(`${STATIC_PREFIX}shop/tees.html`), PAGE);
  assert.equal(store.text("shop/tees.html"), PAGE,
    "staged immediately, so it shows up in the changeset now rather than after the next save");
  assert.equal(store.types.get("shop/tees.html"), "text/html; charset=utf-8");
});

test("images and fonts arrive byte for byte, with their own types", async () => {
  const store = fakeStore();
  await putStaticPage(store, "assets/bible/cast.png", PNG);
  await putStaticPage(store, "assets/jost.woff2", WOFF2);
  assert.ok(store.objects.get("assets/bible/cast.png").equals(PNG));
  assert.ok(store.objects.get(`${STATIC_PREFIX}assets/jost.woff2`).equals(WOFF2));
  assert.equal(store.types.get("assets/bible/cast.png"), "image/png");
  assert.equal(store.types.get("assets/jost.woff2"), "font/woff2");
});

test("replacing a generated file is allowed, and said", async () => {
  const store = fakeStore();
  const res = await putStaticPage(store, "index.html", PAGE);
  assert.equal(res.replaces, true);
  const [listed] = await listStaticPages(store);
  assert.equal(listed.replaces, true, "the console marks it, so nothing is replaced quietly");
});

test("only files the last rebuild actually wrote are marked as replaced", async () => {
  const store = fakeStore();
  await store.putBuffer(GENERATED_LIST_KEY, JSON.stringify(["index.html", "assets/style.css"]));
  await putStaticPage(store, "assets/style.css", "b{color:red}");
  await putStaticPage(store, "assets/bible/cast.png", PNG);
  const byPath = Object.fromEntries((await listStaticPages(store)).map((p) => [p.path, p.replaces]));
  assert.deepEqual(byPath, { "assets/bible/cast.png": false, "assets/style.css": true },
    "an image the template never wrote is not 'replacing' anything just for living under assets/");
});

test("a corrupt generated list is loud, not an empty set", async () => {
  const store = fakeStore();
  await store.putBuffer(GENERATED_LIST_KEY, "{not json");
  await assert.rejects(() => listStaticPages(store), /not valid JSON/);
});

test("the body is published verbatim, markup and script and all", async () => {
  const store = fakeStore();
  const raw = '<!doctype html><script>calculatePrice()</script><style>b{color:red}</style>';
  await putStaticPage(store, "calc.html", raw);
  assert.equal(store.text("calc.html"), raw, "nothing sanitized, nothing templated");
});

test("re-uploading replaces both copies", async () => {
  const store = fakeStore();
  await putStaticPage(store, "pricing.html", PAGE);
  await putStaticPage(store, "pricing.html", "<p>v2</p>");
  assert.equal(store.text("pricing.html"), "<p>v2</p>");
  assert.equal(store.text(`${STATIC_PREFIX}pricing.html`), "<p>v2</p>");
  assert.equal((await listStaticPages(store)).length, 1);
});

test("listing and reading round-trip", async () => {
  const store = fakeStore();
  await putStaticPage(store, "b.html", PAGE);
  await putStaticPage(store, "a.html", PAGE);
  assert.deepEqual((await listStaticPages(store)).map((p) => p.path), ["a.html", "b.html"]);
  assert.equal(await readStaticPage(store, "a.html"), PAGE);
  assert.equal(await readStaticPage(store, "missing.html"), null);
  await putStaticPage(store, "cast.png", PNG);
  await assert.rejects(() => readStaticPage(store, "cast.png"), StaticPageRejected,
    "a binary file is never returned as a string");
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
  assert.equal(store.text("pricing.html"), PAGE);
});

test("re-staging copies inside the bucket, so binary files survive it, and wins", async () => {
  const store = fakeStore();
  await putStaticPage(store, "assets/cast.png", PNG);
  // What a rebuild's template-asset copy would have just written there.
  store.objects.set("assets/cast.png", Buffer.from("the template's own file"));

  await stageStaticPages(store);
  assert.ok(store.objects.get("assets/cast.png").equals(PNG),
    "the static file wins over whatever the rebuild wrote there");
  assert.deepEqual(store.ops.slice(-1), [`copy ${STATIC_PREFIX}assets/cast.png -> assets/cast.png`]);
});

test("re-staging a site with no static files does nothing", async () => {
  assert.deepEqual(await stageStaticPages(fakeStore()), []);
});
