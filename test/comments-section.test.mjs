// The comment section on a rendered article, and the page-side half of it:
// the hint cookie that decides between a form and a "Sign in" button.
//
//   node --test test/comments-section.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeContent } from "../shared/content.mjs";
import { checkManifest, compileTemplate } from "../shared/template/manifest.mjs";
import { COMMENTS_LIB } from "../shared/template/viewmodel.mjs";
import { renderSite } from "../shared/render.mjs";
import { hintName, readHint, validThread, DEFAULT_CSS } from "../shared/comments.mjs";

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
const article = normalizeContent({
  type: "article", slug: "2026-09-04-hello", title: "Hello", date: "2026-09-04",
  status: "published", body: "<p>Hi.</p>",
});
const SECTION = '<section class="comments" data-qw-comments data-qw-thread="2026-09-04-hello"';
const SCRIPT = `<script src="${COMMENTS_LIB}" defer></script>`;

test("a site that takes comments gets the section on each article, and the library", async () => {
  const template = await loadTemplate("journal");
  const { files } = renderSite({ template, site, records: [article], comments: true });
  const html = files["2026-09-04-hello.html"];
  assert.ok(html.includes(SECTION), "section with the post's slug as its thread");
  assert.ok(html.includes(SCRIPT), "library loaded from the edge's root path");
  // The library rides on every page (one head partial), but only articles mount it.
  assert.ok(files["index.html"].includes(SCRIPT));
  assert.ok(!files["index.html"].includes("data-qw-comments"));
  assert.ok(validThread("2026-09-04-hello"));
});

test("a site with comments off renders exactly what it did before", async () => {
  const template = await loadTemplate("journal");
  const { files } = renderSite({ template, site, records: [article] });
  const html = files["2026-09-04-hello.html"];
  assert.ok(!html.includes("data-qw-comments"));
  assert.ok(!html.includes("__qw/lib"));
});

test("the hint cookie gives a name, and nothing else", () => {
  assert.equal(hintName("a=1; qw_cmt=Sam%20O; b=2"), "Sam O");
  assert.equal(hintName("qw_cmt=Sam"), "Sam");
  assert.equal(hintName("xqw_cmt=Sam"), null, "a cookie whose name only ends in qw_cmt");
  assert.equal(hintName("qw_cmt="), null);
  assert.equal(hintName(""), null);
  assert.equal(hintName(undefined), null);
  assert.equal(hintName("qw_cmt=%E0%A4"), null, "undecodable is the same as absent");
});

test("the hint's role is a site role or none, and a name may hold a colon", () => {
  assert.deepEqual(readHint("qw_cmt=editor:Sam%20O"), { name: "Sam O", role: "editor" });
  assert.deepEqual(readHint("qw_cmt=Sam"), { name: "Sam", role: "none" }, "a hint from before roles");
  assert.deepEqual(readHint("qw_cmt=staff:Sam"), { name: "Sam", role: "none" }, "not a site role");
  assert.deepEqual(readHint("qw_cmt=owner:Dr%3A%20Who"), { name: "Dr: Who", role: "owner" });
  assert.equal(readHint("qw_cmt=owner:"), null);
});

test("the default styles stay at zero specificity, so any template rule wins", () => {
  for (const rule of DEFAULT_CSS.split("}").filter(Boolean)) {
    const selector = rule.slice(0, rule.indexOf("{"));
    assert.match(selector, /^:where\(/, selector);
    assert.doesNotMatch(selector.replace(/:where\([^)]*\)/g, ""), /[.#\w]/, selector);
  }
});
