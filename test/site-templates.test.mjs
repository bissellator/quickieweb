// Site-private templates: upload, versioning, isolation.
//
//   node --test test/site-templates.test.mjs
//
// The property that matters most here is that one site's private template can
// never be handed to another. Two sites may hold the same id at the same
// version, and the loader caches inside a warm Lambda container, so the cache
// key is the whole defence.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  siteReader, loadFromReader, putSiteTemplate, listSiteTemplates, removeSiteTemplate,
  nextVersionFor, SITE_TEMPLATE_PREFIX, TemplateRejected, TemplateNotFound,
} from "../shared/template/library.mjs";
import { normalizeSite } from "../shared/site.mjs";

// The admin binds this to a per-site cache key; here the reader supplies it.
const loadSite = (store, siteId, id, cache = null) =>
  loadFromReader(siteReader(store, siteId), { id }, cache);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** An in-memory stand-in for one site's store, with the same surface. */
function fakeStore() {
  const objects = new Map();
  return {
    objects,
    async putText(key, body) { objects.set(key, body); },
    async getText(key) { return objects.has(key) ? objects.get(key) : null; },
    async remove(key) { objects.delete(key); },
    async list(prefix = "") {
      return [...objects.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => ({ key: k, size: objects.get(k).length }));
    },
  };
}

