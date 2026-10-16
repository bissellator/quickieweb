// What the edge store must say for a site, and how to get it there safely.
//
// The edge (infra/edge/tenant-router.js) reads, per protected site:
//   <siteId>          the site's default level
//   <siteId>/<path>   a page whose level differs from it
// A site with neither is public.
//
// THE ORDERING PROBLEM
//
// A publish changes two things that are not updated atomically together: the
// bytes in the live bucket and the levels in the edge store. Done in the wrong
// order, a page can be briefly readable by people it was just restricted from,
// or a public index can briefly still list a page that just became private.
//
// So a sync is two steps around the publish:
//   before   every key is set to the STRICTER of its old and new level
//   after    every key is set to exactly its new level
// In between -- and if the publish fails, indefinitely -- everything is at least
// as locked as both the old state and the new one. Never more open than either.
//
// The site record keeps what the store was last told (`access.edge`), and is
// written after EACH step. A crash part-way leaves the record describing a
// superset of the store's keys, so the next sync still deletes what it should.
//
// Pure. No S3, no network.

import { ACCESS_LEVELS, effectiveLevel, edgeOverrides } from "./site.mjs";

const rank = (l) => ACCESS_LEVELS.indexOf(l);
const stricter = (a, b) => (rank(a) >= rank(b) ? a : b);

/** `{ site: level|null, paths: { "/x.html": level } }` -- null site means "not protected at all". */
export function normalizeEdgeState(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const paths = {};
  for (const [p, l] of Object.entries(s.paths ?? {})) {
    if (p.startsWith("/") && ACCESS_LEVELS.includes(l)) paths[p] = l;
  }
  return { site: ACCESS_LEVELS.includes(s.site) ? s.site : null, paths };
}

/**
 * The state the store should hold for a site, from its default and its
 * published records. A public site with no overrides needs no entry at all,
 * which keeps every public site on the edge's one-lookup fast path.
 */
export function desiredEdgeState(siteDefault, records) {
  const def = effectiveLevel("", siteDefault);
  const paths = edgeOverrides(records, def);
  if (def === "public" && !Object.keys(paths).length) return { site: null, paths: {} };
  return { site: def, paths };
}

const levelAt = (state, p) => state.paths[p] ?? state.site ?? "public";

/**
 * @returns { max, before, after } where before/after are
 *   { puts: [{ key, value }], deletes: [key] } in store keys (`<site>`, `<site>/<path>`)
 *   and `max` is the intermediate state to record once `before` is applied.
 */
export function planEdgeSync(siteId, prevRaw, nextRaw) {
  const prev = normalizeEdgeState(prevRaw);
  const next = normalizeEdgeState(nextRaw);

  const all = [...new Set([...Object.keys(prev.paths), ...Object.keys(next.paths)])].sort();
  const max = { site: null, paths: {} };
  if (prev.site !== null || next.site !== null) {
    max.site = stricter(prev.site ?? "public", next.site ?? "public");
    for (const p of all) max.paths[p] = stricter(levelAt(prev, p), levelAt(next, p));
  }

  const ops = (from, to) => {
    const puts = [];
    const deletes = [];
    if (to.site === null) {
      if (from.site !== null) deletes.push(siteId);
    } else if (to.site !== from.site) {
      puts.push({ key: siteId, value: to.site });
    }
    for (const p of Object.keys(from.paths)) if (!(p in to.paths)) deletes.push(`${siteId}${p}`);
    for (const [p, l] of Object.entries(to.paths)) if (from.paths[p] !== l) puts.push({ key: `${siteId}${p}`, value: l });
    return { puts, deletes };
  };

  return { max, before: ops(prev, max), after: ops(max, next) };
}
