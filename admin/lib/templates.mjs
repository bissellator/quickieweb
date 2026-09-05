// Loading template packages out of the platform bucket.
//
// The library is deliberately NOT in a site's content buckets. It is shared
// across every site in the installation, it is never published, and publish()
// must never be able to reach it -- a site's changeset compares its own staging
// against its own live, and the library is in neither.
//
//   templates/index.json                     the catalog
//   templates/<id>/<version>/template.json   a package
//   templates/<id>/<version>/layouts/…
//
// Versions are immutable. A site pinned to journal@1.2.0 renders the same bytes
// next year; "latest" is resolved through the catalog at load time, so a site
// that has not pinned follows the library forward on purpose rather than by
// accident.

import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { checkManifest, compileTemplate, manifestFiles } from "../../shared/template/manifest.mjs";

const PLATFORM = process.env.PLATFORM_BUCKET ?? "";

// A Lambda container is reused across invocations, and a rebuild renders every
// page of a site. Without this, one save would re-fetch the same eight template
// files once per page. Keyed by id@version, which is immutable, so a cache entry
// can never be stale -- only evicted with the container.
const cache = new Map();
const MAX_CACHED = 8;

export class TemplateNotFound extends Error {
  constructor(message) { super(message); this.name = "TemplateNotFound"; this.status = 503; }
}

const prefixFor = (id, version) => `templates/${id}/${version}/`;

async function getText(s3, key) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: PLATFORM, Key: key }));
    const chunks = [];
    for await (const c of res.Body) chunks.push(c);
    return Buffer.concat(chunks).toString("utf8");
  } catch (err) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

/** The library catalog, or an empty one when the bucket has no index yet. */
export async function readCatalog(s3) {
  if (!PLATFORM) return { templates: [] };
  const text = await getText(s3, "templates/index.json");
  if (!text) return { templates: [] };
  try {
    return JSON.parse(text);
  } catch (err) {
    // A corrupt catalog must be loud: silently returning an empty one would
    // make every site look like it has no template.
    throw new TemplateNotFound(`templates/index.json is not valid JSON: ${err.message}`);
  }
}

/** Highest version present for an id, by listing the prefix. */
async function latestVersion(s3, id) {
  const res = await s3.send(new ListObjectsV2Command({
    Bucket: PLATFORM, Prefix: `templates/${id}/`, Delimiter: "/",
  }));
  const versions = (res.CommonPrefixes ?? [])
    .map((p) => p.Prefix.slice(`templates/${id}/`.length).replace(/\/$/, ""))
    .filter((v) => /^\d+\.\d+\.\d+/.test(v));
  if (!versions.length) return null;
  // Numeric compare, so 1.10.0 sorts above 1.9.0.
  return versions.sort((a, b) => {
    const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
    return (pb[0] - pa[0]) || (pb[1] - pa[1]) || (pb[2] - pa[2]);
  })[0];
}

/**
 * Load and compile a template package.
 * @param ref { id, version } -- an empty version means "whatever is latest"
 */
export async function loadTemplate(s3, { id, version }) {
  if (!PLATFORM) {
    throw new TemplateNotFound(
      "PLATFORM_BUCKET is not set on this function, so the template library is unreachable. " +
      "Run infra/provision-platform.mjs and redeploy.");
  }

  const resolved = version || (await latestVersion(s3, id));
  if (!resolved) throw new TemplateNotFound(`No template "${id}" in s3://${PLATFORM}/templates/`);

  const cacheKey = `${id}@${resolved}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const prefix = prefixFor(id, resolved);
  const manifestText = await getText(s3, `${prefix}template.json`);
  if (!manifestText) throw new TemplateNotFound(`No template.json for ${cacheKey}`);

  const { manifest, problems } = checkManifest(JSON.parse(manifestText));
  if (problems.length) {
    throw new TemplateNotFound(`${cacheKey} has an invalid manifest: ${problems.join("; ")}`);
  }

  // Only the files the manifest names. A package cannot make the Lambda fetch
  // anything it did not declare, and nothing outside its own version prefix.
  const sources = { "template.json": manifestText };
  await Promise.all(manifestFiles(manifest).map(async (rel) => {
    const text = await getText(s3, `${prefix}${rel}`);
    if (text !== null) sources[rel] = text;
  }));

  const pkg = compileTemplate(manifest, sources);
  if (pkg.missing.length || pkg.errors.length) {
    throw new TemplateNotFound(
      `${cacheKey} did not compile: ${[...pkg.missing, ...pkg.errors].join("; ")}`);
  }

  // `sources` is kept, not discarded: renderSite emits a template's own
  // stylesheet as part of the file set, and a preview has no bucket to copy it
  // from. These bytes were already fetched to compile the layouts.
  const loaded = { ...pkg, sources, version: resolved, prefix };
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, loaded);
  return loaded;
}

/**
 * Template assets that renderSite CANNOT emit, for copying server-side into a
 * site's staging bucket. That is webfonts and nothing else: they are binary, and
 * this loader reads package files as UTF-8 text, which would corrupt them.
 *
 * Stylesheets and scripts are deliberately NOT here any more. They are text, so
 * renderSite includes them in the file set directly -- which is what makes a
 * preview, which has no bucket to copy into, come out styled.
 */
export function assetKeysFor(template) {
  const m = template.manifest;
  const rels = (m.webfonts ?? []).map((f) => f.src);
  return rels.map((rel) => ({
    source: `${template.prefix}${rel}`,
    target: `assets/${rel.split("/").pop()}`,
  }));
}

export { PLATFORM };