async function plainSources(over = {}) {
  const dir = path.join(ROOT, "templates", "plain");
  const manifestText = await readFile(path.join(dir, "template.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  const sources = {};
  for (const rel of [
    ...Object.values(manifest.layouts ?? {}),
    ...Object.values(manifest.partials ?? {}).map((p) => (typeof p === "string" ? p : p.path)),
    ...(manifest.styles ?? []),
  ]) sources[rel] = await readFile(path.join(dir, rel), "utf8");
  sources["template.json"] = JSON.stringify({ ...manifest, id: "mytheme", ...over });
  return sources;
}

// ------------------------------------------------------------------ storage
test("an uploaded template lands under _internal/, where publish cannot reach it", async () => {
  const store = fakeStore();
  const { id, version } = await putSiteTemplate(store, await plainSources());

  assert.equal(id, "mytheme");
  assert.equal(version, "1.0.0");
  const keys = [...store.objects.keys()];
  assert.ok(keys.length > 3);
  // SKIP_PREFIXES in admin/lib/store.mjs excludes `_internal/` from both sides
  // of computeChangeset, so this location is what makes a private template
  // source rather than output.
  for (const k of keys) assert.ok(k.startsWith(SITE_TEMPLATE_PREFIX), k);
  assert.ok(keys.includes(`${SITE_TEMPLATE_PREFIX}mytheme/1.0.0/template.json`));
});

test("every upload is a new immutable version", async () => {
  const store = fakeStore();
  assert.equal(await nextVersionFor(store, "mytheme"), "1.0.0");
  assert.equal((await putSiteTemplate(store, await plainSources())).version, "1.0.0");
  assert.equal((await putSiteTemplate(store, await plainSources())).version, "1.0.1");
  assert.equal((await putSiteTemplate(store, await plainSources())).version, "1.0.2");
  // The old bytes are still there to roll back to.
  assert.ok(store.objects.has(`${SITE_TEMPLATE_PREFIX}mytheme/1.0.0/template.json`));
});

test("the stored manifest carries the version the platform assigned", async () => {
  const store = fakeStore();
  // Whatever the author put in template.json, twice.
  await putSiteTemplate(store, await plainSources({ version: "9.9.9" }));
  const { version } = await putSiteTemplate(store, await plainSources({ version: "9.9.9" }));
  assert.equal(version, "1.0.1");
  const stored = JSON.parse(store.objects.get(`${SITE_TEMPLATE_PREFIX}mytheme/1.0.1/template.json`));
  assert.equal(stored.version, "1.0.1", "the manifest must agree with its own prefix");
});

// --------------------------------------------------------------- validation
test("a template that fails validation is refused, with the findings", async () => {
  const store = fakeStore();
  const sources = await plainSources();
  sources["layouts/article.html"] = '<script>alert(1)</script>{{post.title}}';

  await assert.rejects(
    () => putSiteTemplate(store, sources),
    (err) => {
      assert.ok(err instanceof TemplateRejected);
      assert.equal(err.status, 400);
      assert.ok(err.findings.some((f) => f.level === "error"));
      return true;
    });
  // Nothing half-written: a rejected package must not leave a version behind.
  assert.equal(store.objects.size, 0);
});

test("a typo in a field path is refused too, not published as a blank", async () => {
  const store = fakeStore();
  const sources = await plainSources();
  sources["layouts/article.html"] = "{{> head}}<h1>{{post.titel}}</h1>{{> footer}}";
  await assert.rejects(() => putSiteTemplate(store, sources), TemplateRejected);
});

test("a package with no template.json is refused", async () => {
  await assert.rejects(() => putSiteTemplate(fakeStore(), { "layouts/index.html": "x" }),
    TemplateRejected);
});

// ---------------------------------------------------------------- isolation
test("two sites can hold the same id at the same version, and never see each other's", async () => {
  const acme = fakeStore();
  const beta = fakeStore();

  await putSiteTemplate(acme, await plainSources({ name: "ACME Theme" }));
  await putSiteTemplate(beta, await plainSources({ name: "Beta Theme" }));

  // One shared cache, exactly as a warm Lambda container has.
  const cache = new Map();
  const forAcme = await loadSite(acme, "acme", "mytheme", cache);
  const forBeta = await loadSite(beta, "beta", "mytheme", cache);
  assert.equal(cache.size, 2, "two sites, two entries -- not one shared by id@version");

  assert.equal(forAcme.version, "1.0.0");
  assert.equal(forBeta.version, "1.0.0");
  // Same id, same version, different bytes. Loaded second, so if the cache were
  // keyed on id@version alone this would come back as ACME's.
  assert.equal(forAcme.manifest.name, "ACME Theme");
  assert.equal(forBeta.manifest.name, "Beta Theme");
});

test("loading an id this site never uploaded fails rather than reaching elsewhere", async () => {
  await assert.rejects(() => loadSite(fakeStore(), "acme", "mytheme"), TemplateNotFound);
});

test("an unknown scope resolves to the library, never to another shelf", () => {
  const site = normalizeSite({ siteId: "acme", site: { name: "A" }, template: { id: "x", scope: "elsewhere" } });
  assert.equal(site.template.scope, "library");
  assert.equal(normalizeSite({ siteId: "a", site: { name: "A" } }).template.scope, "library");
  assert.equal(
    normalizeSite({ siteId: "a", site: { name: "A" }, template: { id: "x", scope: "site" } }).template.scope,
    "site");
});

// ------------------------------------------------------------------ listing
test("listing reports each id once, newest version first", async () => {
  const store = fakeStore();
  await putSiteTemplate(store, await plainSources());
  await putSiteTemplate(store, await plainSources());
  await putSiteTemplate(store, await plainSources({ id: "other" }));

  const list = await listSiteTemplates(store);
  assert.deepEqual(list.map((t) => t.id), ["mytheme", "other"]);
  const mine = list.find((t) => t.id === "mytheme");
  assert.equal(mine.latest, "1.0.1");
  assert.deepEqual(mine.versions, ["1.0.1", "1.0.0"]);
  assert.equal(mine.scope, "site");
});

test("deleting removes every object of a template, or just one version", async () => {
  const store = fakeStore();
  await putSiteTemplate(store, await plainSources());
  await putSiteTemplate(store, await plainSources());

  await removeSiteTemplate(store, "mytheme", "1.0.0");
  assert.deepEqual((await listSiteTemplates(store)).map((t) => t.latest), ["1.0.1"]);

  await removeSiteTemplate(store, "mytheme");
  assert.deepEqual(await listSiteTemplates(store), []);
  await assert.rejects(() => removeSiteTemplate(store, "mytheme"), TemplateNotFound);
});

// --------------------------------------------------------------- it renders
test("an uploaded template actually renders a site", async () => {
  const { renderSite } = await import("../shared/render.mjs");
  const { normalizeContent } = await import("../shared/content.mjs");

  const store = fakeStore();
  await putSiteTemplate(store, await plainSources({ name: "Mine" }));
  const template = await loadSite(store, "acme", "mytheme");

  const { files } = renderSite({
    template,
    site: { name: "ACME", baseUrl: "https://acme.test" },
    records: [normalizeContent({
      type: "article", slug: "2026-01-01-x", date: "2026-01-01",
      status: "published", title: "Hello", dek: "d", body: "<p>x</p>",
    })],
  });
  assert.match(files["index.html"], /Hello/);
  assert.match(files["2026-01-01-x.html"], /<\/body>/);
});
