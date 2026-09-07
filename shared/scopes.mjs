// What a token is allowed to reach.
//
// Pure: no filesystem, no S3, no network.
//
//   qw:<site>:<resource>:<action>        e.g. qw:crunchyts:templates:write
//
// Three axes, mirroring the API rather than inventing a parallel vocabulary. A
// scope names one site because this is a multi-site platform: "templates:write"
// without a site is a grant that can rewrite the wrong one.
//
// A SCOPE IS A CEILING, NEVER A GRANT
//
// Effective reach is the intersection of what the token allows and what the
// person's membership allows, evaluated per request. A token minted while
// someone was an owner does not keep owner rights after they are demoted, and a
// token cannot reach a site its holder was never a member of. Every existing
// role check stays exactly where it is; this narrows, it never widens.
//
// That is the whole security argument for letting an agent hold a token at all.

export const RESOURCES = [
  "content",    // posts, pages, galleries
  "templates",  // both shelves, and uploading to the private one
  "static",     // hand-authored pages
  "theme",      // design token overrides
  "media",      // image and audio uploads
  "stats",      // log-derived reports
  "members",    // who is on a site, and their roles
  "publish",    // promoting staging to live
];

export const ACTIONS = ["read", "write"];

/** `publish` has no meaningful read/write split at the resource level. */
export const READ_ONLY_RESOURCES = new Set(["stats"]);

// Deliberately separate from content:write. Drafting and going live have
// different blast radii, and an agent that can draft but not publish is the
// common case rather than the exotic one.
export const DEFAULT_AGENT_RESOURCES = ["content", "templates", "static", "theme", "media"];

const SEGMENT = "[a-z0-9][a-z0-9-]*";
const SCOPE_RE = new RegExp(`^qw:(\\*|${SEGMENT}):(\\*|[a-z]+):(\\*|read|write)$`);

export class ScopeError extends Error {
  constructor(message) { super(message); this.name = "ScopeError"; this.status = 400; }
}

/** Build one scope string. Throws rather than emit something unmatched. */
export function scope(site, resource, action) {
  const s = `qw:${site}:${resource}:${action}`;
  if (!SCOPE_RE.test(s)) throw new ScopeError(`Not a usable scope: ${s}`);
  if (resource !== "*" && !RESOURCES.includes(resource)) {
    throw new ScopeError(`Unknown resource "${resource}"`);
  }
  if (action !== "*" && !ACTIONS.includes(action)) {
    throw new ScopeError(`Unknown action "${action}"`);
  }
  return s;
}

/** Split a scope, or null if it is not one. */
export function parseScope(s) {
  const m = SCOPE_RE.exec(String(s ?? ""));
  if (!m) return null;
  const [, site, resource, action] = m;
  if (resource !== "*" && !RESOURCES.includes(resource)) return null;
  return { site, resource, action };
}

/** Drop anything unparseable, de-duplicate, and order it predictably. */
export function normalizeScopes(list) {
  const out = new Set();
  for (const s of Array.isArray(list) ? list : []) {
    const parsed = parseScope(s);
    if (parsed) out.add(`qw:${parsed.site}:${parsed.resource}:${parsed.action}`);
  }
  return [...out].sort();
}

/**
 * Does this set of scopes permit `action` on `resource` for `site`?
 *
 * `write` implies `read` on the same resource: a token that may replace an
 * article and may not read one back describes no real client.
 */
export function allows(scopes, { site, resource, action }) {
  for (const s of scopes ?? []) {
    const p = parseScope(s);
    if (!p) continue;
    if (p.site !== "*" && p.site !== site) continue;
    if (p.resource !== "*" && p.resource !== resource) continue;
    if (p.action === "*" || p.action === action) return true;
    if (action === "read" && p.action === "write") return true;
  }
  return false;
}

/**
 * The scopes a person may actually grant on one site, given their role there.
 *
 * The consent screen renders the difference between this and what a client
 * asked for, so somebody can see WHY a site is not on offer rather than find it
 * quietly missing.
 */
export function grantableFor(role, siteId) {
  if (!role) return [];
  const out = [];
  for (const resource of RESOURCES) {
    out.push(scope(siteId, resource, "read"));
    if (READ_ONLY_RESOURCES.has(resource)) continue;
    // Only an owner can hand out writes. An editor can edit through the console
    // -- where a person is watching -- without being able to mint a credential
    // that edits unattended.
    if (role === "owner") out.push(scope(siteId, resource, "write"));
  }
  return out.sort();
}

/** Keep only what `role` on `siteId` could legitimately grant. */
export function clampToRole(requested, role, siteId) {
  const allowed = new Set(grantableFor(role, siteId));
  return normalizeScopes(requested).filter((s) => allowed.has(s));
}

/** What was asked for and refused, so the reason can be shown rather than implied. */
export function refusedBy(requested, role, siteId) {
  const allowed = new Set(grantableFor(role, siteId));
  return normalizeScopes(requested).filter((s) => !allowed.has(s));
}

/**
 * The resource and action a request needs.
 *
 * One table, so a route cannot be added to the API without someone deciding
 * what a token needs in order to call it. An unlisted route resolves to null,
 * which callers must treat as "no token may reach this" rather than "anything
 * may" -- the difference between failing closed and failing open.
 */
const ROUTE_TABLE = {
  articles:  "content",
  templates: "templates",
  static:    "static",
  theme:     "theme",
  media:     "media",
  stats:     "stats",
  members:   "members",
  publish:   "publish",
  site:      "theme",
  preview:   "content",
};

// Routes whose verb misdescribes what they do. A dry run arrives as a POST
// because it carries a body, not because it changes anything, and a token that
// may read a template should be able to check one.
const READ_DESPITE_VERB = new Set(["templates/validate"]);

export function requirementFor(head, method, second = null) {
  const resource = ROUTE_TABLE[head];
  if (!resource) return null;
  const action = ["GET", "HEAD"].includes(method) || READ_DESPITE_VERB.has(`${head}/${second}`)
    ? "read"
    : "write";
  // GET /publish reads the pending changeset; POST promotes it.
  return { resource, action };
}

/** Routes any signed-in caller may reach, token or not. */
export const UNSCOPED_ROUTES = new Set(["health", "session", "me", "sites"]);

/** A human-readable summary, for a consent screen or a token listing. */
export function describeScopes(scopes) {
  const bySite = new Map();
  for (const s of normalizeScopes(scopes)) {
    const p = parseScope(s);
    if (!bySite.has(p.site)) bySite.set(p.site, new Map());
    const res = bySite.get(p.site);
    // write outranks read in the summary; showing both is noise.
    if (res.get(p.resource) !== "write") res.set(p.resource, p.action);
  }
  return [...bySite].map(([site, res]) => ({
    site,
    grants: [...res].sort(([a], [b]) => a.localeCompare(b))
      .map(([resource, action]) => ({ resource, action })),
  }));
}
