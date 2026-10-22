// What a template can build on: prev/next between posts, the optional archive
// and tag layouts, image thumbnails, and articles.json as a manifest a
// template's own scripts can drive galleries and filters from.
//
//   node --test test/site-manifest.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { normalizeContent, extractImages, validateContent } from "../shared/content.mjs";
import { checkManifest, compileTemplate } from "../shared/template/manifest.mjs";
import { resolveViewPath, buildTags, tagSlug } from "../shared/template/viewmodel.mjs";
import { renderSite } from "../shared/render.mjs";
import { validateTemplate } from "../shared/template/validate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// plain, plus whatever layouts/scripts a test adds on top.
async function plainWith(extra = {}, manifestExtra = {}) {
  const dir = path.join(ROOT, "templates", "plain");
  const base = JSON.parse(await readFile(path.join(dir, "template.json"), "utf8"));
  const raw = { ...base, ...manifestExtra, layouts: { ...base.layouts, ...(manifestExtra.layouts ?? {}) } };
  const { manifest, problems } = checkManifest(raw);
  assert.deepEqual(problems, []);
  const sources = { "template.json": JSON.stringify(raw) };
  for (const rel of [
    ...Object.values(base.layouts),
    ...Object.values(base.partials).map((p) => (typeof p === "string" ? p : p.path)),
    ...(base.styles ?? []),
  ]) sources[rel] = await readFile(path.join(dir, rel), "utf8");
  Object.assign(sources, extra);
  return { ...compileTemplate(manifest, sources), sources };
}

const site = { name: "Test", shortName: "Test", baseUrl: "https://example.test" };
const post = (slug, date, extra = {}) => normalizeContent({
  type: "article", slug, title: slug.toUpperCase(), date, status: "published", ...extra,
});
const RECORDS = [
  post("c", "2026-03-03", { tags: ["Red", "Blue"] }),
  post("b", "2026-02-02", { tags: ["Red"] }),
  post("a", "2026-01-01", { tags: ["Blue Moon"] }),
];

// ------------------------------------------------------------ neighbours
test("each post knows its newer and older neighbour, null at the ends", async () => {
  const template = await plainWith({
    "layouts/article.html": "{{> head}}<p>{{#if post.newer}}N:{{post.newer.url}}|{{post.newer.title}}{{/if}} " +
      "{{#if post.older}}O:{{post.older.url}}|{{post.older.title}}{{/if}}</p>{{> footer}}",
  });
  const { files } = renderSite({ template, site, records: RECORDS });
  assert.match(files["c.html"], /<p> O:b\.html\|B<\/p>/);
  assert.match(files["b.html"], /<p>N:c\.html\|C O:a\.html\|A<\/p>/);
  assert.match(files["a.html"], /<p>N:b\.html\|B <\/p>/);
});

test("neighbours skip a post the listings hide", async () => {
  const template = await plainWith({
    "layouts/article.html": "{{> head}}<p>{{post.newer.slug}}/{{post.older.slug}}</p>{{> footer}}",
  });
  const records = [RECORDS[0], { ...RECORDS[1], access: "admin" }, RECORDS[2]];
  const { files } = renderSite({ template, site, records });
  // b is still rendered (the edge guards it) but c and a link past it.
  assert.match(files["c.html"], /<p>\/a<\/p>/);
  assert.match(files["a.html"], /<p>c\/<\/p>/);
  assert.match(files["b.html"], /<p>\/<\/p>/);
});

test("newer/older resolve in the validator's model", () => {
  assert.ok(resolveViewPath("article", "post.newer.url").ok);
  assert.ok(resolveViewPath("article", "post.older.title").ok);
  assert.ok(!resolveViewPath("article", "post.older.body").ok);
});

// ------------------------------------------------------------ tags
test("tags are counted, most-used first, with stable slugs", () => {
  const tags = buildTags([{ tags: ["Red", "Blue"] }, { tags: ["Red", "Red"] }, { tags: ["Blue Moon"] }]);
  assert.deepEqual(tags.map((t) => [t.name, t.count, t.url]), [
    ["Red", 2, "tags/red.html"], ["Blue", 1, "tags/blue.html"], ["Blue Moon", 1, "tags/blue-moon.html"],
  ]);
  assert.equal(tagSlug("Punishment/Revenge"), "punishment-revenge");
  assert.equal(tagSlug("///"), "tag");
});

