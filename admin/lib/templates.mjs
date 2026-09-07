// The S3 half of template loading: the platform-bucket reader, the catalog, and
// the cache. Everything that does not need an SDK -- assembling a package,
// validating an upload, versioning it -- lives in shared/template/library.mjs
// so it is testable without one and identical wherever it runs.
//
//   library   s3://<platform>/templates/<id>/<version>/   shared, read-only here
//   site      <staging>/_internal/templates/<id>/<v>/     one site's own uploads
//
// The library is deliberately NOT in a site's content buckets: publish()
// compares a site's own staging against its own live, and the library is in
// neither, so no changeset however wrong can reach it. Private templates get
// the same protection from `_internal/` being in SKIP_PREFIXES.

import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import {
  siteReader, loadFromReader, libraryPrefixFor, VERSION_RE, TemplateNotFound,
} from "../../shared/template/library.mjs";

const PLATFORM = process.env.PLATFORM_BUCKET ?? "";

// A Lambda container is reused across invocations, and a rebuild renders every
// page of a site. Without this, one save would re-fetch the same eight template
// files once per page.
//
// The key MUST carry the site for a private template. Two sites can both hold
// `mytheme@1.0.0`, and a key of just id@version would serve one tenant's
// template to another out of a warm container -- the worst thing this file
// could do. Library ids are globally unique within an installation, so those
// key on id@version alone.
const cache = new Map();
const MAX_CACHED = 8;

const cacheKeyFor = (ref, resolved) => ref?.scope === "site"
  ? `site:${ref.siteId}:${ref.id}@${resolved ?? ""}`
  : `lib:${ref.id}@${resolved ?? ""}`;

async function platformGetText(s3, key) {
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

function libraryReader(s3) {
  return {
    scope: "library",
    where: `s3://${PLATFORM}/templates/`,
    prefixFor: libraryPrefixFor,
    getText: (key) => platformGetText(s3, key),
    async versions(id) {
      const res = await s3.send(new ListObjectsV2Command({
        Bucket: PLATFORM, Prefix: `templates/${id}/`, Delimiter: "/",
      }));
      return (res.CommonPrefixes ?? [])
        .map((p) => p.Prefix.slice(`templates/${id}/`.length).replace(/\/$/, ""))
        .filter((v) => VERSION_RE.test(v));
    },
  };
}

/** The library catalog, or an empty one when the bucket has no index yet. */
export async function readCatalog(s3) {
  if (!PLATFORM) return { templates: [] };
  const text = await platformGetText(s3, "templates/index.json");
  if (!text) return { templates: [] };
  try {
    return JSON.parse(text);
  } catch (err) {
    // A corrupt catalog must be loud: silently returning an empty one would
    // make every site look like it has no template.
    throw new TemplateNotFound(`templates/index.json is not valid JSON: ${err.message}`);
  }
}

/**
 * Load and compile a template package.
 *
 * @param ref   { id, version, scope, siteId } -- empty version means "latest"
 * @param store the site's store, required for scope "site"
 */
export async function loadTemplate(s3, ref, store = null) {
  const site = ref?.scope === "site";
  if (site && !store) throw new TemplateNotFound(`Loading "${ref?.id}" needs the site's store`);
  if (!site && !PLATFORM) {
    throw new TemplateNotFound(
      "PLATFORM_BUCKET is not set on this function, so the template library is unreachable. " +
      "Run infra/provision-platform.mjs and redeploy.");
  }

  const reader = site ? siteReader(store, ref.siteId) : libraryReader(s3);
  // Resolve first so the cache key names a concrete version: "latest" must not
  // become a cache entry, or a new upload would be invisible until the
  // container recycled.
  const resolved = ref.version || (await reader.versions(ref.id)).sort(
    (a, b) => {
      const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
      return (pb[0] - pa[0]) || (pb[1] - pa[1]) || (pb[2] - pa[2]);
    })[0];
  if (!resolved) throw new TemplateNotFound(`No template "${ref.id}" in ${reader.where}`);

  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
  return loadFromReader(reader, { id: ref.id, version: resolved }, cache, cacheKeyFor(ref, resolved));
}

/** Drop cached copies of one site's template, after an upload or a delete. */
export function evictSiteTemplate(siteId, id) {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`site:${siteId}:${id}@`)) cache.delete(key);
  }
}

/**
 * Template assets that renderSite CANNOT emit, for copying server-side into a
 * site's staging bucket. That is webfonts and nothing else: they are binary, and
 * the loader reads package files as UTF-8 text, which would corrupt them.
 *
 * Stylesheets and scripts are deliberately NOT here any more. They are text, so
 * renderSite includes them in the file set directly -- which is what makes a
 * preview, which has no bucket to copy into, come out styled.
 */
export function assetKeysFor(template) {
  const m = template.manifest;
  return (m.webfonts ?? []).map((f) => f.src).map((rel) => ({
    source: `${template.prefix}${rel}`,
    target: `assets/${rel.split("/").pop()}`,
    // A library font is copied across buckets; a site's own font already lives
    // in this bucket and only needs moving into place.
    scope: template.scope ?? "library",
  }));
}

export {
  TemplateNotFound, TemplateRejected, SITE_TEMPLATE_PREFIX,
  putSiteTemplate, listSiteTemplates, removeSiteTemplate, nextVersionFor,
} from "../../shared/template/library.mjs";

export { PLATFORM };
