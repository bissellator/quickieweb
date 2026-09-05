// The platform data model: sites, membership, and where a site's bytes live.
//
// These records live in the PLATFORM bucket alongside the template library,
// never in a site's own buckets. That separation is the multi-tenant boundary:
// a site's staging bucket holds only that site's content, so a bug in the
// content path cannot reach the registry that says who may read what.
//
//   accounts/sites/<siteId>.json    a site record
//   accounts/users/<emailHash>.json a person, and the sites they belong to
//   templates/<id>/<version>/…      the library
//
// Pure: no filesystem, no S3, no network.

export const SITE_ROLES = ["owner", "editor"];
export const PLATFORM_ROLES = ["user", "staff"];
export const STORAGE_DRIVERS = ["buckets", "prefix"];

const SITE_ID_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// The site id IS the subdomain: acme.quickieweb.com is served from the site
// `acme`. Deriving it means the edge function needs no lookup table, no state
// and no size limit -- it rewrites a path from the Host header and nothing else.
// Custom domains cannot work that way and will need a real lookup; that is the
// deliberate cost of shipping subdomains first.
//
// Because the id is the subdomain, it is also the marketing site's competitor
// for names. Everything here is either already spoken for by the product, likely
// to be, or actively dangerous to hand to a stranger -- `admin`, `login` and
// `billing` on the platform's own domain are phishing kits.
export const RESERVED_SUBDOMAINS = new Set([
  // the platform itself
  "www", "app", "admin", "api", "auth", "id", "login", "signup", "account",
  "accounts", "billing", "dashboard", "my", "go", "link", "status", "health",
  // things we will want
  "docs", "doc", "help", "support", "blog", "news", "about", "pricing",
  "careers", "jobs", "legal", "privacy", "terms", "security", "changelog",
  "community", "forum", "partners", "press", "brand", "roadmap",
  // infrastructure names that confuse tooling or invite spoofing
  "mail", "smtp", "imap", "pop", "webmail", "email", "mx", "ns", "ns1", "ns2",
  "dns", "cdn", "assets", "static", "media", "img", "images", "files", "download",
  "ftp", "ssh", "vpn", "proxy", "gateway", "origin", "edge", "cache",
  "dev", "staging", "stage", "test", "testing", "qa", "sandbox", "preview",
  "local", "localhost", "internal", "private", "secure", "ssl", "cert",
  "beta", "alpha", "demo", "example", "template", "templates", "site", "sites",
]);

/**
 * Which site should serve this request?
 *
 * The apex and `www` both resolve to the marketing site, so quickieweb.com and
 * www.quickieweb.com are one site rather than two copies that drift.
 *
 * Returns null for a host we do not recognise -- which today means any custom
 * domain. Null must be treated as "no site", never as "the default site": a
 * fallback here would serve one tenant's content under another tenant's name.
 */
export function hostToSiteId(host, hostedDomain) {
  const h = String(host ?? "").toLowerCase().split(":")[0].replace(/\.$/, "");
  const base = String(hostedDomain ?? "").toLowerCase().replace(/\.$/, "");
  if (!h || !base) return null;

  if (h === base || h === `www.${base}`) return "www";
  if (!h.endsWith(`.${base}`)) return null;

  const label = h.slice(0, -(base.length + 1));
  // One label only. A wildcard certificate covers `a.example.com` and not
  // `a.b.example.com`, so a deeper name would fail TLS before it got here.
  if (label.includes(".")) return null;
  return SITE_ID_RE.test(label) ? label : null;
}

/** The hostname a site is served at. */
export const hostForSite = (siteId, hostedDomain) =>
  siteId === "www" ? hostedDomain : `${siteId}.${hostedDomain}`;

/**
 * Is this id available to hand out? Reserved names are refused even to staff:
 * the point is that they never become a tenant's, not that they are hard to get.
 */
export function checkSiteId(siteId) {
  const id = String(siteId ?? "").toLowerCase();
  if (RESERVED_SUBDOMAINS.has(id)) return `"${id}" is reserved by the platform`;
  if (!SITE_ID_RE.test(id)) {
    return "must be 3-40 characters, lowercase letters, digits and hyphens, not starting or ending with a hyphen";
  }
  // Punycode prefix: xn-- is how an internationalized domain is encoded, and
  // accepting it raw invites homograph lookalikes of other tenants.
  if (id.startsWith("xn--")) return "cannot start with xn--";
  if (id.includes("--")) return "cannot contain a double hyphen";
  return null;
}

const str = (v, fallback = "") => (typeof v === "string" ? v : fallback);

