// How every object in a site's buckets is labelled: its Cache-Control and its
// Content-Type. Pure, and shared by admin/lib/store.mjs (the Lambda) and
// cli/push-static.mjs (an operator's machine), so an object reads the same
// whichever of them wrote it.

const clean = (key) => (key.startsWith("/") ? key.slice(1) : key);

// ------------------------------------------------------------- cache policy
//
// CloudFront invalidation clears the edge. It cannot clear a browser. So the two
// caches get different instructions: a long `s-maxage` for the CDN, which
// publish() invalidates on every change, and a short `max-age` for browsers,
// which we have no lever over at all. A one-year max-age on an article is
// unrecallable -- a returning reader keeps the stale copy and nothing we do from
// this side reaches them.
//
// media/ is the one honest exception: those keys carry an upload timestamp, so
// the bytes at a given URL really never change and `immutable` is true rather
// than aspirational.
const YEAR = 31536000;

export function cacheControlFor(key) {
  const k = clean(key);
  // Staging-only state. Never published, never public, read back by the admin on
  // the next request -- caching it would only serve us a stale admin list.
  if (k.startsWith("_internal/") || k === "admins.json" || k === "sitedata.json") return "no-store";
  if (k.startsWith("media/")) return `public, max-age=${YEAR}, immutable`;
  return `public, max-age=300, s-maxage=${YEAR}`;
}

/** Extension -> MIME. The types a site, a template package or a static file contains. */
export function contentTypeFor(key) {
  const ext = String(key).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return {
    css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
    html: "text/html; charset=utf-8", json: "application/json; charset=utf-8",
    xml: "application/xml; charset=utf-8", txt: "text/plain; charset=utf-8",
    svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    webp: "image/webp", gif: "image/gif", ico: "image/svg+xml",
    woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf",
    mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg",
    htm: "text/html; charset=utf-8", mjs: "text/javascript; charset=utf-8",
    map: "application/json; charset=utf-8", webmanifest: "application/manifest+json",
    avif: "image/avif", otf: "font/otf", mp4: "video/mp4", webm: "video/webm",
    pdf: "application/pdf",
  }[ext] ?? "application/octet-stream";
}
