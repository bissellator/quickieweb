// The tenant-routing CloudFront Function.
//
//   node --test test/edge.test.mjs
//
// The deployed artifact is a single file CloudFront runs as-is, so the test
// loads the source and evaluates it rather than importing it -- which keeps the
// shipped file exactly what CloudFront needs instead of bending it into a module
// for the test's convenience. Its two imports (`cloudfront` for the edge store
// and `crypto`) are swapped for an in-memory store and node:crypto, which has
// the same createHmac.
//
// Two pacts are tested at the bottom, and they are the important ones:
//   - the edge and shared/site.mjs agree about what a valid site label is. If
//     they drift, the admin writes to one prefix and readers are served from
//     another, and the symptom is a site that saves successfully and stays blank.
//   - the edge and shared/access-token.mjs agree about tokens. If they drift,
//     everyone who signs in bounces straight back to the sign-in page.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";

import { hostToSiteId } from "../shared/site.mjs";
import { signAccessToken, signGrant, verifyAccessToken, SESSION_SEC } from "../shared/access-token.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APEX = "quickieweb.com";
const SECRET = "test-secret-0123456789abcdef";

// ---------------------------------------------------------------- harness
const store = new Map();
let kvsBroken = false;
let kvsReads = 0;
const fakeCf = {
  kvs: () => ({
    exists: async (k) => { kvsReads++; if (kvsBroken) throw new Error("store unavailable"); return store.has(k); },
    get: async (k) => { kvsReads++; if (kvsBroken) throw new Error("store unavailable"); if (!store.has(k)) throw new Error("key not found"); return store.get(k); },
  }),
};

const source = readFileSync(path.join(ROOT, "infra", "edge", "tenant-router.js"), "utf8")
  .replace("__APEX__", APEX)
  .replace(/^import cf from 'cloudfront';$/m, "")
  .replace(/^import crypto from 'crypto';$/m, "");
// eslint-disable-next-line no-new-func -- our own file, in a test, on purpose.
const handler = new Function("cf", "crypto", `${source}; return handler;`)(fakeCf, crypto);

const reset = (entries = {}) => {
  store.clear();
  kvsBroken = false;
  kvsReads = 0;
  for (const [k, v] of Object.entries(entries)) store.set(k, v);
};

const req = (host, uri = "/", { cookie, query, method = "GET" } = {}) => handler({
  request: {
    uri,
    method,
    headers: host === null ? {} : { host: { value: host } },
    cookies: cookie ? { qw_access: { value: cookie } } : {},
    querystring: Object.fromEntries(Object.entries(query ?? {}).map(([k, v]) => [k, { value: v }])),
  },
});

const session = (siteId, level, { ttlSec = 3600, secret = SECRET, kind = "v1" } = {}) =>
  signAccessToken({ kind, siteId, level, ttlSec, secret });

test.beforeEach(() => reset());

// -------------------------------------------------------------- the apex
test("the apex serves the marketing site", async () => {
  assert.equal((await req("quickieweb.com", "/")).uri, "/sites/www/index.html");
  assert.equal((await req("quickieweb.com", "/pricing.html")).uri, "/sites/www/pricing.html");
});

test("www redirects to the apex, preserving the path", async () => {
  const res = await req("www.quickieweb.com", "/pricing.html");
  assert.equal(res.statusCode, 301);
  assert.equal(res.headers.location.value, "https://quickieweb.com/pricing.html");
});

test("the redirect is not a loop", async () => {
  const first = await req("www.quickieweb.com", "/");
  const target = new URL(first.headers.location.value);
  const second = await req(target.hostname, target.pathname);
  assert.ok(second.uri, "the apex must serve, not redirect again");
  assert.equal(second.uri, "/sites/www/index.html");
});

// ------------------------------------------------------------- tenants
test("a subdomain maps to its own prefix", async () => {
  assert.equal((await req("acme.quickieweb.com", "/")).uri, "/sites/acme/index.html");
  assert.equal((await req("acme.quickieweb.com", "/2026-01-01-hello.html")).uri,
    "/sites/acme/2026-01-01-hello.html");
  assert.equal((await req("acme.quickieweb.com", "/assets/style.css")).uri,
    "/sites/acme/assets/style.css");
});

test("two tenants never collide", async () => {
  assert.notEqual((await req("acme.quickieweb.com", "/index.html")).uri,
                  (await req("beta.quickieweb.com", "/index.html")).uri);
});

