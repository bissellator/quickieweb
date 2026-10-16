// Hand-authored files that bypass the content model entirely: whole pages,
// and the stylesheets, scripts, images and fonts they load.
//
// Pure: no filesystem, no S3, no network.
//
// A `page` record is content -- a title, a body, a template around it, a place
// in the nav, a row in the search index. That covers an About page. It does not
// cover a bespoke product page, a calculator, a landing page someone built in a
// design tool, or a whole site built somewhere else: things whose point is
// markup the editor cannot express. Those arrive here as files and are
// published verbatim.
//
//   <site staging>/_internal/static/<path>   the source, never published
//   <site staging>/<path>                    the copy a publish promotes
//
// The source lives under `_internal/` -- already in SKIP_PREFIXES -- so it is
// held the same way article records and private templates are: a publish moves
// the staged copy and can never reach the original. Keeping a source at all is
// what makes these listable, replaceable and deletable; a file written straight
// into staging would be indistinguishable from rendered output and could only
// be managed with a bucket browser.
//
// STATIC FILES WIN
//
// A site can mix the two: a hand-built home page and bible pages beside posts
// written in the console. So a static file may sit at a path the renderer also
// writes -- index.html, feed.xml, assets/style.css -- and when it does, the
// static file is what publishes. A rebuild renders, copies the template's
// assets, and re-stages every static file LAST, so the order is the rule rather
// than a race. listStaticPages() marks each such file, so the console can say
// "this replaces the template's home page" instead of letting it happen quietly.
//
// Three things stay refused: the platform's own prefixes, the files the console
// itself reads back (taxonomy.json), and a path a post or page record renders
// to. Two console authors of one URL is a conflict to resolve by renaming, not
// a precedence rule.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//
// Nothing is templated into these, and nothing is extracted out of them. They
// carry no masthead, no theme, no search index entry, and no automatic nav
// slot. That is the trade: a page that owns its own markup owns all of it.

import { contentTypeFor } from "./object-policy.mjs";

export const STATIC_PREFIX = "_internal/static/";

/**
 * Every rebuild records exactly what it wrote -- the rendered files and the
 * template's assets -- so "this replaces the template's file" can be said of
 * the files it is true of, and not of every image that happens to sit under
 * assets/. Read by the console listing and by cli/push-static.mjs.
 */
export const GENERATED_LIST_KEY = "_internal/generated.json";

/**
 * What a site writes for itself when no rebuild has recorded it yet: the files
 * renderSite always emits. A floor, not the whole set.
 */
export const GENERATED_PATHS = new Set([
  "index.html", "404.html", "favicon.ico",
  "feed.xml", "podcast.xml", "articles.json", "search-index.json",
  "assets/theme.css", "assets/favicon.svg", "assets/search.js", "assets/gallery.js",
]);

