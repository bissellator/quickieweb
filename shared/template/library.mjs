// Where a template package lives, and how one is assembled from wherever that
// is. Pure: no filesystem, no S3, no network, no SDK.
//
// TWO SHELVES
//
//   library   s3://<platform>/templates/<id>/<version>/…
//             Shared by every site in the installation. Read-only to the admin.
//
//   site      <site staging>/_internal/templates/<id>/<version>/…
//             Uploaded by one site, stored in that site's own bucket, nameable
//             by nobody else. `_internal/` is in SKIP_PREFIXES, so the same
//             publish that cannot reach the shared library cannot reach these:
//             they are source, like the article records beside them, not output.
//
// A "reader" is the only thing that differs between them -- getText for one
// path, and the versions present for an id. The admin supplies an S3-backed
// library reader; siteReader below is backed by a site's own store. Everything
// after that is identical, which is the point: a private template is not a
// second rendering path, it is the same one pointed somewhere else.
//
// VERSIONS ARE IMMUTABLE IN BOTH SHELVES
//
// A site pinned to journal@1.2.0 renders the same bytes next year, and -- load
// bearing -- a cache can key on id@version without ever going stale. Uploads
// bump the patch version rather than overwrite, so iterating on a private
// template stays one click without giving that up.

import { checkManifest, compileTemplate, manifestFiles } from "./manifest.mjs";
import { validateTemplate } from "./validate.mjs";

export const SITE_TEMPLATE_PREFIX = "_internal/templates/";

export const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** Numeric compare, newest first, so 1.10.0 sorts above 1.9.0. */
export const byVersionDesc = (a, b) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  return (pb[0] - pa[0]) || (pb[1] - pa[1]) || (pb[2] - pa[2]);
};

export class TemplateNotFound extends Error {
  constructor(message) { super(message); this.name = "TemplateNotFound"; this.status = 503; }
}

export class TemplateRejected extends Error {
  constructor(message, findings = []) {
    super(message); this.name = "TemplateRejected"; this.status = 400; this.findings = findings;
  }
}

export const libraryPrefixFor = (id, version) => `templates/${id}/${version}/`;
export const sitePrefixFor = (id, version) => `${SITE_TEMPLATE_PREFIX}${id}/${version}/`;

// ------------------------------------------------------------- site reader
/**
 * A reader over one site's own uploads.
 *
 * Every key goes through the store, which applies the tenant key derivation, so
 * a `prefix`-driver site reads its own objects and cannot name another's.
 */
export function siteReader(store, siteId) {
  const base = (id) => `${SITE_TEMPLATE_PREFIX}${id}/`;
  return {
    scope: "site",
    siteId,
    where: "this site's own storage",
    prefixFor: sitePrefixFor,
    getText: (key) => store.getText(key),
    async versions(id) {
      const seen = new Set();
      for (const o of await store.list(base(id))) {
        const v = o.key.slice(base(id).length).split("/")[0];
        if (VERSION_RE.test(v)) seen.add(v);
      }
      return [...seen];
    },
  };
}

// --------------------------------------------------------------- assembling
/**
 * Fetch, check and compile the package a reader points at.
 *
 * @param cache  optional Map. The caller owns the key, because that is where
 *               tenant isolation lives: two sites may hold the same id at the
 *               same version, so a site-scoped key must carry the site.
 */
export async function loadFromReader(reader, { id, version } = {}, cache = null, cacheKey = null) {
  const resolved = version || (await reader.versions(id)).sort(byVersionDesc)[0];
  if (!resolved) throw new TemplateNotFound(`No template "${id}" in ${reader.where}`);

  const key = cacheKey ?? `${reader.scope}:${reader.siteId ?? ""}:${id}@${resolved}`;
  if (cache?.has(key)) return cache.get(key);

  const prefix = reader.prefixFor(id, resolved);
  const manifestText = await reader.getText(`${prefix}template.json`);
  if (!manifestText) throw new TemplateNotFound(`No template.json for ${id}@${resolved}`);

  let parsed;
  try {
    parsed = JSON.parse(manifestText);
  } catch (err) {
    throw new TemplateNotFound(`${id}@${resolved} has unparseable template.json: ${err.message}`);
  }

  const { manifest, problems } = checkManifest(parsed);
  if (problems.length) {
    throw new TemplateNotFound(`${id}@${resolved} has an invalid manifest: ${problems.join("; ")}`);
  }

  // Only the files the manifest names. A package cannot make the loader fetch
  // anything it did not declare, and nothing outside its own version prefix.
  const sources = { "template.json": manifestText };
  await Promise.all(manifestFiles(manifest).map(async (rel) => {
    const text = await reader.getText(`${prefix}${rel}`);
    if (text !== null) sources[rel] = text;
  }));

  const pkg = compileTemplate(manifest, sources);
  if (pkg.missing.length || pkg.errors.length) {
    throw new TemplateNotFound(
      `${id}@${resolved} did not compile: ${[...pkg.missing, ...pkg.errors].join("; ")}`);
  }

  // `sources` is kept, not discarded: renderSite emits a template's own
  // stylesheet as part of the file set, and a preview has no bucket to copy it
  // from. These bytes were already fetched to compile the layouts.
  const loaded = { ...pkg, sources, version: resolved, prefix, scope: reader.scope };
  if (cache) cache.set(key, loaded);
  return loaded;
}

