// Which CloudFront paths a publish invalidates (store.publish).
//
// A wildcard empties the cache for every file of the site, so the next reader
// of each page waits on the origin and every object is fetched again, even the
// hundreds a publish did not touch. One post usually changes a handful of files
// (the post, the home page, a tag page or two, the feed, the sitemap), so those
// exact paths are what gets invalidated.
//
// The wildcard is kept only for a publish that rewrites most of a site anyway,
// a template or theme change. CloudFront caps a request at 3000 file paths in
// flight per distribution, and paths past the first 1000 a month are billed
// each, so a re-render of a big site is cheaper as one wildcard.

export const MAX_EXACT_PATHS = 1000;

/** A key as an invalidation path: leading slash, each segment URL-encoded. */
export function invalidationPath(key) {
  return "/" + key.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}

/**
 * @param {string[]} keys      object keys as the cache sees them, no leading slash
 * @param {string}   wildcard  the site-scoped wildcard, e.g. "/sites/acme/*" or "/*"
 * @returns {string[]}  the exact paths (deduplicated), or [wildcard] past the cap
 */
export function invalidationPaths(keys, wildcard, max = MAX_EXACT_PATHS) {
  const paths = [...new Set(keys.map(invalidationPath))];
  return paths.length > max ? [wildcard] : paths;
}
