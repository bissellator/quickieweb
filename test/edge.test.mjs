// The tenant-routing CloudFront Function.
//
//   node --test test/edge.test.mjs
//
// The deployed artifact is a bare `function handler(event)` with no imports,
// because that is what CloudFront runs. So the test loads the source and
// evaluates it rather than importing it -- which keeps the shipped file exactly
// what CloudFront needs instead of bending it into a module for the test's
// convenience.
//
// The last test in this file is the important one: the edge function and
// shared/site.mjs must agree about what a valid site label is. If they drift,
// the admin writes to one prefix and readers are served from another, and the
// symptom is a site that saves successfully and stays blank.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { hostToSiteId } from "../shared/site.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APEX = "quickieweb.com";

const source = readFileSync(path.join(ROOT, "infra", "edge", "tenant-router.js"), "utf8")
  .replace("__APEX__", APEX);
// eslint-disable-next-line no-new-func -- our own file, in a test, on purpose.
const handler = new Function(`${source}; return handler;`)();

const req = (host, uri = "/") => handler({
  request: { uri, headers: host === null ? {} : { host: { value: host } } },
});

// -------------------------------------------------------------- the apex
test("the apex serves the marketing site", () => {
  assert.equal(req("quickieweb.com", "/").uri, "/sites/www/index.html");
  assert.equal(req("quickieweb.com", "/pricing.html").uri, "/sites/www/pricing.html");
});

test("www redirects to the apex, preserving the path", () => {
  const res = req("www.quickieweb.com", "/pricing.html");
  assert.equal(res.statusCode, 301);
  assert.equal(res.headers.location.value, "https://quickieweb.com/pricing.html");
});

test("the redirect is not a loop", () => {
  const first = req("www.quickieweb.com", "/");
  const target = new URL(first.headers.location.value);
  const second = req(target.hostname, target.pathname);
  assert.ok(second.uri, "the apex must serve, not redirect again");
  assert.equal(second.uri, "/sites/www/index.html");
});

// ------------------------------------------------------------- tenants
test("a subdomain maps to its own prefix", () => {
  assert.equal(req("acme.quickieweb.com", "/").uri, "/sites/acme/index.html");
  assert.equal(req("acme.quickieweb.com", "/2026-01-01-hello.html").uri,
    "/sites/acme/2026-01-01-hello.html");
  assert.equal(req("acme.quickieweb.com", "/assets/style.css").uri,
    "/sites/acme/assets/style.css");
});

test("two tenants never collide", () => {
  assert.notEqual(req("acme.quickieweb.com", "/index.html").uri,
                  req("beta.quickieweb.com", "/index.html").uri);
});

test("a directory path gets an index, at any depth", () => {
  assert.equal(req("acme.quickieweb.com", "/").uri, "/sites/acme/index.html");
  assert.equal(req("acme.quickieweb.com", "/docs/").uri, "/sites/acme/docs/index.html");
});

test("Host is normalized before it is matched", () => {
  assert.equal(req("ACME.QuickieWeb.com").uri, "/sites/acme/index.html");
  assert.equal(req("acme.quickieweb.com:443").uri, "/sites/acme/index.html");
  assert.equal(req("acme.quickieweb.com.").uri, "/sites/acme/index.html", "trailing dot is legal in a Host header");
});

// ------------------------------------------------------------- refusals
test("an unknown host gets 404, never a default site", () => {
  for (const host of [
    "example.com",
    "quickieweb.com.evil.test",
    "notquickieweb.com",
    "evilquickieweb.com",
    "",
  ]) {
    const res = req(host);
    assert.equal(res.statusCode, 404, `host "${host}" must not resolve to a site`);
    assert.ok(!res.uri, "and must not be forwarded to the origin");
  }
});

test("a missing Host header gets 404", () => {
  assert.equal(req(null).statusCode, 404);
});

test("a deeper label is refused -- the wildcard cert does not cover it", () => {
  // a.b.quickieweb.com would fail TLS before reaching us, but a Host header is
  // attacker-controlled and this must not become a path traversal.
  const res = req("a.b.quickieweb.com");
  assert.equal(res.statusCode, 404);
});

test("a label that could escape the prefix is refused", () => {
  for (const host of [
    "../etc.quickieweb.com",
    "a/b.quickieweb.com",
    "..quickieweb.com",
    "-lead.quickieweb.com",
    "trail-.quickieweb.com",
    "ab.quickieweb.com",
  ]) {
    const res = req(host);
    assert.equal(res.statusCode, 404, `host "${host}" must be refused`);
  }
});

test("the 404 body is served from the edge, not the origin", () => {
  const res = req("example.com");
  assert.match(res.body, /No site here/);
  assert.equal(res.headers["content-type"].value, "text/html; charset=utf-8");
  // Cached briefly: a wrong host is usually a scanner, and paying for an origin
  // round trip per probe is the avoidable half of that traffic.
  assert.match(res.headers["cache-control"].value, /max-age/);
});

// --------------------------------------------------------------- the pact
test("the edge and shared/site.mjs agree on every label", () => {
  const labels = [
    "acme", "abc", "a-b-c", "site1", "2026", "a".repeat(40),
    "ab", "a", "", "-lead", "trail-", "UPPER", "under_score", "has space",
    "a".repeat(41), "xn--80ak6aa92e", "ac--me", "a.b",
  ];

  for (const label of labels) {
    const host = `${label}.${APEX}`;
    const fromShared = hostToSiteId(host, APEX);
    const res = req(host);
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
