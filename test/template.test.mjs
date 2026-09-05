// The template engine, the token layer, the content model and the validator.
//
//   node --test test/template.test.mjs
//
// The engine tests lean on the security properties, because those are the ones
// that must not regress quietly: a template is untrusted input rendered in a
// process that serves every tenant.

import test from "node:test";
import assert from "node:assert/strict";

import { compile, render, usedPaths, usedPartials, TemplateError } from "../shared/template/engine.mjs";
import { resolveTokens, tokensToCss, tokenForm, validateTokenValue, cssVarName } from "../shared/template/tokens.mjs";
import { checkManifest, compileTemplate } from "../shared/template/manifest.mjs";
import { resolveViewPath, nestTokens, buildNav } from "../shared/template/viewmodel.mjs";
import { normalizeContent, validateContent, sortContent } from "../shared/content.mjs";
import { normalizeSite, validateSite, keyFor, unkeyFor, roleInSite, validateMemberChange } from "../shared/site.mjs";
import { validateTemplate } from "../shared/template/validate.mjs";

const run = (src, data, partials = {}) =>
  render(compile(src, "t"), data, { partials, template: "t" });

// ------------------------------------------------------------------ engine
test("interpolation escapes by default", () => {
  assert.equal(run("{{x}}", { x: `<img src=x onerror="alert(1)">` }),
    "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  assert.equal(run("{{x}}", { x: "a & b" }), "a &amp; b");
  assert.equal(run("{{x}}", { x: "it's" }), "it&#39;s");
});

test("triple braces do not escape", () => {
  assert.equal(run("{{{x}}}", { x: "<em>ok</em>" }), "<em>ok</em>");
});

test("a missing path renders empty, not undefined", () => {
  assert.equal(run("[{{nope}}]", {}), "[]");
  assert.equal(run("[{{a.b.c}}]", { a: {} }), "[]");
});

test("dotted paths walk objects", () => {
  assert.equal(run("{{a.b.c}}", { a: { b: { c: "deep" } } }), "deep");
});

test("#if honours the documented falsiness", () => {
  const t = "{{#if v}}yes{{else}}no{{/if}}";
  for (const v of [undefined, null, false, "", 0, []]) {
    assert.equal(run(t, { v }), "no", `${JSON.stringify(v)} should be falsy`);
  }
  for (const v of [true, 1, "x", [1], {}]) {
    assert.equal(run(t, { v }), "yes", `${JSON.stringify(v)} should be truthy`);
  }
});

test("#unless inverts #if", () => {
  assert.equal(run("{{#unless v}}none{{/unless}}", { v: [] }), "none");
  assert.equal(run("{{#unless v}}none{{/unless}}", { v: ["a"] }), "");
});

test("#each iterates, with loop metadata and an else branch", () => {
  assert.equal(run("{{#each xs}}{{@number}}:{{.}} {{/each}}", { xs: ["a", "b"] }), "1:a 2:b ");
  assert.equal(run("{{#each xs}}{{#if @first}}F{{/if}}{{#if @last}}L{{/if}}{{/each}}", { xs: [1, 2] }), "FL");
  assert.equal(run("{{#each xs}}x{{else}}empty{{/each}}", { xs: [] }), "empty");
  assert.equal(run("{{#each xs}}x{{else}}empty{{/each}}", { xs: null }), "empty");
});

test("a loop body can still reach the outer context", () => {
  assert.equal(run("{{#each xs}}{{site.name}}-{{n}} {{/each}}",
    { site: { name: "S" }, xs: [{ n: 1 }, { n: 2 }] }), "S-1 S-2 ");
});

test("partials render against the current context", () => {
  const partials = { card: compile("[{{n}}]", "card") };
  assert.equal(run("{{#each xs}}{{> card}}{{/each}}", { xs: [{ n: 1 }, { n: 2 }] }, partials), "[1][2]");
});

test("a self-including partial is stopped rather than blowing the stack", () => {
  const partials = {};
  partials.loop = compile("{{> loop}}", "loop");
  assert.throws(() => run("{{> loop}}", {}, partials), /includes itself/);
});

test("an undeclared partial is an error, not a blank", () => {
  assert.throws(() => run("{{> nope}}", {}), /No partial named "nope"/);
});

test("syntax errors carry a line number", () => {
  const err = (src) => {
    try { compile(src, "f.html"); return null; } catch (e) { return e; }
  };
  assert.match(err("a\nb\n{{#if x}}").message, /f\.html:3.*Unclosed/);
  assert.match(err("{{#if x}}{{/each}}").message, /Expected \{\{\/if\}\}/);
  assert.match(err("{{/if}}").message, /no open block/);
  assert.match(err("{{#nope x}}{{/nope}}").message, /Only #if, #unless and #each/);
  assert.match(err("{{^x}}{{\/x}}").message, /not supported.*#unless/);
  assert.match(err("{{#if}}{{/if}}").message, /needs a path/);
  assert.ok(err("a\nb\nc") === null);
});

test("the engine has no expression or helper surface", () => {
  // Anything that looks like a call is a path, and paths never resolve to
  // functions being invoked. This is the property that makes an uploaded
  // template safe to render.
  assert.equal(run("{{constructor}}", {}), "");
  assert.equal(run("{{__proto__.x}}", {}), "");
  assert.equal(run("{{toString}}", {}), "");
  assert.throws(() => compile("{{#if (eq a b)}}{{/if}}", "t"), /takes one path and no arguments/);
});

test("inherited properties are not reachable", () => {
  // hasOwn, not `in`: otherwise {{constructor}} on a plain object walks the
  // prototype chain and a template can read engine internals.
  class Thing { constructor() { this.own = "yes"; } }
  Thing.prototype.inherited = "leak";
  assert.equal(run("{{own}}|{{inherited}}", new Thing()), "yes|");
});

test("comments produce nothing", () => {
  assert.equal(run("a{{! nothing to see }}b", {}), "ab");
});

// ------------------------------------------------------------ static analysis
test("usedPaths reports scope so a loop body can be checked", () => {
  const paths = usedPaths(compile("{{site.name}}{{#each posts}}{{title}}{{/each}}", "t"));
  assert.deepEqual(paths.map((p) => [p.path, p.scope]), [
    ["site.name", ""],
    ["posts", ""],
    ["title", "posts[]"],
  ]);
});

test("usedPaths ignores loop metadata and the current item", () => {
  const paths = usedPaths(compile("{{#each xs}}{{@index}}{{.}}{{#if @last}}x{{/if}}{{/each}}", "t"));
  assert.deepEqual(paths.map((p) => p.path), ["xs"]);
});

test("usedPartials finds every include", () => {
  const found = usedPartials(compile("{{> a}}{{#if x}}{{> b}}{{else}}{{> c}}{{/if}}", "t"));
  assert.deepEqual(found.map((p) => p.name), ["a", "b", "c"]);
});

// -------------------------------------------------------------- view model
test("resolveViewPath accepts real fields and rejects typos", () => {
  assert.ok(resolveViewPath("article", "post.title").ok);
  assert.ok(resolveViewPath("article", "post.source.publisher").ok);
  assert.ok(resolveViewPath("index", "site.name").ok);

  const bad = resolveViewPath("article", "post.headline");
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /no field "headline"/);
  assert.ok(bad.known.includes("post.title"), "suggests the real field");
});

test("a root belongs only to the layout that has it", () => {
  assert.ok(resolveViewPath("article", "post.title").ok);
  assert.equal(resolveViewPath("index", "post.title").ok, false);
  assert.ok(resolveViewPath("page", "page.title").ok);
  assert.equal(resolveViewPath("404", "page.title").ok, false);
});

test("a list must be iterated before its fields are read", () => {
  const res = resolveViewPath("index", "posts.title");
  assert.equal(res.ok, false);
  assert.match(res.reason, /is a list -- iterate it/);
});

test("scope lets a loop body read bare fields", () => {
  assert.ok(resolveViewPath("index", "title", { scope: "posts[]" }).ok);
  assert.equal(resolveViewPath("index", "title").ok, false);
  // and the outer context is still reachable from inside
  assert.ok(resolveViewPath("index", "site.name", { scope: "posts[]" }).ok);
});

test("theme paths are checked against the template's own tokens", () => {
  const keys = ["color.ink", "logo"];
  assert.ok(resolveViewPath("index", "theme.color.ink", { tokenKeys: keys }).ok);
  assert.ok(resolveViewPath("index", "theme.logo", { tokenKeys: keys }).ok);
  const bad = resolveViewPath("index", "theme.color.nope", { tokenKeys: keys });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /declares no token/);
});

test("nestTokens turns dotted keys into objects", () => {
  assert.deepEqual(nestTokens({ "color.ink": "#111", "logo": "/a.png" }),
    { color: { ink: "#111" }, logo: "/a.png" });
});

test("nav merges configured links with pages that opted in", () => {
  const nav = buildNav(
    { nav: [{ label: "Home", href: "/" }] },
    [{ slug: "about", nav: { label: "About", order: 2 } },
     { slug: "contact", nav: { label: "Contact", order: 1 } },
     { slug: "hidden", nav: null }],
    "/about.html");
  assert.deepEqual(nav.map((n) => n.label), ["Home", "Contact", "About"]);
  assert.equal(nav.find((n) => n.label === "About").current, true);
  assert.ok(!nav.some((n) => n.href === "/hidden.html"));
});

// ------------------------------------------------------------------ tokens
test("token values are validated by type", () => {
  assert.equal(validateTokenValue({ type: "color" }, "#fff"), null);
  assert.equal(validateTokenValue({ type: "color" }, "rgb(1,2,3)"), null);
  assert.ok(validateTokenValue({ type: "color" }, "red; } body { display:none"));
  assert.equal(validateTokenValue({ type: "image" }, "/media/logo.webp"), null);
  assert.ok(validateTokenValue({ type: "image" }, "javascript:alert(1)"));
  assert.ok(validateTokenValue({ type: "number", min: 1 }, 0));
  assert.equal(validateTokenValue({ type: "select", options: ["a", "b"] }, "a"), null);
  assert.ok(validateTokenValue({ type: "select", options: ["a"] }, "z"));
});

test("resolveTokens fills defaults and rejects bad overrides loudly", () => {
  const manifest = { id: "t", tokens: {
    "color.ink": { type: "color", default: "#000" },
    "logo": { type: "image", optional: true },
  } };

  const clean = resolveTokens(manifest, { "color.ink": "#fff" });
  assert.equal(clean.theme["color.ink"], "#fff");
  assert.deepEqual(clean.warnings, []);

  const dirty = resolveTokens(manifest, { "color.ink": "}{evil", "nope": 1 });
  assert.equal(dirty.theme["color.ink"], "#000", "falls back to the default");
  assert.equal(dirty.warnings.length, 2);
  assert.ok(dirty.warnings.some((w) => w.includes("not a token")));
});

test("token CSS cannot break out of the rule", () => {
  const manifest = { id: "t", tokens: { "color.ink": { type: "color", default: "#000" } } };
  // A value that got past validation still cannot close the block.
  const css = tokensToCss(manifest, { "color.ink": "#fff} body{display:none" });
  assert.ok(!css.includes("body{display:none"), css);
  assert.ok(!/\}\s*body/.test(css));
});