test("every layout sees the site's tags", async () => {
  const template = await plainWith({
    "layouts/index.html": "{{> head}}<ul>{{#each tags}}<li>{{name}}={{count}}</li>{{/each}}</ul>{{> footer}}",
  });
  const { files } = renderSite({ template, site, records: RECORDS });
  assert.match(files["index.html"], /<li>Red=2<\/li><li>Blue=1<\/li><li>Blue Moon=1<\/li>/);
});

test("the tag layout renders one page per tag, one directory down", async () => {
  const template = await plainWith({
    "layouts/tag.html": "{{> head}}<h1>{{tag.name}} ({{tag.count}})</h1>" +
      "<ul>{{#each posts}}<li>{{url}}</li>{{/each}}</ul><a href=\"{{site.homeUrl}}\">home</a>{{> footer}}",
  }, { layouts: { tag: "layouts/tag.html" } });
  const { files } = renderSite({ template, site, records: RECORDS });
  assert.match(files["tags/red.html"], /<h1>Red \(2\)<\/h1><ul><li>\.\.\/c\.html<\/li><li>\.\.\/b\.html<\/li><\/ul>/);
  assert.match(files["tags/red.html"], /href="\.\.\/index\.html"/);
  assert.match(files["tags/blue-moon.html"], /<li>\.\.\/a\.html<\/li>/);
  // Under a preview the base is already absolute, and is used as is.
  const prev = renderSite({ template, site, records: RECORDS, base: "/p/tok/" }).files;
  assert.match(prev["tags/red.html"], /<li>\/p\/tok\/c\.html<\/li>/);
});

test("the archive layout renders archive.html; without it there is no such file", async () => {
  const withArchive = await plainWith({
    "layouts/archive.html": "{{> head}}<ol>{{#each posts}}<li>{{title}}</li>{{/each}}</ol>{{> footer}}",
  }, { layouts: { archive: "layouts/archive.html" } });
  const { files } = renderSite({ template: withArchive, site, records: RECORDS });
  assert.match(files["archive.html"], /<ol><li>C<\/li><li>B<\/li><li>A<\/li><\/ol>/);
  const plain = renderSite({ template: await plainWith(), site, records: RECORDS }).files;
  assert.equal(plain["archive.html"], undefined);
  assert.equal(Object.keys(plain).some((k) => k.startsWith("tags/")), false);
});

test("archive and tags are reserved slugs", () => {
  for (const slug of ["archive", "tags"]) {
    const rec = normalizeContent({ type: "page", slug, title: "x", status: "published" });
    assert.ok(validateContent(rec).some((p) => p.includes("reserved")), slug);
  }
});

// ------------------------------------------------------------ thumbnails
test("an explicit thumb is kept, and thumbUrl falls back to the full image", async () => {
  const rec = normalizeContent({
    type: "gallery", slug: "g", title: "G", date: "2026-01-01", status: "published",
    images: [{ url: "/i/a.webp", thumb: "/i/thumbs/a.webp" }, { url: "/i/b.webp" }],
  });
  assert.equal(rec.images[0].thumb, "/i/thumbs/a.webp");
  assert.equal(rec.images[1].thumb, "");
  const template = await plainWith({
    "layouts/article.html": "{{> head}}{{#each post.images}}[{{thumbUrl}}]{{/each}}{{> footer}}",
  });
  const { files } = renderSite({ template, site, records: [rec] });
  assert.match(files["g.html"], /\[i\/thumbs\/a\.webp\]\[i\/b\.webp\]/);
});

test("a console upload's -thumb rendition is found from the body", () => {
  const { images } = extractImages(
    '<p><img src="/media/1-cat.webp"></p><p><img src="/elsewhere/x.png" data-thumb="/elsewhere/x-small.png"></p>' +
    '<p><img src="/media/2-dog-thumb.webp"></p>');
  assert.deepEqual(images.map((i) => i.thumb), ["/media/1-cat-thumb.webp", "/elsewhere/x-small.png", ""]);
});

