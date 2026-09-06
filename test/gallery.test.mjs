// The gallery content type: extraction, projection, rendering and the lightbox.
//
//   node --test test/gallery.test.mjs
//
// A gallery is a dated post with an image set, the same shape podcast has with
// an audio enclosure. The tests that matter are the ones about where images
// come from and where the behaviour lives, because both are easy to get wrong
// in a way that only shows up on somebody else's content.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeContent, validateContent, extractImages, isDated, CONTENT_TYPES } from "../shared/content.mjs";
import { checkManifest, compileTemplate } from "../shared/template/manifest.mjs";
import { resolveViewPath } from "../shared/template/viewmodel.mjs";
import { renderSite } from "../shared/render.mjs";
import { CLIENT_SOURCE } from "../shared/gallery.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadTemplate(id) {
  const dir = path.join(ROOT, "templates", id);
  const manifestText = await readFile(path.join(dir, "template.json"), "utf8");
  const { manifest, problems } = checkManifest(JSON.parse(manifestText));
  assert.deepEqual(problems, [], `${id} manifest`);
  const sources = { "template.json": manifestText };
  for (const rel of [
    ...Object.values(manifest.layouts ?? {}),
    ...Object.values(manifest.partials ?? {}).map((p) => (typeof p === "string" ? p : p.path)),
    ...(manifest.styles ?? []),
  ]) sources[rel] = await readFile(path.join(dir, rel), "utf8");
  return { ...compileTemplate(manifest, sources), sources };
}

const site = { name: "Test", baseUrl: "https://example.test" };
const gallery = (extra = {}) => normalizeContent({
  type: "gallery", title: "A Weekend in Fog", date: "2026-09-01", status: "published", ...extra,
});

// ------------------------------------------------------------ the type
test("gallery is a dated content type alongside article and podcast", () => {
  assert.ok(CONTENT_TYPES.includes("gallery"));
  assert.equal(isDated("gallery"), true);
  assert.equal(isDated("page"), false);
});

test("a published gallery needs at least one image", () => {
  assert.ok(validateContent(gallery({ images: [] })).includes(
    "a published gallery needs at least one image"));
  assert.deepEqual(validateContent(gallery({ images: [{ url: "a.jpg" }] })), []);
  // A draft is allowed to be empty; that is what a draft is for.
  assert.deepEqual(
    validateContent(gallery({ status: "draft", images: [] })).filter((p) => p.includes("image")), []);
});

// ------------------------------------------------------- where images come from
test("images are extracted from the editor body, and the prose survives", () => {
  const r = gallery({
    body: '<p>Notes from the coast.</p><p><img src="1.jpg" alt="Pier" width="800" height="600"></p><img src="2.jpg" title="Low tide">',
  });
  assert.equal(r.body, "<p>Notes from the coast.</p>", "prose is kept, empty shells are not");
  assert.equal(r.images.length, 2);
  assert.deepEqual(r.images[0], { url: "1.jpg", alt: "Pier", caption: "", width: 800, height: 600 });
  // title -> caption is the ohshelly convention and the only attribute a
  // rich-text editor offers for one.
  assert.equal(r.images[1].caption, "Low tide");
});

test("an explicit image list wins, and leaves the body alone", () => {
  const r = gallery({ images: [{ url: "chosen.jpg" }], body: '<p>Keep <img src="inline.jpg"> me</p>' });
  assert.deepEqual(r.images.map((i) => i.url), ["chosen.jpg"]);
  assert.match(r.body, /inline\.jpg/);
});

test("extraction never touches a non-gallery post", () => {
  const r = normalizeContent({ type: "article", title: "A", body: '<p><img src="z.jpg"></p>' });
  assert.match(r.body, /z\.jpg/);
  assert.deepEqual(r.images, []);
});

test("normalizing twice changes nothing", () => {
  const once = gallery({ body: '<p>Text.</p><img src="1.jpg">' });
  const twice = normalizeContent(once);
  assert.equal(twice.body, once.body);
  assert.deepEqual(twice.images, once.images);
});

test("a record from the old templateType field is still a gallery", () => {
  assert.equal(normalizeContent({ templateType: "gallery", title: "X" }).type, "gallery");
  assert.equal(normalizeContent({ templateType: "podcast", title: "X" }).type, "podcast");
  assert.equal(normalizeContent({ templateType: "whatever", title: "X" }).type, "article");
});

test("extractImages drops an <img> with no src rather than inventing one", () => {
  const { images, body } = extractImages('<p>a</p><img alt="broken"><img src="ok.jpg">');
  assert.deepEqual(images.map((i) => i.url), ["ok.jpg"]);
  assert.equal(body, "<p>a</p>");
});