// ------------------------------------------------------------------ uploads
/** Next patch version after whatever this site already has for `id`. */
export async function nextVersionFor(store, id) {
  const base = `${SITE_TEMPLATE_PREFIX}${id}/`;
  const versions = new Set();
  for (const o of await store.list(base)) {
    const v = o.key.slice(base.length).split("/")[0];
    if (VERSION_RE.test(v)) versions.add(v);
  }
  if (!versions.size) return "1.0.0";
  const [maj, min, patch] = [...versions].sort(byVersionDesc)[0].split(".").map(Number);
  return `${maj}.${min}.${patch + 1}`;
}

const contentTypeOf = (rel) =>
  rel.endsWith(".json") ? "application/json"
  : rel.endsWith(".css") ? "text/css; charset=utf-8"
  : rel.endsWith(".html") ? "text/html; charset=utf-8"
  : "text/plain; charset=utf-8";

const UNSAFE_PATH = (rel) =>
  rel.includes("..") || rel.startsWith("/") || rel.includes("\\") || rel.includes("\0");

/**
 * Validate a package and store it as this site's own template.
 *
 * The validator runs here exactly as it does for a library publish, and for the
 * same reason: a private template is still rendered by the shared process that
 * serves every other tenant. "It only affects my site" is a claim about blast
 * radius, not about which interpreter the bytes reach.
 *
 * Nothing is written until validation passes, so a rejected upload cannot leave
 * a half-written version behind for the loader to trip over.
 *
 * @param sources { "template.json": "…", "layouts/index.html": "…" } -- text
 * @returns { id, version, findings }
 */
export async function putSiteTemplate(store, sources) {
  if (!sources || typeof sources !== "object" || Array.isArray(sources)) {
    throw new TemplateRejected("A template package is a { path: text } map");
  }
  if (!sources["template.json"]) {
    throw new TemplateRejected("A template package needs a template.json");
  }
  for (const [rel, text] of Object.entries(sources)) {
    if (typeof text !== "string") throw new TemplateRejected(`${rel} is not text`);
    if (UNSAFE_PATH(rel)) throw new TemplateRejected(`Unsafe path in package: ${rel}`);
  }

  const { ok, manifest, findings } = validateTemplate(sources);
  if (!ok) throw new TemplateRejected("The template did not pass validation", findings);

  // The manifest's own version is advisory. Site templates are versioned by the
  // platform so every upload is a new immutable version -- which is what lets
  // the loader cache by id@version, and lets you roll back to the copy that was
  // working ten minutes ago.
  const version = await nextVersionFor(store, manifest.id);
  const prefix = sitePrefixFor(manifest.id, version);

  const stamped = { ...JSON.parse(sources["template.json"]), version };
  await store.putText(`${prefix}template.json`, JSON.stringify(stamped, null, 2), "application/json");
  await Promise.all(Object.entries(sources)
    .filter(([rel]) => rel !== "template.json")
    .map(([rel, text]) => store.putText(`${prefix}${rel}`, text, contentTypeOf(rel))));

  return { id: manifest.id, version, findings };
}

/** What this site has uploaded. */
export async function listSiteTemplates(store) {
  const byId = new Map();
  for (const o of await store.list(SITE_TEMPLATE_PREFIX)) {
    const [id, version] = o.key.slice(SITE_TEMPLATE_PREFIX.length).split("/");
    if (!id || !VERSION_RE.test(version ?? "")) continue;
    if (!byId.has(id)) byId.set(id, new Set());
    byId.get(id).add(version);
  }

  const out = [];
  for (const [id, versions] of byId) {
    const sorted = [...versions].sort(byVersionDesc);
    let manifest = {};
    try {
      manifest = JSON.parse(await store.getText(`${sitePrefixFor(id, sorted[0])}template.json`) ?? "{}");
    } catch { /* a package mid-upload must not break the whole listing */ }
    out.push({
      id,
      name: manifest.name ?? id,
      description: manifest.description ?? "",
      supports: manifest.supports ?? [],
      versions: sorted,
      latest: sorted[0],
      scope: "site",
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Remove one version, or every version, of a site's own template. */
export async function removeSiteTemplate(store, id, version = null) {
  const prefix = version ? sitePrefixFor(id, version) : `${SITE_TEMPLATE_PREFIX}${id}/`;
  const objs = await store.list(prefix);
  if (!objs.length) throw new TemplateNotFound(`No template "${id}" uploaded to this site`);
  for (const o of objs) await store.remove(o.key);
  return objs.length;
}