// ------------------------------------------------------------ articles.json
test("articles.json carries each post's images and the site's tags", async () => {
  const rec = normalizeContent({
    type: "gallery", slug: "g", title: "G", date: "2026-04-04", status: "published", tags: ["Red"],
    images: [{ url: "/i/a.webp", thumb: "/i/t/a.webp", width: 10, height: 20, caption: "cap" }],
  });
  const { files } = renderSite({ template: await plainWith(), site, records: [rec, ...RECORDS] });
  const manifest = JSON.parse(files["articles.json"]);
  assert.deepEqual(manifest.posts[0].images, [
    { url: "i/a.webp", thumbUrl: "i/t/a.webp", width: 10, height: 20, alt: "", caption: "cap" },
  ]);
  assert.deepEqual(manifest.posts[1].images, []);
  assert.deepEqual(manifest.tags.map((t) => [t.name, t.count]), [["Red", 3], ["Blue", 1], ["Blue Moon", 1]]);
});

// ------------------------------------------------------------ template scripts
test("a template's own script ships as an asset and arrives through template.scripts", async () => {
  const template = await plainWith({ "assets/site.js": "console.log('hi')" }, { scripts: ["assets/site.js"] });
  const { files } = renderSite({ template, site, records: RECORDS });
  assert.equal(files["assets/site.js"], "console.log('hi')");
  assert.match(files["index.html"], /<script src="assets\/site\.js" defer><\/script>/);
  // ...and the validator still refuses a script the markup names itself.
  const bad = { ...template.sources, "layouts/index.html": '{{> head}}<script src="assets/site.js"></script>{{> footer}}' };
  assert.equal(validateTemplate(bad).ok, false);
});

// ------------------------------------------------------------ inline images
test("bodyImages reads an article's inline pictures without moving them", async () => {
  const rec = post("p", "2026-05-05", {
    body: '<p>one</p><figure><img src="/i/a.webp" data-thumb="/i/t/a.webp" width="4" height="3"></figure>' +
      '<p>two</p><img src="https://elsewhere.test/x.jpg">',
  });
  const template = await plainWith({
    "layouts/article.html": "{{> head}}{{#each post.bodyImages}}[{{url}}|{{thumbUrl}}]{{/each}}" +
      "<div>{{{post.bodyHtml}}}</div>{{> footer}}",
  });
  const { files } = renderSite({ template, site, records: [rec] });
  assert.match(files["p.html"], /\[i\/a\.webp\|i\/t\/a\.webp\]\[https:\/\/elsewhere\.test\/x\.jpg\|https:\/\/elsewhere\.test\/x\.jpg\]/);
  // the body itself is untouched, and an article still has no `images`
  assert.match(files["p.html"], /<p>one<\/p><figure><img src="\/i\/a\.webp"/);
  assert.deepEqual(rec.images, []);
  const manifest = JSON.parse(files["articles.json"]);
  assert.deepEqual(manifest.posts[0].images.map((i) => i.thumbUrl), ["i/t/a.webp", "https://elsewhere.test/x.jpg"]);
});

test("tagRefs link each of a post's tags to its tag page", async () => {
  const template = await plainWith({
    "layouts/article.html": "{{> head}}{{#each post.tagRefs}}<a href=\"{{url}}\">{{name}}</a>{{/each}}{{> footer}}",
  });
  const { files } = renderSite({ template, site, records: RECORDS });
  assert.match(files["c.html"], /<a href="tags\/red\.html">Red<\/a><a href="tags\/blue\.html">Blue<\/a>/);
});

test("the validator types a loop inside a context partial by its item, then the context", () => {
  // {{#each bodyImages}} inside a `post` partial: thumbUrl is the image's,
  // title falls back to the post's -- the engine's own lookup order.
  assert.ok(resolveViewPath("index", "thumbUrl", { scope: "bodyImages[]", scopeType: "post" }).ok);
  assert.ok(resolveViewPath("index", "title", { scope: "bodyImages[]", scopeType: "post" }).ok);
  assert.ok(resolveViewPath("index", "name", { scope: "tagRefs[]", scopeType: "post" }).ok);
  assert.ok(!resolveViewPath("index", "nope", { scope: "bodyImages[]", scopeType: "post" }).ok);
});

// ------------------------------------------------------------ the console list
test("a summary carries the list fields, drafts included, never the body", async () => {
  const { summarizeContent, compareSummaries } = await import("../shared/content.mjs");
  const draft = normalizeContent({ type: "article", slug: "d", title: "Draft", date: "2026-06-06", body: "<p>long</p>" });
  const s = summarizeContent(draft);
  assert.equal(s.status, "draft");
  assert.equal("body" in s, false);
  assert.deepEqual(s.tags, []);
  assert.deepEqual(summarizeContent(normalizeContent({ type: "article", slug: "t", title: "T", tags: ["Wife", "Explicit"] })).tags,
    ["Wife", "Explicit"]);
  const page = summarizeContent(normalizeContent({ type: "page", slug: "about", title: "About", status: "published" }));
  const list = [page, summarizeContent(RECORDS[2]), s, summarizeContent(RECORDS[0])].sort(compareSummaries);
  assert.deepEqual(list.map((x) => x.slug), ["d", "c", "a", "about"]);
});