test("a directory path gets an index, at any depth", async () => {
  assert.equal((await req("acme.quickieweb.com", "/")).uri, "/sites/acme/index.html");
  assert.equal((await req("acme.quickieweb.com", "/docs/")).uri, "/sites/acme/docs/index.html");
});

test("Host is normalized before it is matched", async () => {
  assert.equal((await req("ACME.QuickieWeb.com")).uri, "/sites/acme/index.html");
  assert.equal((await req("acme.quickieweb.com:443")).uri, "/sites/acme/index.html");
  assert.equal((await req("acme.quickieweb.com.")).uri, "/sites/acme/index.html", "trailing dot is legal in a Host header");
});

// ------------------------------------------------------------- platform libraries
test("/__qw/lib/ serves one shared copy from the bucket root, on every host", async () => {
  assert.equal((await req("quickieweb.com", "/__qw/lib/comments.js")).uri, "/lib/comments.js");
  assert.equal((await req("acme.quickieweb.com", "/__qw/lib/comments.js")).uri, "/lib/comments.js");
});

test("a platform library is public even on a protected site", async () => {
  reset({ _secret: SECRET, acme: "viewer" });
  assert.equal((await req("acme.quickieweb.com", "/__qw/lib/comments.js")).uri, "/lib/comments.js");
  assert.equal((await req("acme.quickieweb.com", "/__qw/lib/../index.html")).statusCode, 404);
});

test("only a plain .js file name is served from /__qw/lib/", async () => {
  for (const uri of [
    "/__qw/lib/", "/__qw/lib/../sites/acme/index.html", "/__qw/lib/a/b.js", "/__qw/lib/x.html",
    "/__qw/lib/%2e%2e/x.js", "/__qw/lib/COMMENTS.js", "/__qw/lib/.js",
  ]) {
    const res = await req("acme.quickieweb.com", uri);
    assert.equal(res.statusCode, 404, `${uri} must be refused`);
    assert.ok(!res.uri, `${uri} must not reach the origin`);
  }
});

// ------------------------------------------------------------- refusals
test("an unknown host gets 404, never a default site", async () => {
  for (const host of [
    "example.com",
    "quickieweb.com.evil.test",
    "notquickieweb.com",
    "evilquickieweb.com",
    "",
  ]) {
    const res = await req(host);
    assert.equal(res.statusCode, 404, `host "${host}" must not resolve to a site`);
    assert.ok(!res.uri, "and must not be forwarded to the origin");
  }
});

test("a missing Host header gets 404", async () => {
  assert.equal((await req(null)).statusCode, 404);
});

test("a deeper label is refused -- the wildcard cert does not cover it", async () => {
  // a.b.quickieweb.com would fail TLS before reaching us, but a Host header is
  // attacker-controlled and this must not become a path traversal.
  const res = await req("a.b.quickieweb.com");
  assert.equal(res.statusCode, 404);
});

test("a label that could escape the prefix is refused", async () => {
  for (const host of [
    "../etc.quickieweb.com",
    "a/b.quickieweb.com",
    "..quickieweb.com",
    "-lead.quickieweb.com",
    "trail-.quickieweb.com",
    "ab.quickieweb.com",
  ]) {
    const res = await req(host);
    assert.equal(res.statusCode, 404, `host "${host}" must be refused`);
  }
});

test("the 404 body is served from the edge, not the origin", async () => {
  const res = await req("example.com");
  assert.match(res.body, /No site here/);
  assert.equal(res.headers["content-type"].value, "text/html; charset=utf-8");
  // Cached briefly: a wrong host is usually a scanner, and paying for an origin
  // round trip per probe is the avoidable half of that traffic.
  assert.match(res.headers["cache-control"].value, /max-age/);
});

// ---------------------------------------------------------------- access
test("a site with no access entry is public, at the cost of one lookup", async () => {
  const res = await req("acme.quickieweb.com", "/post.html");
  assert.equal(res.uri, "/sites/acme/post.html");
  assert.equal(kvsReads, 1, "public sites are the common case and must stay cheap");
});

test("a protected site sends a stranger to sign in, and comes back to the same page", async () => {
  reset({ acme: "viewer", _secret: SECRET });
  const res = await req("acme.quickieweb.com", "/docs/");
  assert.equal(res.statusCode, 302);
  const to = new URL(res.headers.location.value);
  assert.equal(to.origin, "https://app.quickieweb.com");
  assert.equal(to.pathname, "/access.html");
  assert.equal(to.searchParams.get("site"), "acme");
  assert.equal(to.searchParams.get("next"), "/docs/", "the page asked for, not its index.html rewrite");
  assert.ok(!res.uri, "nothing is forwarded to the origin");
});