// -------------------------------------------------------------- the view model
test("the view model exposes images, a cover and isGallery", () => {
  assert.ok(resolveViewPath("article", "post.images", { scope: null }).ok);
  assert.ok(resolveViewPath("article", "post.cover.url", { scope: null }).ok);
  assert.ok(resolveViewPath("article", "post.isGallery", { scope: null }).ok);
  assert.ok(resolveViewPath("article", "url", { scope: "post.images[]" }).ok);
  assert.ok(resolveViewPath("article", "caption", { scope: "post.images[]" }).ok);
  // Still a closed contract: a typo inside the loop is an error, not a blank.
  assert.equal(resolveViewPath("article", "captoin", { scope: "post.images[]" }).ok, false);
});

// ------------------------------------------------------------------ rendering
for (const id of ["journal", "ledger", "plain"]) {
  test(`${id} renders a gallery and links the lightbox`, async () => {
    const template = await loadTemplate(id);
    assert.ok(template.manifest.supports.includes("gallery"), "declares support");

    const record = gallery({ body: '<p>Notes.</p><img src="media/1.jpg" alt="Pier"><img src="media/2.jpg">' });
    const { files, posts } = renderSite({ template, site, records: [record] });
    const html = files["2026-09-01-a-weekend-in-fog.html"];

    assert.ok(posts[0].isGallery);
    assert.equal(posts[0].cover.url, "media/1.jpg");
    assert.equal(posts[0].images[0].absUrl, "https://example.test/media/1.jpg");

    assert.match(html, /data-qw-gallery\b/, "grid hook");
    assert.match(html, /data-qw-gallery-item/, "item hook");
    assert.match(html, /src="media\/1\.jpg"/);
    assert.match(html, /alt="Pier"/);
    assert.match(html, /loading="lazy"/);
    assert.match(html, /assets\/gallery\.js/, "links the platform lightbox");
    // The prose is still the prose.
    assert.match(html, /Notes\./);
  });
}

// Same discipline as search: what a site is made of must not depend on what
// happens to be published in it today.
test("a site with no galleries still gets the same file set", async () => {
  const template = await loadTemplate("journal");
  const article = normalizeContent({ type: "article", title: "Plain", date: "2026-01-01", status: "published", body: "<p>x</p>" });
  const { files } = renderSite({ template, site, records: [article] });
  assert.ok(files["assets/gallery.js"], "emitted unconditionally");
  assert.doesNotMatch(files["2026-01-01-plain.html"], /data-qw-gallery\b/, "no grid without images");
});

test("a template may override the article layout with a gallery one", async () => {
  const base = await loadTemplate("plain");
  const sources = { ...base.sources, "layouts/gallery.html": "GALLERY LAYOUT {{post.title}}" };
  const manifest = JSON.parse(sources["template.json"]);
  manifest.layouts.gallery = "layouts/gallery.html";
  sources["template.json"] = JSON.stringify(manifest);
  const { manifest: checked, problems } = checkManifest(manifest);
  assert.deepEqual(problems, [], "gallery is an accepted optional layout");

  const template = { ...compileTemplate(checked, sources), sources };
  const { files } = renderSite({
    template, site,
    records: [gallery({ images: [{ url: "a.jpg" }] }),
              normalizeContent({ type: "article", title: "Post", date: "2026-01-01", status: "published" })],
  });
  assert.match(files["2026-09-01-a-weekend-in-fog.html"], /^GALLERY LAYOUT/);
  assert.doesNotMatch(files["2026-01-01-post.html"], /^GALLERY LAYOUT/, "articles are unaffected");
});

// --------------------------------------------------------------- the lightbox
test("the emitted lightbox is syntactically valid JavaScript", () => {
  assert.doesNotThrow(() => new Function(CLIENT_SOURCE));
});

test("the lightbox reads the markup contract the templates emit", () => {
  assert.match(CLIENT_SOURCE, /\[data-qw-gallery\]/);
  assert.match(CLIENT_SOURCE, /\[data-qw-gallery-item\]/);
  // Keyboard and escape are not optional on a modal.
  for (const key of ["Escape", "ArrowRight", "ArrowLeft"]) {
    assert.ok(CLIENT_SOURCE.includes(key), `handles ${key}`);
  }
});

test("the lightbox does nothing on a page with no gallery", () => {
  // Guard clause, checked as source: the client is emitted onto every page of
  // every site, so "returns immediately when there is nothing to do" is the
  // property that keeps that free.
  const first = CLIENT_SOURCE.indexOf("querySelectorAll");
  const guard = CLIENT_SOURCE.indexOf("if (!grids.length) return;");
  assert.ok(guard > first && guard - first < 200, "bails out before doing any work");
});