test("cssVarName flattens dots and underscores alike", () => {
  assert.equal(cssVarName("color.ink_soft"), "--color-ink-soft");
  assert.equal(cssVarName("logo"), "--logo");
});

test("an image token gets both a bare and a url() variable", () => {
  const manifest = { id: "t", tokens: { logo: { type: "image", optional: true } } };
  const css = tokensToCss(manifest, { logo: "/media/logo.webp" });
  assert.match(css, /--logo: \/media\/logo\.webp;/);
  assert.match(css, /--logo-url: url\("\/media\/logo\.webp"\);/);
});

test("tokenForm groups fields for the admin", () => {
  const manifest = { id: "t", tokens: {
    "color.ink": { type: "color", default: "#000", group: "Color", label: "Ink" },
    "font.body": { type: "font", default: "serif", group: "Type" },
  } };
  const form = tokenForm(manifest, { "color.ink": "#fff" });
  assert.deepEqual(form.map((g) => g.group), ["Color", "Type"]);
  assert.equal(form[0].fields[0].value, "#fff");
  assert.equal(form[1].fields[0].value, "serif");
});

// ---------------------------------------------------------------- manifest
test("a good manifest passes and is normalized", () => {
  const { manifest, problems } = checkManifest({
    id: "good-id", name: "X", version: "1.0.0", engine: "quickieweb-template@1",
    layouts: { index: "l/i.html", article: "l/a.html", page: "l/p.html", 404: "l/4.html" },
    partials: { head: "p/h.html", card: { path: "p/c.html", context: "post" } },
    tokens: { "color.ink": { type: "color", default: "#000" } },
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(manifest.partials.head, { path: "p/h.html", context: null });
  assert.equal(manifest.partials.card.context, "post");
});

test("a manifest reports every problem at once", () => {
  const { problems } = checkManifest({ id: "X!", version: "1", engine: "nope" });
  assert.ok(problems.length >= 4, problems.join("\n"));
  assert.ok(problems.some((p) => p.includes('"engine"')));
  assert.ok(problems.some((p) => p.includes("layouts.index")));
});

test("package paths cannot escape the template", () => {
  const bad = (p) => checkManifest({
    id: "x", name: "X", version: "1.0.0", engine: "quickieweb-template@1",
    layouts: { index: p, article: "a.html", page: "p.html", 404: "4.html" },
  }).problems;
  assert.ok(bad("../../etc/passwd").some((m) => m.includes("safe package path")));
  assert.ok(bad("/etc/passwd").some((m) => m.includes("safe package path")));
});

test("a token key cannot be a prefix of another", () => {
  const { problems } = checkManifest({
    id: "x", name: "X", version: "1.0.0", engine: "quickieweb-template@1",
    layouts: { index: "i.html", article: "a.html", page: "p.html", 404: "4.html" },
    tokens: { color: { type: "text", default: "" }, "color.ink": { type: "color", default: "#000" } },
  });
  assert.ok(problems.some((p) => p.includes("is a prefix of")), problems.join("\n"));
});

test("a template must support pages", () => {
  const { problems } = checkManifest({
    id: "x", name: "X", version: "1.0.0", engine: "quickieweb-template@1",
    layouts: { index: "i.html", article: "a.html", page: "p.html", 404: "4.html" },
    supports: ["article"],
  });
  assert.ok(problems.some((p) => p.includes("static pages are a platform feature")));
});

// ----------------------------------------------------------------- content
test("normalizeContent fills defaults and accepts the legacy headline field", () => {
  const r = normalizeContent({ headline: "Legacy", date: "2026-01-01", templateType: "podcast" });
  assert.equal(r.title, "Legacy");
  assert.equal(r.type, "podcast");
  assert.equal(r.status, "draft");
  assert.equal(r.slug, "2026-01-01-legacy");
});

test("a page has no date and may claim a nav slot", () => {
  const r = normalizeContent({ type: "page", title: "About", nav: { label: "About", order: 2 } });
  assert.equal(r.slug, "about");
  assert.equal(r.date, undefined);
  assert.deepEqual(r.nav, { label: "About", order: 2 });
});

test("an empty source is dropped rather than rendered as a blank card", () => {
  assert.equal(normalizeContent({ title: "x", source: { title: "", url: "" } }).source, null);
  assert.ok(normalizeContent({ title: "x", source: { url: "https://e.org" } }).source);
});

test("validateContent catches what would break a build", () => {
  assert.deepEqual(validateContent(normalizeContent({ title: "Fine", date: "2026-01-01" })), []);
  assert.ok(validateContent(normalizeContent({ title: "" })).some((p) => p.includes("title")));
  assert.ok(validateContent(normalizeContent({ type: "page", title: "Index", slug: "index" }))
    .some((p) => p.includes("reserved")));
  assert.ok(validateContent(normalizeContent({
    type: "podcast", title: "Ep", date: "2026-01-01", status: "published",
  })).some((p) => p.includes("audio")));
});

test("sortContent puts newest posts first and pages after them", () => {
  const records = [
    normalizeContent({ title: "Old", date: "2026-01-01" }),
    normalizeContent({ type: "page", title: "About" }),
    normalizeContent({ title: "New", date: "2026-02-01" }),
  ];
  assert.deepEqual(sortContent(records).map((r) => r.title), ["New", "Old", "About"]);
});

// -------------------------------------------------------------------- site
test("keyFor isolates a prefix tenant and unkeyFor reverses it", () => {
  const prefix = normalizeSite({ storage: { driver: "prefix", prefix: "sites/a" } }).storage;
  assert.equal(prefix.prefix, "sites/a/");
  assert.equal(keyFor(prefix, "index.html"), "sites/a/index.html");
  assert.equal(keyFor(prefix, "/index.html"), "sites/a/index.html");
  assert.equal(unkeyFor(prefix, "sites/a/index.html"), "index.html");
  // A key belonging to another tenant is not silently accepted as ours.
  assert.equal(unkeyFor(prefix, "sites/abc/index.html"), null);

  const buckets = normalizeSite({ storage: { driver: "buckets" } }).storage;
  assert.equal(keyFor(buckets, "index.html"), "index.html");
});

test("keyFor refuses traversal", () => {
  const prefix = normalizeSite({ storage: { driver: "prefix", prefix: "sites/a" } }).storage;
  assert.throws(() => keyFor(prefix, "../b/index.html"), /\.\./);
});

test("validateSite requires an owner and a real origin", () => {
  const ok = normalizeSite({
    siteId: "abcd", site: { name: "S", baseUrl: "https://e.com" },
    storage: { stagingBucket: "s", liveBucket: "l" },
    members: [{ email: "a@e.com", role: "owner" }],
  });
  assert.deepEqual(validateSite(ok), []);

  const noOwner = normalizeSite({ ...ok, members: [{ email: "a@e.com", role: "editor" }] });
  assert.ok(validateSite(noOwner).some((p) => p.includes("owner")));

  const badUrl = normalizeSite({ ...ok, site: { name: "S", baseUrl: "http://e.com/x" } });
  assert.ok(validateSite(badUrl).some((p) => p.includes("baseUrl")));
});

test("roleInSite is the whole visibility rule", () => {
  const site = normalizeSite({
    siteId: "abcd", site: { name: "S", baseUrl: "https://e.com" },
    members: [{ email: "Owner@E.com", role: "owner" }, { email: "ed@e.com", role: "editor" }],
  });
  assert.equal(roleInSite("owner@e.com", site), "owner", "case-insensitive");
  assert.equal(roleInSite("ed@e.com", site), "editor");
  assert.equal(roleInSite("stranger@e.com", site), null);
  assert.equal(roleInSite("", site), null);

  const suspended = { ...site, status: "suspended" };
  assert.equal(roleInSite("owner@e.com", suspended), null, "a suspended site grants nothing");
});

test("a site cannot be left without an owner", () => {
  assert.ok(validateMemberChange([{ email: "a@e.com", role: "editor" }], "a@e.com").length);
  assert.deepEqual(validateMemberChange([{ email: "a@e.com", role: "owner" }], "a@e.com"), []);
});

// --------------------------------------------------------------- validator
const MINIMAL = {
  "template.json": JSON.stringify({
    id: "tiny", name: "Tiny", version: "1.0.0", engine: "quickieweb-template@1",
    description: "d", license: "MIT",
    layouts: { index: "i.html", article: "a.html", page: "p.html", 404: "e.html" },
    partials: { head: "h.html" },
    tokens: { "color.ink": { type: "color", default: "#000" } },
  }),
  "h.html": "<!doctype html><html><head><title>{{seo.title}}</title></head><body>",
  "i.html": "{{> head}}{{#each posts}}{{title}}{{/each}}</body></html>",
  "a.html": "{{> head}}{{post.title}}{{{post.bodyHtml}}}</body></html>",
  "p.html": "{{> head}}{{page.title}}</body></html>",
  "e.html": "{{> head}}nope</body></html>",
};

test("a well-formed template validates clean", () => {
  const { ok, findings } = validateTemplate(MINIMAL);
  assert.equal(ok, true, JSON.stringify(findings, null, 2));
  assert.deepEqual(findings, []);
});

test("the validator catches a hallucinated field with a line number", () => {
  const { ok, findings } = validateTemplate({ ...MINIMAL, "a.html": "{{> head}}\n{{post.headline}}</body></html>" });
  assert.equal(ok, false);
  const f = findings.find((x) => x.message.includes("headline"));
  assert.equal(f.file, "a.html");
  assert.equal(f.line, 2);
  assert.match(f.message, /post has no field "headline"/);
});

test("the validator rejects an inline script tag", () => {
  const { ok, findings } = validateTemplate({
    ...MINIMAL, "i.html": '{{> head}}<script>alert(1)</script></body></html>',
  });
  assert.equal(ok, false);
  assert.ok(findings.some((f) => f.message.includes("Inline <script>")));
});

test("the validator rejects an external asset", () => {
  const { ok, findings } = validateTemplate({
    ...MINIMAL,
    "h.html": '<!doctype html><html><head><link rel="stylesheet" href="https://fonts.googleapis.com/x"></head><body>',
  });
  assert.equal(ok, false);
  assert.ok(findings.some((f) => f.message.includes("External asset")));
});

test("the validator rejects an undeclared partial", () => {
  const { ok, findings } = validateTemplate({ ...MINIMAL, "i.html": "{{> head}}{{> ghost}}</body></html>" });
  assert.equal(ok, false);
  assert.ok(findings.some((f) => f.message.includes('{{> ghost}} is not declared')));
});

test("the validator notices output that never opens <html>", () => {
  const { ok, findings } = validateTemplate({
    ...MINIMAL, "e.html": "just text", "h.html": "<!doctype html><html><head></head><body>",
  });
  assert.equal(ok, false);
  assert.ok(findings.some((f) => f.message.includes("<html>") || f.message.includes("</body>")));
});

test("a partial without a declared context may not read post fields", () => {
  const manifest = JSON.parse(MINIMAL["template.json"]);
  manifest.partials.card = "c.html";
  const bad = validateTemplate({
    ...MINIMAL, "template.json": JSON.stringify(manifest), "c.html": "{{title}}",
  });
  assert.equal(bad.ok, false);

  manifest.partials.card = { path: "c.html", context: "post" };
  const good = validateTemplate({
    ...MINIMAL, "template.json": JSON.stringify(manifest), "c.html": "{{title}}",
  });
  assert.equal(good.ok, true, JSON.stringify(good.findings, null, 2));
});

// -------------------------------------------------------------- relative URLs
//
// A rendered site must work unchanged at its own domain AND under an arbitrary
// base path. That is what lets an authenticated preview serve the same bytes
// from /api/preview/<token>/ without rewriting a thing.
const REL_TEMPLATE = (() => {
  const m = JSON.parse(MINIMAL["template.json"]);
  m.styles = ["s.css"];
  return {
    ...MINIMAL,
    "template.json": JSON.stringify(m),
    "s.css": "body{}",
    "h.html": '<!doctype html><html><head><title>{{seo.title}}</title>' +
      '<link rel="canonical" href="{{seo.canonical}}">' +
      '<link rel="icon" href="{{site.faviconUrl}}">' +
      '{{#each template.stylesheets}}<link rel="stylesheet" href="{{.}}">{{/each}}' +
      '</head><body><a id="home" href="{{site.homeUrl}}">home</a>' +
      '<a id="feed" href="{{site.feedUrl}}">rss</a>',
    "i.html": "{{> head}}{{#each posts}}<a class=p href=\"{{url}}\">{{title}}</a>{{/each}}" +
      "{{#each nav}}<a class=n href=\"{{href}}\">{{label}}</a>{{/each}}</body></html>",
    "e.html": '{{> head}}<a id="back" href="{{site.homeUrl}}">back</a></body></html>',
  };
})();

const renderWith = async (base) => {
  const { checkManifest, compileTemplate } = await import("../shared/template/manifest.mjs");
  const { renderSite } = await import("../shared/render.mjs");
  const { FIXTURE_SITE, FIXTURE_RECORDS } = await import("../shared/template/validate.mjs");
  const { manifest } = checkManifest(JSON.parse(REL_TEMPLATE["template.json"]));
  const pkg = compileTemplate(manifest, REL_TEMPLATE);
  return renderSite({ template: pkg, site: FIXTURE_SITE, records: FIXTURE_RECORDS, base });
};

test("with no base, every internal URL is relative", async () => {
  const { files } = await renderWith("");
  const index = files["index.html"];

  assert.match(index, /href="assets\/theme\.css"/, "stylesheet");
  assert.match(index, /href="assets\/favicon\.svg"/, "favicon");
  assert.match(index, /id="home" href="index\.html"/, "home link");
  assert.match(index, /id="feed" href="feed\.xml"/, "feed link");
  assert.match(index, /class=p href="2026-01-02-full\.html"/, "post link");
  assert.match(index, /class=n href="about\.html"/, "a page that put itself in the nav");

  // The thing that would break a preview: no root-absolute internal reference.
  const roots = [...index.matchAll(/(?:href|src)="(\/[^/"][^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(roots, [], `unexpected root-absolute links: ${roots.join(", ")}`);
});

test("under a base, the same render is servable from anywhere", async () => {
  const { files } = await renderWith("/api/preview/tok123/");
  const index = files["index.html"];

  assert.match(index, /href="\/api\/preview\/tok123\/assets\/theme\.css"/);
  assert.match(index, /id="home" href="\/api\/preview\/tok123\/index\.html"/);
  assert.match(index, /class=p href="\/api\/preview\/tok123\/2026-01-02-full\.html"/);
  assert.ok(!index.includes('href="/assets/'), "nothing escapes the preview prefix");
});

test("canonical and feed URLs stay absolute whatever the base", async () => {
  for (const base of ["", "/api/preview/tok/"]) {
    const { files } = await renderWith(base);
    assert.match(files["index.html"], /<link rel="canonical" href="https:\/\/example\.com/,
      `canonical must not be relativized (base ${JSON.stringify(base)})`);
    assert.match(files["feed.xml"], /<link>https:\/\/example\.com\/2026-01-02-full\.html<\/link>/,
      "a feed reader has no page to resolve a relative link against");
    assert.match(files["podcast.xml"], /url="https:\/\/example\.com\/media\/audio\/ep\.mp3"/,
      "nor does a podcast client");
  }
});

test("404.html is rendered against the root, not relatively", async () => {
  // CloudFront serves this body for ANY unmatched path -- /deep/missing included,
  // where a relative stylesheet would resolve to /deep/assets/ and arrive
  // unstyled. This is the one page that must not be relative.
  const { files } = await renderWith("");
  assert.match(files["404.html"], /href="\/assets\/theme\.css"/, "stylesheet from the root");
  assert.match(files["404.html"], /id="back" href="\/index\.html"/, "home link from the root");

  // Under a preview prefix the same reasoning gives the prefix, not "/".
  const preview = await renderWith("/api/preview/tok/");
  assert.match(preview.files["404.html"], /href="\/api\/preview\/tok\/assets\/theme\.css"/);
});

test("renderSite emits the COMPLETE file set, assets included", async () => {
  // The bug this guards: a template's stylesheet used to be copied into a site's
  // bucket as a separate step, so anything rendering without a bucket -- a
  // preview -- produced pages whose CSS 404ed. One source for the whole set.
  const { checkManifest, compileTemplate } = await import("../shared/template/manifest.mjs");
  const { renderSite } = await import("../shared/render.mjs");
  const { FIXTURE_SITE, FIXTURE_RECORDS } = await import("../shared/template/validate.mjs");

  const m = JSON.parse(MINIMAL["template.json"]);
  m.styles = ["s.css"];
  m.scripts = ["j.js"];
  const src = {
    ...MINIMAL,
    "template.json": JSON.stringify(m),
    "s.css": "body{color:red}",
    "j.js": "// hi",
    // A head that actually links its stylesheets, so the assertion below is
    // testing the real relationship rather than an empty list.
    "h.html": '<!doctype html><html><head><title>{{seo.title}}</title>' +
      '{{#each template.stylesheets}}<link rel="stylesheet" href="{{.}}">{{/each}}</head><body>',
  };
  const { manifest } = checkManifest(JSON.parse(src["template.json"]));
  const pkg = compileTemplate(manifest, src);
  pkg.sources = src;

  const { files } = renderSite({ template: pkg, site: FIXTURE_SITE, records: FIXTURE_RECORDS });
  assert.equal(files["assets/s.css"], "body{color:red}", "the template's stylesheet travels with the render");
  assert.equal(files["assets/j.js"], "// hi");
  assert.ok(files["assets/theme.css"], "and the generated token stylesheet");

  // Every stylesheet the head links must exist in the same set. This is the
  // assertion that would have caught the 404 directly.
  const linked = [...files["index.html"].matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((x) => x[1]);
  assert.ok(linked.length >= 2, "the fixture links theme.css and the template stylesheet");
  for (const href of linked) {
    assert.ok(files[href] !== undefined, `${href} is linked but not produced`);
  }
});

test("every site gets a favicon, so a fresh one is not 403ing on page one", async () => {
  const { checkManifest, compileTemplate } = await import("../shared/template/manifest.mjs");
  const { renderSite } = await import("../shared/render.mjs");
  const { FIXTURE_SITE } = await import("../shared/template/validate.mjs");
  const { manifest } = checkManifest(JSON.parse(MINIMAL["template.json"]));
  const pkg = compileTemplate(manifest, MINIMAL);
  pkg.sources = MINIMAL;

  const { files } = renderSite({
    template: pkg, site: { ...FIXTURE_SITE, name: "Zebra" }, records: [],
  });
  const icon = files["assets/favicon.svg"];
  assert.ok(icon, "a default favicon is generated");
  assert.match(icon, /^<svg /);
  assert.match(icon, />Z</, "the site's initial");
  // A site name is user input and lands inside an SVG served to readers.
  const hostile = renderSite({
    template: pkg, site: { ...FIXTURE_SITE, name: '<script>alert(1)</script>' }, records: [],
  }).files["assets/favicon.svg"];
  assert.ok(!hostile.includes("<script"), "the name is escaped into the mark");
});

test("only an interpolated script src is allowed", () => {
  // The blanket "no <script>" rule was right until something legitimate needed
  // one: `{{#each template.scripts}}` is how the platform's search client
  // reaches a page. The refined rule keeps "a template ships no JavaScript of
  // its own" true, because the URL comes from the view model, not the template.
  const head = (inner) => ({ ...MINIMAL, "h.html": `<!doctype html><html><head></head><body>${inner}` });

  const ok = validateTemplate(head('{{#each template.scripts}}<script src="{{.}}" defer></script>{{/each}}'));
  assert.equal(ok.ok, true, JSON.stringify(ok.findings));

  const refusals = {
    "inline body": "<script>alert(1)</script>",
    "literal src": '<script src="/evil.js"></script>',
    "interpolated src but an inline body": '<script src="{{template.scripts}}">alert(1)</script>',
    "self-closing literal": '<script src="/x.js"/>',
  };
  for (const [why, markup] of Object.entries(refusals)) {
    const res = validateTemplate(head(markup));
    assert.equal(res.ok, false, `${why} must be refused`);
    assert.ok(res.findings.some((f) => f.level === "error" && /script/i.test(f.message)),
      `${why} must be refused BY THE SCRIPT RULE, not incidentally`);
  }
});