test("only a page load is redirected; anything else is a plain 401", async () => {
  reset({ acme: "viewer", _secret: SECRET });
  assert.equal((await req("acme.quickieweb.com", "/feed.xml", { method: "POST" })).statusCode, 401);
});

test("a reader at or above the level is let through", async () => {
  reset({ acme: "viewer", _secret: SECRET });
  for (const level of ["viewer", "editor", "admin"]) {
    const res = await req("acme.quickieweb.com", "/post.html", { cookie: session("acme", level) });
    assert.equal(res.uri, "/sites/acme/post.html", `${level} reads a viewer site`);
  }
});

test("a page can be stricter than its site", async () => {
  reset({ acme: "viewer", "acme/team.html": "editor", _secret: SECRET });
  const asViewer = await req("acme.quickieweb.com", "/team.html", { cookie: session("acme", "viewer") });
  assert.equal(asViewer.statusCode, 403);
  assert.match(asViewer.body, /needs <strong>editor<\/strong>/);
  assert.match(asViewer.body, /switch=1/, "offers to sign in as someone else");
  const asEditor = await req("acme.quickieweb.com", "/team.html", { cookie: session("acme", "editor") });
  assert.equal(asEditor.uri, "/sites/acme/team.html");
  const elsewhere = await req("acme.quickieweb.com", "/post.html", { cookie: session("acme", "viewer") });
  assert.equal(elsewhere.uri, "/sites/acme/post.html", "the override is for that page only");
});

test("a page can be more open than its site", async () => {
  reset({ acme: "viewer", "acme/about.html": "public", _secret: SECRET });
  assert.equal((await req("acme.quickieweb.com", "/about.html")).uri, "/sites/acme/about.html");
});

test("a public site can protect a single page", async () => {
  reset({ acme: "public", "acme/team.html": "admin", _secret: SECRET });
  assert.equal((await req("acme.quickieweb.com", "/index.html")).uri, "/sites/acme/index.html");
  assert.equal((await req("acme.quickieweb.com", "/team.html")).statusCode, 302);
});

test("the site index is guarded under its real key", async () => {
  reset({ acme: "public", "acme/index.html": "viewer", _secret: SECRET });
  assert.equal((await req("acme.quickieweb.com", "/")).statusCode, 302, "/ is /index.html to the store");
});

test("an unknown level in the store locks rather than opens", async () => {
  reset({ acme: "vewer", _secret: SECRET });
  const res = await req("acme.quickieweb.com", "/post.html", { cookie: session("acme", "editor") });
  assert.equal(res.statusCode, 403, "a typo in the store must never open a page");
});

test("a cookie is worthless on another site", async () => {
  reset({ acme: "viewer", _secret: SECRET });
  const res = await req("acme.quickieweb.com", "/post.html", { cookie: session("beta", "admin") });
  assert.equal(res.statusCode, 302);
});

test("a tampered, forged, expired or over-long cookie is refused", async () => {
  reset({ acme: "viewer", _secret: SECRET });
  const good = session("acme", "viewer");
  const bad = [
    good.replace(".viewer.", ".admin."),                                  // raised its own level
    session("acme", "viewer", { secret: "someone-elses-secret" }),       // forged
    session("acme", "viewer", { ttlSec: -10 }),                           // expired
    session("acme", "viewer", { ttlSec: SESSION_SEC * 10 }),              // lives too long
    session("acme", "viewer", { kind: "g1" }),                            // a grant, not a session
    `${good}.extra`, "", "garbage",
  ];
  for (const cookie of bad) {
    const res = await req("acme.quickieweb.com", "/post.html", { cookie });
    assert.equal(res.statusCode, 302, `refused: ${cookie.slice(0, 40)}`);
  }
});

test("a grant becomes a host-only session cookie and lands on the page asked for", async () => {
  reset({ _secret: SECRET });
  const g = signGrant({ siteId: "acme", level: "editor", secret: SECRET });
  const res = await req("acme.quickieweb.com", "/__qw/session", { query: { g, next: "/team.html" } });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location.value, "/team.html");
  const c = res.cookies.qw_access;
  assert.match(c.attributes, /Secure/);
  assert.match(c.attributes, /HttpOnly/);
  assert.match(c.attributes, /SameSite=Lax/);
  assert.ok(!/Domain=/i.test(c.attributes), "host-only: no other tenant ever receives it");
  assert.equal(verifyAccessToken(c.value, { kind: "v1", siteId: "acme", maxSec: SESSION_SEC, secret: SECRET }), "editor",
    "the cookie the edge mints is one the shared code accepts");

  reset({ acme: "editor", _secret: SECRET });
  assert.equal((await req("acme.quickieweb.com", "/team.html", { cookie: c.value })).uri, "/sites/acme/team.html");
});

