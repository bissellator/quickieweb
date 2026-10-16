// Multi-tenancy: host resolution, id rules, key isolation, access decisions.
//
//   node --test test/tenancy.test.mjs
//
// Every test here guards a property whose failure mode is one customer seeing
// or overwriting another customer's site. They are worth more than their number
// suggests.

import test from "node:test";
import assert from "node:assert/strict";

import {
  hostToSiteId, hostForSite, checkSiteId, newSiteRecord, RESERVED_SUBDOMAINS,
  keyFor, unkeyFor, normalizeSite, validateSite, roleInSite,
  normalizeMembers, validateMemberChange, normalizeUser, canEdit, canAdminister,
  userKeyFor, siteKeyFor,
} from "../shared/site.mjs";

const HOSTED = {
  domain: "quickieweb.com",
  region: "us-west-2",
  stagingBucket: "qw-sites-staging",
  liveBucket: "qw-sites-live",
  distributionId: "E123",
  distributionDomain: "d1.cloudfront.net",
  logBucket: "qw-sites-logs",
};

// ------------------------------------------------------- host -> which site
test("a subdomain names its site", () => {
  assert.equal(hostToSiteId("acme.quickieweb.com", "quickieweb.com"), "acme");
  assert.equal(hostToSiteId("ACME.QuickieWeb.com", "quickieweb.com"), "acme");
  assert.equal(hostToSiteId("acme.quickieweb.com:443", "quickieweb.com"), "acme");
  assert.equal(hostToSiteId("acme.quickieweb.com.", "quickieweb.com"), "acme");
});

test("the apex and www are one site, not two", () => {
  assert.equal(hostToSiteId("quickieweb.com", "quickieweb.com"), "www");
  assert.equal(hostToSiteId("www.quickieweb.com", "quickieweb.com"), "www");
});

test("an unknown host resolves to NO site, never to a default", () => {
  // This is the one that matters most: a fallback here serves one tenant's
  // content under another tenant's name.
  for (const host of [
    "example.com",
    "quickieweb.com.evil.test",
    "notquickieweb.com",
    "acme.quickieweb.com.evil.test",
    "",
    null,
    undefined,
  ]) {
    assert.equal(hostToSiteId(host, "quickieweb.com"), null, `host ${JSON.stringify(host)}`);
  }
});

test("a deeper label is refused, because the wildcard cert does not cover it", () => {
  assert.equal(hostToSiteId("a.b.quickieweb.com", "quickieweb.com"), null);
});

test("a host that is not a legal site id resolves to nothing", () => {
  assert.equal(hostToSiteId("-bad.quickieweb.com", "quickieweb.com"), null);
  assert.equal(hostToSiteId("ab.quickieweb.com", "quickieweb.com"), null, "too short");
  assert.equal(hostToSiteId("abc.quickieweb.com", "quickieweb.com"), "abc");
  assert.equal(hostToSiteId("UPPER.quickieweb.com", "quickieweb.com"), "upper", "case folded, then legal");
});

test("hostForSite is the inverse", () => {
  assert.equal(hostForSite("acme", "quickieweb.com"), "acme.quickieweb.com");
  assert.equal(hostForSite("www", "quickieweb.com"), "quickieweb.com");
  for (const id of ["acme", "www", "a-b-c"]) {
    assert.equal(hostToSiteId(hostForSite(id, "quickieweb.com"), "quickieweb.com"), id);
  }
});

// --------------------------------------------------------------- site ids
test("reserved names cannot be claimed", () => {
  for (const id of ["www", "admin", "api", "login", "billing", "mail", "cdn", "docs", "support"]) {
    assert.ok(checkSiteId(id)?.includes("reserved"), `${id} must be reserved`);
  }
  assert.ok(RESERVED_SUBDOMAINS.has("admin"));
});

test("id rules reject what would be confusing or dangerous", () => {
  assert.equal(checkSiteId("acme-co"), null);
  assert.equal(checkSiteId("a1b2c3"), null);

  assert.ok(checkSiteId("ab"), "too short");
  assert.equal(checkSiteId("abc"), null, "three characters is legal; the reserved list guards the valuable ones");
  assert.ok(checkSiteId("-lead"), "leading hyphen");
  assert.ok(checkSiteId("trail-"), "trailing hyphen");
  assert.ok(checkSiteId("Has Space"), "space");
  // Hostnames are case-insensitive, so mixed case is normalized rather than
  // refused -- "Acme" and "acme" must never be two different tenants.
  assert.equal(checkSiteId("ACME"), null);
  assert.ok(checkSiteId("WWW")?.includes("reserved"), "and reserved names are caught after folding");
  assert.ok(checkSiteId("under_score"), "underscore is not valid in a hostname");
  // xn-- is punycode: accepting it raw invites homograph lookalikes.
  assert.ok(checkSiteId("xn--80ak6aa92e"), "punycode");
  assert.ok(checkSiteId("ac--me"), "double hyphen");
  assert.ok(checkSiteId("a".repeat(64)), "too long");
});