/**
 * Where a site's content lives. Two drivers, one interface -- this is the single
 * difference between the self-hosted product and the hosted one, and confining
 * it to a record field is what keeps the open-source version from decaying into
 * a demo of the hosted version.
 *
 *   buckets  the site owns a staging bucket, a live bucket and a distribution.
 *            Isolation is enforced by IAM, so a routing bug cannot cross
 *            tenants. Caps out around 1000 buckets / 200 distributions per AWS
 *            account, which is the right trade when you run a handful of sites.
 *
 *   prefix   the site is a key prefix inside shared staging and live buckets,
 *            behind a shared distribution that maps Host -> prefix at the edge.
 *            Scales without limit; isolation is enforced by this code, so every
 *            key a request touches must be built through keyFor() below and
 *            never by string concatenation at the call site.
 */
export function normalizeStorage(raw = {}) {
  const driver = STORAGE_DRIVERS.includes(raw.driver) ? raw.driver : "buckets";
  const common = {
    driver,
    region: str(raw.region, "us-west-2"),
    distributionId: str(raw.distributionId),
    distributionDomain: str(raw.distributionDomain),
    logBucket: str(raw.logBucket),
  };

  if (driver === "prefix") {
    return {
      ...common,
      stagingBucket: str(raw.stagingBucket),
      liveBucket: str(raw.liveBucket),
      // Always a trailing slash: every key join below depends on it, and a
      // prefix of "sites/a" would happily match "sites/abc".
      prefix: str(raw.prefix).replace(/^\/+|\/+$/g, "") + "/",
    };
  }
  return {
    ...common,
    stagingBucket: str(raw.stagingBucket),
    liveBucket: str(raw.liveBucket),
    prefix: "",
  };
}

/**
 * The one place a storage key is built. Both drivers go through it, so the
 * prefix driver's isolation is a property of this function rather than of every
 * caller remembering.
 */
export function keyFor(storage, key) {
  const clean = String(key).replace(/^\/+/, "");
  if (clean.includes("..")) throw new Error(`Refusing to build a key containing "..": ${key}`);
  return storage.driver === "prefix" ? `${storage.prefix}${clean}` : clean;
}

/** The inverse: a bucket key back to a site-relative key, or null if foreign. */
export function unkeyFor(storage, key) {
  if (storage.driver !== "prefix") return key;
  return key.startsWith(storage.prefix) ? key.slice(storage.prefix.length) : null;
}

export function normalizeMembers(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const m of list) {
    const email = str(m?.email).trim().toLowerCase();
    if (!EMAIL_RE.test(email) || seen.has(email)) continue;
    seen.add(email);
    out.push({
      email,
      role: SITE_ROLES.includes(m.role) ? m.role : "editor",
      name: str(m.name),
      added: str(m.added, new Date().toISOString()),
    });
  }
  return out;
}

export function normalizeSite(raw = {}, { now = new Date().toISOString() } = {}) {
  const site = raw.site ?? {};
  return {
    siteId: str(raw.siteId),
    status: raw.status === "suspended" ? "suspended" : "active",
    createdAt: str(raw.createdAt, now),
    updatedAt: str(raw.updatedAt, now),

    // Reader-visible identity. Everything a template can print comes from here.
    site: {
      name: str(site.name),
      shortName: str(site.shortName, str(site.name)),
      tagline: str(site.tagline),
      description: str(site.description),
      domain: str(site.domain),
      baseUrl: str(site.baseUrl).replace(/\/+$/, ""),
      author: str(site.author),
      authorUrl: str(site.authorUrl),
      org: str(site.org),
      orgUrl: str(site.orgUrl),
      locale: str(site.locale, "en-US"),
      language: str(site.language, "en-us"),
      nav: Array.isArray(site.nav)
        ? site.nav.filter((n) => n?.label && n?.href)
            .map((n) => ({ label: str(n.label), href: str(n.href), external: Boolean(n.external) }))
        : [],
      podcast: {
        category: str(site.podcast?.category, "Technology"),
        explicit: Boolean(site.podcast?.explicit),
      },
    },

    taxonomy: { categories: normalizeCategories(raw.taxonomy?.categories) },

    template: {
      id: str(raw.template?.id, "journal"),
      // Empty means "whatever the library says is current". A site can pin a
      // version so a library update cannot change its appearance overnight.
      version: str(raw.template?.version),
    },
    // Token overrides. Validated against the template's manifest at render time,
    // not here: which keys are legal depends on which template is active.
    theme: raw.theme && typeof raw.theme === "object" ? raw.theme : {},

    storage: normalizeStorage(raw.storage),
    members: normalizeMembers(raw.members),
  };
}

/**
 * A brand-new hosted site, ready to write to the registry.
 *
 * Everything a tenant gets is derived from its id and the platform config, so
 * provisioning is one registry write plus a rebuild -- no bucket to create, no
 * certificate to request, no distribution to wait on. That is the whole reason
 * the hosted product uses the prefix driver.
 */