test("a grant for another site, an expired grant, or a session posing as one is refused", async () => {
  reset({ _secret: SECRET });
  for (const g of [
    signGrant({ siteId: "beta", level: "admin", secret: SECRET }),
    signAccessToken({ kind: "g1", siteId: "acme", level: "admin", ttlSec: -1, secret: SECRET }),
    signAccessToken({ kind: "g1", siteId: "acme", level: "admin", ttlSec: 3600, secret: SECRET }), // too long-lived for a grant
    session("acme", "admin"),
  ]) {
    const res = await req("acme.quickieweb.com", "/__qw/session", { query: { g, next: "/" } });
    assert.equal(res.statusCode, 403);
    assert.ok(!res.cookies, "no cookie is set");
  }
});

test("after sign-in the redirect never leaves the site", async () => {
  reset({ _secret: SECRET });
  for (const next of ["//evil.test/x", "https://evil.test/", "/\\evil.test", "evil", ""]) {
    const g = signGrant({ siteId: "acme", level: "viewer", secret: SECRET });
    const res = await req("acme.quickieweb.com", "/__qw/session", { query: { g, next } });
    assert.equal(res.headers.location.value, "/", `next=${JSON.stringify(next)} must not be followed`);
  }
});

test("sign-out clears the cookie", async () => {
  const res = await req("acme.quickieweb.com", "/__qw/signout");
  assert.equal(res.statusCode, 302);
  assert.equal(res.cookies.qw_access.value, "");
  assert.match(res.cookies.qw_access.attributes, /Max-Age=0/);
});

test("if the store cannot be read, the request fails rather than serving", async () => {
  reset({ acme: "viewer" });
  kvsBroken = true;
  await assert.rejects(() => req("acme.quickieweb.com", "/post.html"),
    "a thrown function is a 503 from CloudFront -- an outage must never open a protected page");
});

test("a protected site without a secret refuses rather than trusting any cookie", async () => {
  reset({ acme: "viewer" });
  await assert.rejects(() => req("acme.quickieweb.com", "/post.html", { cookie: session("acme", "admin") }));
});

// --------------------------------------------------------------- the pacts
test("the edge and shared/site.mjs agree on every label", async () => {
  const labels = [
    "acme", "abc", "a-b-c", "site1", "2026", "a".repeat(40),
    "ab", "a", "", "-lead", "trail-", "UPPER", "under_score", "has space",
    "a".repeat(41), "xn--80ak6aa92e", "ac--me", "a.b",
  ];

  for (const label of labels) {
    const host = `${label}.${APEX}`;
    const fromShared = hostToSiteId(host, APEX);
    const res = await req(host);
    const fromEdge = res.uri ? res.uri.replace(/^\/sites\/([^/]+)\/.*$/, "$1") : null;

    // hostToSiteId is the stricter of the two by design: it also rejects
    // punycode and double hyphens, which the edge cannot cheaply check. What
    // must never happen is the reverse -- the edge routing a label that the
    // admin would refuse to create, or refusing one it would.
    if (fromEdge !== null) {
      assert.ok(fromShared !== null || /^(xn--|.*--)/.test(label),
        `edge routes "${label}" to a prefix the admin would never write to`);
    }
    if (fromShared !== null) {
      assert.equal(fromEdge, fromShared,
        `shared/site.mjs resolves "${label}" but the edge does not agree`);
    }
  }
});

test("the edge and shared/access-token.mjs agree on tokens", async () => {
  reset({ acme: "editor", _secret: SECRET });
  for (const level of ["public", "viewer", "editor", "admin"]) {
    const cookie = signAccessToken({ kind: "v1", siteId: "acme", level, ttlSec: 60, secret: SECRET });
    const res = await req("acme.quickieweb.com", "/x.html", { cookie });
    const edgeLets = Boolean(res.uri);
    const sharedLevel = verifyAccessToken(cookie, { kind: "v1", siteId: "acme", maxSec: SESSION_SEC, secret: SECRET });
    assert.equal(sharedLevel, level);
    assert.equal(edgeLets, level === "editor" || level === "admin", `${level} on an editor page`);
  }
});

test("the deployed function fits CloudFront's 10 KB limit once comments are stripped", () => {
  const stripped = source.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.ok(Buffer.byteLength(stripped) < 10240, `${Buffer.byteLength(stripped)} bytes`);
});