// ---------------------------------------------------------- key isolation
test("prefix keys stay inside their own tenant", () => {
  const a = normalizeSite({ storage: { driver: "prefix", prefix: "sites/acme" } }).storage;
  const b = normalizeSite({ storage: { driver: "prefix", prefix: "sites/beta" } }).storage;

  assert.equal(keyFor(a, "index.html"), "sites/acme/index.html");
  assert.equal(keyFor(a, "/index.html"), "sites/acme/index.html", "a leading slash is not a new root");
  assert.equal(keyFor(b, "index.html"), "sites/beta/index.html");
  assert.notEqual(keyFor(a, "index.html"), keyFor(b, "index.html"));
});

test("traversal out of a tenant prefix throws rather than escaping", () => {
  const a = normalizeSite({ storage: { driver: "prefix", prefix: "sites/acme" } }).storage;
  for (const bad of ["../beta/index.html", "a/../../beta/x", ".."]) {
    assert.throws(() => keyFor(a, bad), /\.\./, `keyFor must refuse ${bad}`);
  }
});

test("unkeyFor does not mistake a sibling prefix for our own", () => {
  const a = normalizeSite({ storage: { driver: "prefix", prefix: "sites/ac" } }).storage;
  assert.equal(unkeyFor(a, "sites/ac/index.html"), "index.html");
  // "sites/ac" must not match "sites/acme" -- the trailing slash is what stops
  // one tenant's listing from swallowing another's.
  assert.equal(unkeyFor(a, "sites/acme/index.html"), null);
  assert.equal(unkeyFor(a, "sites/other/index.html"), null);
});

test("the buckets driver is a no-op prefix, so one code path serves both", () => {
  const s = normalizeSite({ storage: { driver: "buckets" } }).storage;
  assert.equal(s.prefix, "");
  assert.equal(keyFor(s, "index.html"), "index.html");
  assert.equal(unkeyFor(s, "index.html"), "index.html");
});

test("a prefix is always slash-terminated however it was written", () => {
  for (const given of ["sites/acme", "sites/acme/", "/sites/acme", "//sites/acme//"]) {
    assert.equal(normalizeSite({ storage: { driver: "prefix", prefix: given } }).storage.prefix,
      "sites/acme/", `given ${given}`);
  }
});

// ------------------------------------------------------------ new records
test("a new site derives everything from its id", () => {
  const rec = newSiteRecord({ siteId: "acme", name: "Acme", ownerEmail: "a@e.com", hosted: HOSTED });
  assert.equal(rec.siteId, "acme");
  assert.equal(rec.site.domain, "acme.quickieweb.com");
  assert.equal(rec.site.baseUrl, "https://acme.quickieweb.com");
  assert.equal(rec.storage.driver, "prefix");
  assert.equal(rec.storage.prefix, "sites/acme/");
  assert.equal(rec.storage.stagingBucket, "qw-sites-staging");
  assert.deepEqual(validateSite(rec), [], "a freshly created site must be valid");
  assert.equal(roleInSite("a@e.com", rec), "owner");
});

test("two new sites never share a prefix", () => {
  const a = newSiteRecord({ siteId: "acme", ownerEmail: "a@e.com", hosted: HOSTED });
  const b = newSiteRecord({ siteId: "beta", ownerEmail: "b@e.com", hosted: HOSTED });
  assert.notEqual(a.storage.prefix, b.storage.prefix);
  assert.equal(roleInSite("a@e.com", b), null, "a is a stranger to b");
});

// -------------------------------------------------------------- decisions
test("roleInSite is the whole visibility rule", () => {
  const site = newSiteRecord({ siteId: "acme", ownerEmail: "Owner@E.com", hosted: HOSTED });
  site.members.push({ email: "ed@e.com", role: "editor", name: "", added: "" });

  assert.equal(roleInSite("owner@e.com", site), "owner", "addresses fold case");
  assert.equal(roleInSite("  Owner@E.com  ", site), "owner", "and trim");
  assert.equal(roleInSite("ed@e.com", site), "editor");
  assert.equal(roleInSite("stranger@e.com", site), null);
  assert.equal(roleInSite("", site), null);
  assert.equal(roleInSite(null, site), null);
  assert.equal(roleInSite(undefined, site), null);
});