export function newSiteRecord({ siteId, name, ownerEmail, ownerName = "", hosted, template = "journal", now = new Date().toISOString() }) {
  const host = hostForSite(siteId, hosted.domain);
  return normalizeSite({
    siteId,
    createdAt: now,
    updatedAt: now,
    site: {
      name: name || siteId,
      shortName: name || siteId,
      domain: host,
      baseUrl: `https://${host}`,
      locale: "en-US",
      language: "en-us",
      nav: [{ label: "Archive", href: "/" }],
    },
    template: { id: template, version: "" },
    theme: {},
    storage: {
      driver: "prefix",
      region: hosted.region,
      stagingBucket: hosted.stagingBucket,
      liveBucket: hosted.liveBucket,
      prefix: `sites/${siteId}`,
      distributionId: hosted.distributionId ?? "",
      distributionDomain: hosted.distributionDomain ?? "",
      logBucket: hosted.logBucket ?? "",
    },
    members: [{ email: ownerEmail, role: "owner", name: ownerName, added: now }],
  }, { now });
}

function normalizeCategories(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    const label = typeof value === "string" ? value : str(value?.label);
    if (label) out[key] = { label };
  }
  return out;
}

export function validateSite(record) {
  const problems = [];
  if (!SITE_ID_RE.test(record.siteId ?? "")) {
    problems.push("siteId must be lowercase letters, digits and hyphens, 4-40 chars");
  }
  if (!record.site.name?.trim()) problems.push("site.name is required");
  if (!/^https:\/\/[^/\s]+$/.test(record.site.baseUrl ?? "")) {
    problems.push("site.baseUrl must be an https origin with no trailing path");
  }
  if (!record.members.some((m) => m.role === "owner")) {
    problems.push("a site needs at least one owner");
  }

  const s = record.storage;
  if (!s.stagingBucket) problems.push("storage.stagingBucket is required");
  if (!s.liveBucket) problems.push("storage.liveBucket is required");
  if (s.driver === "prefix") {
    if (s.prefix === "/") problems.push("storage.prefix is required for the prefix driver");
    if (s.stagingBucket === s.liveBucket) {
      problems.push("staging and live must be different buckets even under the prefix driver");
    }
  }
  return problems;
}

// ------------------------------------------------------------------- people
//
// User records are keyed by a hash of the address, not the address. An S3 key
// turns up in access logs, CloudTrail, bucket listings and error messages, and
// an email address in all of those is a needless disclosure.
//
// This lives here, in the one module with no dependencies, because BOTH the
// Lambda and the out-of-band bootstrap script have to derive the same key. Two
// copies of this formula that drift by one character means promoting somebody
// to staff writes an object nothing ever reads.
export function userKeyFor(email, sha256Hex) {
  const addr = String(email ?? "").trim().toLowerCase();
  return `accounts/users/${sha256Hex(addr).slice(0, 32)}.json`;
}

export const siteKeyFor = (siteId) => `accounts/sites/${siteId}.json`;

export function normalizeUser(raw = {}, { now = new Date().toISOString() } = {}) {
  return {
    email: str(raw.email).trim().toLowerCase(),
    name: str(raw.name),
    platformRole: PLATFORM_ROLES.includes(raw.platformRole) ? raw.platformRole : "user",
    siteIds: Array.isArray(raw.siteIds) ? raw.siteIds.filter((s) => SITE_ID_RE.test(s)) : [],
    createdAt: str(raw.createdAt, now),
    lastSeenAt: str(raw.lastSeenAt),
  };
}

/**
 * The authorization decision, in one place.
 *
 * "Users only see the sites they already know" is enforced here and nowhere
 * else: the caller asks for a site, this returns their role in it or null, and
 * every route is a function of that answer. A listing route filters through the
 * same rule, so a site nobody has been added to is not merely hidden -- it is
 * unaddressable.
 *
 * Platform staff are deliberately NOT granted implicit access. Support reaching
 * into a customer's site has to be an explicit membership someone can audit.
 */
export function roleInSite(email, siteRecord) {
  const addr = String(email ?? "").trim().toLowerCase();
  if (!addr || siteRecord?.status !== "active") return null;
  return siteRecord.members.find((m) => m.email === addr)?.role ?? null;
}

export const canEdit = (role) => role === "owner" || role === "editor";
export const canAdminister = (role) => role === "owner";

/** Membership changes that would strand a site. */
export function validateMemberChange(nextMembers, actorEmail) {
  const problems = [];
  const owners = nextMembers.filter((m) => m.role === "owner");
  if (!owners.length) problems.push("a site must keep at least one owner");
  const actor = String(actorEmail).toLowerCase();
  if (owners.length === 1 && owners[0].email === actor && !nextMembers.some((m) => m.email === actor)) {
    problems.push("you cannot remove the last owner, including yourself");
  }
  return problems;
}