// ------------------------------------------------------------ white label
test("platformAssets: false ships nothing of the platform's own", async () => {
  const template = await plainWith({ "assets/site.js": "1" }, { scripts: ["assets/site.js"], platformAssets: false });
  const { files } = renderSite({ template, site, records: RECORDS });
  for (const gone of ["assets/search.js", "assets/gallery.js", "assets/favicon.svg", "favicon.ico"]) {
    assert.equal(files[gone], undefined, gone);
  }
  assert.doesNotMatch(files["assets/theme.css"], /Generated|cli\/build/);
  assert.match(files["index.html"], /<script src="assets\/site\.js" defer><\/script>/);
  assert.doesNotMatch(files["index.html"], /search\.js|gallery\.js/);
  // The default is unchanged.
  const normal = renderSite({ template: await plainWith(), site, records: RECORDS }).files;
  assert.ok(normal["assets/search.js"] && normal["assets/gallery.js"] && normal["favicon.ico"]);
  assert.match(normal["assets/theme.css"], /^\/\* Generated/);
});

test("platformAssets must be a boolean", () => {
  assert.ok(checkManifest({ ...JSON.parse('{"id":"x","name":"x","version":"1.0.0","engine":"quickieweb-template@1","supports":["page"],"layouts":{}}'), platformAssets: "no" })
    .problems.some((p) => p.includes("platformAssets")));
});

test("mirror distributions survive normalization; junk ids do not", async () => {
  const { normalizeStorage } = await import("../shared/site.mjs");
  const st = normalizeStorage({ driver: "prefix", prefix: "sites/a", mirrorDistributionIds: ["E1IVLQSMM1AGFH", "../x", 7] });
  assert.deepEqual(st.mirrorDistributionIds, ["E1IVLQSMM1AGFH"]);
  assert.deepEqual(normalizeStorage({}).mirrorDistributionIds, []);
});

// ------------------------------------------------------------ custom-domain mirrors
test("a mirror may read its own site's prefix and nothing else", async () => {
  const { withMirrors } = await import("../infra/lib/mirror-policy.mjs");
  const tpl = JSON.parse((await readFile(path.join(ROOT, "infra", "iam", "tenant-live-bucket-policy.json"), "utf8"))
    .replaceAll("__BUCKET__", "live").replaceAll("__ACCOUNT__", "111").replaceAll("__DISTRIBUTION__", "SHARED1234"));
  const doc = withMirrors(tpl, { bucket: "live", account: "111", mirrors: [{ distributionId: "MIRROR1234", prefix: "sites/acme/" }] });
  const allow = doc.Statement.find((s) => s.Sid === "MirrorReadMIRROR1234");
  assert.equal(allow.Resource, "arn:aws:s3:::live/sites/acme/*");
  assert.equal(allow.Condition.StringEquals["AWS:SourceArn"], "arn:aws:cloudfront::111:distribution/MIRROR1234");
  const deny = doc.Statement.find((s) => s.Sid === "DenyAnonymousAndCrossAccount");
  assert.deepEqual(deny.Condition.StringNotEquals["aws:SourceArn"], [
    "arn:aws:cloudfront::111:distribution/SHARED1234", "arn:aws:cloudfront::111:distribution/MIRROR1234"]);
  // The shared grant is untouched, and the template document itself is not mutated.
  assert.equal(doc.Statement.find((s) => s.Sid === "ReadOnlyFromOurDistribution").Resource, "arn:aws:s3:::live/*");
  assert.equal(tpl.Statement.length, 3);
  // A prefix that would open the whole bucket is refused.
  for (const prefix of ["", "sites/", "/", "sites/acme", "../", "sites/a/b/"]) {
    assert.throws(() => withMirrors(tpl, { bucket: "live", account: "111", mirrors: [{ distributionId: "MIRROR1234", prefix }] }), /prefix/, prefix);
  }
});