test("a suspended site grants nothing, including to its owner", () => {
  const site = newSiteRecord({ siteId: "acme", ownerEmail: "a@e.com", hosted: HOSTED });
  assert.equal(roleInSite("a@e.com", { ...site, status: "suspended" }), null);
});

test("role capabilities", () => {
  assert.ok(canEdit("owner") && canEdit("admin") && canEdit("editor"));
  assert.ok(!canEdit("viewer"), "a viewer reads the published site and never reaches the console");
  assert.ok(!canEdit(null) && !canEdit("staff"));
  assert.ok(canAdminister("owner") && canAdminister("admin"));
  assert.ok(!canAdminister("editor") && !canAdminister("viewer"));
});

test("member lists are deduped, case-folded and role-checked", () => {
  const members = normalizeMembers([
    { email: "A@E.com", role: "owner" },
    { email: "a@e.com", role: "editor" },   // duplicate, dropped
    // Unknown role -> viewer, the weakest. It used to become editor, which was
    // safe only while editor was the floor; now a typo would hand out the console.
    { email: "b@e.com", role: "wizard" },
    { email: "c@e.com", role: "admin" },
    { email: "not-an-email", role: "owner" },
    null,
  ]);
  assert.deepEqual(members.map((m) => [m.email, m.role]),
    [["a@e.com", "owner"], ["b@e.com", "viewer"], ["c@e.com", "admin"]]);
});

test("a site cannot be left ownerless", () => {
  assert.ok(validateMemberChange(normalizeMembers([{ email: "a@e.com", role: "editor" }]), "a@e.com").length);
  assert.deepEqual(validateMemberChange(normalizeMembers([{ email: "a@e.com", role: "owner" }]), "a@e.com"), []);
  assert.ok(validateMemberChange([], "a@e.com").length, "an empty list is not a valid member list");
});

test("a user record is an index, and its role is not self-assignable", () => {
  const u = normalizeUser({ email: "A@E.com", platformRole: "staff", siteIds: ["acme", "!!bad", "beta"] });
  assert.equal(u.email, "a@e.com");
  assert.deepEqual(u.siteIds, ["acme", "beta"], "malformed ids are dropped");

  const forged = normalizeUser({ email: "a@e.com", platformRole: "superuser" });
  assert.equal(forged.platformRole, "user", "an unknown platform role falls back to the least privilege");
});

// ------------------------------------------------------ record validation
test("validateSite refuses records that would break serving", () => {
  const ok = newSiteRecord({ siteId: "acme", ownerEmail: "a@e.com", hosted: HOSTED });
  assert.deepEqual(validateSite(ok), []);

  const httpUrl = normalizeSite({ ...ok, site: { ...ok.site, baseUrl: "http://acme.quickieweb.com" } });
  assert.ok(validateSite(httpUrl).some((p) => p.includes("baseUrl")));

  const withPath = normalizeSite({ ...ok, site: { ...ok.site, baseUrl: "https://acme.quickieweb.com/blog" } });
  assert.ok(validateSite(withPath).some((p) => p.includes("baseUrl")));

  const sameBucket = normalizeSite({
    ...ok, storage: { ...ok.storage, liveBucket: ok.storage.stagingBucket },
  });
  assert.ok(validateSite(sameBucket).some((p) => p.includes("different buckets")),
    "staging and live must differ even when both are prefixes");
});

// ------------------------------------------------------------- registry keys
test("the user key is derived in exactly one place", async () => {
  const { createHash } = await import("node:crypto");
  const sha = (s) => createHash("sha256").update(s).digest("hex");

  // The Lambda and the out-of-band bootstrap script both call this. If they ever
  // disagreed, promoting somebody to staff would write an object the Lambda
  // never reads, and the failure would look like "the flag did not take".
  const key = userKeyFor("Michael@Example.com", sha);
  assert.equal(key, userKeyFor("  michael@example.com  ", sha), "trimmed and case-folded");
  assert.match(key, /^accounts\/users\/[0-9a-f]{32}\.json$/);
  assert.ok(!key.includes("example.com"), "the address must not appear in the key");
  assert.notEqual(userKeyFor("a@e.com", sha), userKeyFor("b@e.com", sha));
});

test("site keys are a flat, traversal-free namespace", () => {
  assert.equal(siteKeyFor("acme"), "accounts/sites/acme.json");
  // checkSiteId is what guarantees the input; this asserts the pairing so a
  // future caller cannot pass an unchecked id and reach another prefix.
  assert.equal(checkSiteId("../evil"), "must be 3-40 characters, lowercase letters, digits and hyphens, not starting or ending with a hyphen");
});