/** The set of paths the last rebuild wrote, or the floor when none is recorded. */
export async function generatedPaths(store) {
  const text = await store.getText(GENERATED_LIST_KEY);
  if (text === null) return GENERATED_PATHS;
  let list;
  try {
    list = JSON.parse(text);
  } catch (err) {
    throw new Error(`${GENERATED_LIST_KEY} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(list)) throw new Error(`${GENERATED_LIST_KEY} is not a list`);
  return new Set(list);
}

/** Read back by the console itself; replacing it would break the editor. */
const PLATFORM_PATHS = new Set(["taxonomy.json", "admins.json", "sitedata.json"]);

/** Prefixes the platform owns outright. */
const PLATFORM_PREFIXES = ["admin/", "_internal/", "media/", "__qw/"];

/**
 * What a static file may be: the types a browser loads from a web page. Their
 * Content-Type comes from shared/object-policy.mjs, the same table the store
 * labels every other object with.
 *
 * .ico is in the list because the platform's own favicon.ico is an SVG document
 * (render.mjs) and is served as SVG; a binary icon is refused at the door rather
 * than served with a type that breaks it. See checkStaticBody.
 */
export const STATIC_EXTENSIONS = new Set([
  "html", "htm", "css", "js", "mjs", "json", "map", "webmanifest", "txt", "xml", "svg", "ico",
  "png", "jpg", "jpeg", "gif", "webp", "avif",
  "woff2", "woff", "ttf", "otf",
  "mp3", "m4a", "ogg", "wav", "mp4", "webm", "pdf",
]);

const TEXT_EXT = new Set(["html", "htm", "css", "js", "mjs", "json", "map", "webmanifest", "txt", "xml", "svg", "ico"]);

const extOf = (path) => path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";

export const contentTypeOf = (path) => contentTypeFor(path);

/** Whether a file is text, and so readable and editable through the API. */
export const isTextPath = (path) => TEXT_EXT.has(extOf(path));

const SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export class StaticPageRejected extends Error {
  constructor(message) { super(message); this.name = "StaticPageRejected"; this.status = 400; }
}

/**
 * Normalize and vet a requested path. Returns the clean path or throws.
 *
 * The rules are the same ones every other key in this system follows: no
 * traversal, no absolute paths, no backslashes, no empty segments. A static
 * file is the one place a person types a key by hand, so this is the one place
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
    if (!SEGMENT_RE.test(seg) || seg === "." || seg === "..") {
      throw new StaticPageRejected(`"${seg}" is not a usable path segment`);
    }
  }

  if (!STATIC_EXTENSIONS.has(extOf(path))) {
    throw new StaticPageRejected(
      `"${path}" is not a type a web page loads. Allowed: ${[...STATIC_EXTENSIONS].join(", ")}`);
  }

  if (PLATFORM_PATHS.has(path)) {
    throw new StaticPageRejected(`"${path}" is read by the console itself and cannot be replaced`);
  }
  for (const p of PLATFORM_PREFIXES) {
    if (path.startsWith(p)) throw new StaticPageRejected(`"${p}" belongs to the platform`);
  }

  // A post or page record renders to <slug>.html. Two authors of one filename,
  // both in the console, is a conflict to resolve by renaming one.
  const bare = path.replace(/\.html?$/i, "");
  if (slugs.includes(bare)) {
    throw new StaticPageRejected(
      `"${bare}" is already a post or page in this site. Rename one of them.`);
  }

  return path;
}

/** Whether a static file at this path replaces something the site renders or copies. */
export const replacesGenerated = (path, generated = GENERATED_PATHS) => generated.has(path);

/**
 * Vet a file's bytes against its path. Returns the body as a Buffer.
 * @param body  a Buffer, or a string for a text file
 */
export function checkStaticBody(path, body) {
  let buf;
  if (Buffer.isBuffer(body)) buf = body;
  else if (body instanceof Uint8Array) buf = Buffer.from(body);
  else if (typeof body === "string") {
    if (!isTextPath(path)) {
      throw new StaticPageRejected(`"${path}" is a binary file; send it as bytes (base64), not text`);
    }
    buf = Buffer.from(body, "utf8");
  } else {
    throw new StaticPageRejected("The file body must be text or bytes");
  }
  if (!buf.length || (isTextPath(path) && !buf.toString("utf8").trim())) {
    throw new StaticPageRejected("The file is empty");
  }
  if (extOf(path) === "ico" && !/^\s*</.test(buf.subarray(0, 64).toString("latin1"))) {
    throw new StaticPageRejected(
      `"${path}" is a binary icon. Favicons are served as SVG here; upload favicon.svg, or an SVG named .ico`);
  }
  return buf;
}

/**
 * Store a static file and stage its published copy.
 *
 * Both writes happen here rather than leaving the staged copy to the next
 * rebuild, so an upload is visible in the changeset immediately -- an author
 * who uploads a page and sees nothing to publish has been told a lie.
 */
export async function putStaticPage(store, rawPath, body, { slugs = [] } = {}) {
  const path = checkStaticPath(rawPath, { slugs });
  const buf = checkStaticBody(path, body);
  const type = contentTypeOf(path);
  await store.putBuffer(`${STATIC_PREFIX}${path}`, buf, type);
  await store.putBuffer(path, buf, type);
  return { path, bytes: buf.length, replaces: replacesGenerated(path, await generatedPaths(store)) };
}

/** Every static file this site holds. */
export async function listStaticPages(store) {
  const [objs, generated] = await Promise.all([store.list(STATIC_PREFIX), generatedPaths(store)]);
  return objs
    .map((o) => {
      const path = o.key.slice(STATIC_PREFIX.length);
      return {
        path,
        size: o.size ?? 0,
        modified: o.modified ?? null,
        replaces: replacesGenerated(path, generated),
        text: isTextPath(path),
      };
    })
    .filter((p) => p.path && !p.path.endsWith("/"))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** A text file's source, or null. Binary files are not read through here. */
export async function readStaticPage(store, rawPath) {
  const path = checkStaticPath(rawPath);
  if (!isTextPath(path)) {
    throw new StaticPageRejected(`"${path}" is a binary file; it can be replaced or deleted, not read as text`);
  }
  return store.getText(`${STATIC_PREFIX}${path}`);
}

/**
 * Remove a static file, source and staged copy both.
 *
 * Dropping only the source would leave the staged copy in place, where it would
 * publish forever and never appear in any listing -- the exact orphan this
 * module keeps a source in order to avoid. If the file was replacing a
 * generated one, the next rebuild (every publish starts with one) puts the
 * renderer's version back.
 */
export async function removeStaticPage(store, rawPath) {
  const path = checkStaticPath(rawPath);
  if (!(await store.exists(`${STATIC_PREFIX}${path}`))) {
    throw new StaticPageRejected(`No static file at "${path}"`);
  }
  await store.remove(`${STATIC_PREFIX}${path}`);
  await store.remove(path);
  return path;
}

/**
 * Re-stage every static file. Called at the END of a rebuild, after the render
 * and the template's assets, which is what makes "static files win" true.
 *
 * A server-side copy, not a read and a write: the bytes never pass through the
 * Lambda, so a font or an image arrives exactly as uploaded.
 */
export async function stageStaticPages(store) {
  const pages = await listStaticPages(store);
  for (const { path } of pages) {
    await store.copyWithinStaging(`${STATIC_PREFIX}${path}`, path);
  }
  return pages.map((p) => p.path);
}
