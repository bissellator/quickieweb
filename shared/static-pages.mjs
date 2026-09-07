// Hand-authored pages that bypass the content model entirely.
//
// Pure: no filesystem, no S3, no network.
//
// A `page` record is content -- a title, a body, a template around it, a place
// in the nav, a row in the search index. That covers an About page. It does not
// cover a bespoke product page, a calculator, or a landing page someone built
// in a design tool: things whose whole point is markup the editor cannot
// express. Those arrive here as complete documents and are published verbatim.
//
//   <site staging>/_internal/static/<path>   the source, never published
//   <site staging>/<path>                    the copy a publish promotes
//
// The source lives under `_internal/` -- already in SKIP_PREFIXES -- so it is
// held the same way article records and private templates are: a publish moves
// the rendered copy and can never reach the original. Keeping a source at all
// is what makes these listable, replaceable and deletable; a file written
// straight into staging would be indistinguishable from rendered output and
// could only be managed with a bucket browser.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//
// Nothing is templated into these, and nothing is extracted out of them. They
// carry no masthead, no theme, no search index entry, and no automatic nav
// slot. That is the trade: a page that owns its own markup owns all of it. Use
// a `page` record when you want the site's chrome.

export const STATIC_PREFIX = "_internal/static/";

/**
 * Paths renderSite writes itself. A static page at one of these would be
 * silently overwritten on the next rebuild -- which looks exactly like "my
 * upload did nothing" -- so it is refused at the door instead.
 */
export const GENERATED_PATHS = new Set([
  "index.html", "404.html", "favicon.ico",
  "feed.xml", "podcast.xml", "articles.json", "search-index.json", "taxonomy.json",
]);

/** Prefixes the platform owns outright. */
export const GENERATED_PREFIXES = ["assets/", "admin/", "_internal/", "media/"];

const SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export class StaticPageRejected extends Error {
  constructor(message) { super(message); this.name = "StaticPageRejected"; this.status = 400; }
}

/**
 * Normalize and vet a requested path. Returns the clean path or throws.
 *
 * The rules are the same ones every other key in this system follows: no
 * traversal, no absolute paths, no backslashes, no empty segments. A static
 * page is the one place a person types a key by hand, so this is the one place
 * that has to say no.
 */
export function checkStaticPath(raw, { slugs = [] } = {}) {
  const path = String(raw ?? "").trim().replace(/^\/+/, "");

  if (!path) throw new StaticPageRejected("A path is required, for example pricing.html");
  if (path.length > 200) throw new StaticPageRejected("That path is too long");
  if (path.includes("\\")) throw new StaticPageRejected("Use forward slashes in a path");
  if (path.endsWith("/")) throw new StaticPageRejected("A path must name a file, not a directory");

  const segments = path.split("/");
  if (segments.length > 6) throw new StaticPageRejected("That path is nested too deeply");
  for (const seg of segments) {
    if (seg === "." || seg === ".." || !SEGMENT_RE.test(seg)) {
      throw new StaticPageRejected(`"${seg}" is not a usable path segment`);
    }
  }

  if (!/\.(html|htm|css|js|json|txt|xml|svg)$/i.test(path)) {
    throw new StaticPageRejected(
      "A static page needs a file extension: .html for a page, or .css/.js/.svg for something it loads");
  }

  if (GENERATED_PATHS.has(path)) {
    throw new StaticPageRejected(`"${path}" is written by the renderer on every rebuild`);
  }
  for (const p of GENERATED_PREFIXES) {
    if (path.startsWith(p)) throw new StaticPageRejected(`"${p}" belongs to the platform`);
  }

  // A post or page record renders to <slug>.html. Two authors of one filename is
  // a race whose winner depends on the order of two loops.
  const bare = path.replace(/\.html?$/i, "");
  if (slugs.includes(bare)) {
    throw new StaticPageRejected(
      `"${bare}" is already a post or page in this site. Rename one of them.`);
  }

  return path;
}

const contentTypeOf = (path) =>
  /\.html?$/i.test(path) ? "text/html; charset=utf-8"
  : path.endsWith(".css") ? "text/css; charset=utf-8"
  : path.endsWith(".js") ? "text/javascript; charset=utf-8"
  : path.endsWith(".json") ? "application/json; charset=utf-8"
  : path.endsWith(".xml") ? "application/xml; charset=utf-8"
  : path.endsWith(".svg") ? "image/svg+xml"
  : "text/plain; charset=utf-8";

/**
 * Store a static page and stage its published copy.
 *
 * Both writes happen here rather than leaving the staged copy to the next
 * rebuild, so an upload is visible in the changeset immediately -- an author
 * who uploads a page and sees nothing to publish has been told a lie.
 */
export async function putStaticPage(store, rawPath, body, { slugs = [] } = {}) {
  const path = checkStaticPath(rawPath, { slugs });
  if (typeof body !== "string") throw new StaticPageRejected("The page body must be text");
  if (!body.trim()) throw new StaticPageRejected("The page is empty");

  const type = contentTypeOf(path);
  await store.putText(`${STATIC_PREFIX}${path}`, body, type);
  await store.putText(path, body, type);
  return { path, bytes: body.length };
}

/** Every static page this site holds. */
export async function listStaticPages(store) {
  const objs = await store.list(STATIC_PREFIX);
  return objs
    .map((o) => ({
      path: o.key.slice(STATIC_PREFIX.length),
      size: o.size ?? 0,
      modified: o.modified ?? null,
    }))
    .filter((p) => p.path && !p.path.endsWith("/"))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export const readStaticPage = (store, path) => store.getText(`${STATIC_PREFIX}${path}`);

/**
 * Remove a static page, source and staged copy both.
 *
 * Dropping only the source would leave the staged copy in place, where it would
 * publish forever and never appear in any listing -- the exact orphan this
 * module keeps a source in order to avoid.
 */
export async function removeStaticPage(store, rawPath) {
  const path = checkStaticPath(rawPath);
  const existing = await store.getText(`${STATIC_PREFIX}${path}`);
  if (existing === null) throw new StaticPageRejected(`No static page at "${path}"`);
  await store.remove(`${STATIC_PREFIX}${path}`);
  await store.remove(path);
  return path;
}

/**
 * Re-stage every static page. Called after a rebuild, because renderSite has
 * just written the file set and a static page is not in it -- rebuild does not
 * delete, but a page whose staged copy was cleared some other way would
 * otherwise stay missing until it was uploaded again.
 */
export async function stageStaticPages(store) {
  const pages = await listStaticPages(store);
  for (const { path } of pages) {
    const body = await store.getText(`${STATIC_PREFIX}${path}`);
    if (body !== null) await store.putText(path, body, contentTypeOf(path));
  }
  return pages.map((p) => p.path);
}
