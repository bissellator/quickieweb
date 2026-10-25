// The comment-writing CloudFront Function: the only way a comment reaches S3.
//
//   node --test test/comment-writer.test.mjs
//
// Loaded as shipped, by test/comment-writer-harness.mjs. The pacts at the
// bottom are the ones that matter: the edge accepts exactly the tickets
// shared/comment-ticket.mjs signs, writes exactly the names and threads the
// readers accept, and holds the same limits the readers hold.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadWriter } from "./comment-writer-harness.mjs";
import { signCommentTicket, commenterUid, TICKET_SEC, COMMENT_CACHE_CONTROL, COMMENTER_ROLES } from "../shared/comment-ticket.mjs";
import { buildEntryName, parseEntryName, validThread, COMMENT_LIMITS } from "../shared/comments.mjs";
import { hostToSiteId } from "../shared/site.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "test-secret-0123456789abcdef";
const NOW = Date.UTC(2026, 9, 22, 15, 30, 12, 123);
const UID = commenterUid("sam@example.com", SECRET);
const MALLORY = commenterUid("mallory@example.com", SECRET);

const ticket = (extra = {}) => signCommentTicket({
  siteId: "acme", pending: false, uid: UID, name: "Sam O.", secret: SECRET, now: NOW, ...extra,
}).token;
const name = (uid = UID, ms = NOW) => buildEntryName(ms, uid, "hello");
const uri = (thread = "my-article", n = name()) => `/__qw/post/${thread}/${n}`;

let w;
test.beforeEach(() => { w = loadWriter({ secret: SECRET, now: NOW }); });

// --------------------------------------------------------------- writing
test("a valid write becomes a PUT of this author's object, with only the headers S3 should see", async () => {
  const r = await w.put("acme.quickieweb.com", uri(), {
    ticket: ticket(),
    length: 120,
    headers: {
      "content-type": "text/html",
      "cache-control": "no-cache",
      "x-amz-meta-uid": MALLORY,
      "x-amz-meta-name": "Owner",
      "x-amz-meta-role": "owner",
      "x-amz-acl": "public-read-write",
      "x-amz-website-redirect-location": "https://evil.test/",
      "x-amz-tagging": "a=b",
      "authorization": "AWS4-HMAC-SHA256 Credential=...",
      "if-match": "\"etag\"",
      "origin": "https://acme.quickieweb.com",
    },
  });
  assert.equal(r.uri, `/sites/acme/_comments/my-article/${name()}`);
  assert.deepEqual(Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k, v.value])), {
    "host": "acme.quickieweb.com",
    "content-length": "120",
    "content-type": "application/json",
    "cache-control": COMMENT_CACHE_CONTROL,
    "if-none-match": "*",
    "x-amz-meta-uid": UID,
    "x-amz-meta-name": "Sam%20O%2E",
    "x-amz-meta-role": "none",
  }, "the ticket and the browser's own claims never reach S3; the ticket's identity does");
  assert.deepEqual(r.cookies, {});
  assert.deepEqual(r.querystring, {});
});

test("a pending ticket writes to _pending/, which readers are never served", async () => {
  const r = await w.put("acme.quickieweb.com", uri(), { ticket: ticket({ pending: true }) });
  assert.equal(r.uri, `/sites/acme/_pending/my-article/${name()}`);
});

test("the apex is the marketing site, and a nested thread keeps its path", async () => {
  const r = await w.put("quickieweb.com", uri("guides/setup"), { ticket: ticket({ siteId: "www" }) });
  assert.equal(r.uri, `/sites/www/_comments/guides/setup/${name()}`);
});

test("a role travels from the ticket, so a member's resolve is believed", async () => {
  const r = await w.put("acme.quickieweb.com", uri(), { ticket: ticket({ role: "editor" }) });
  assert.equal(r.headers["x-amz-meta-role"].value, "editor");
});

// -------------------------------------------------------------- refusing
test("a comment cannot be written under someone else's uid", async () => {
  // The attack this function exists for: listing is public, so every existing
  // comment's name is known. Writing to one needs its author's ticket.
  const r = await w.put("acme.quickieweb.com", uri("my-article", name(MALLORY)), { ticket: ticket() });
  assert.equal(r.statusCode, 403);
  assert.match(JSON.parse(r.body).error, /own uid/);
});

test("a ticket is for one site", async () => {
  assert.equal((await w.put("beta.quickieweb.com", uri(), { ticket: ticket() })).statusCode, 403);
  assert.equal((await w.put("quickieweb.com", uri(), { ticket: ticket() })).statusCode, 403);
});

test("a tampered, forged, expired or over-long ticket is refused", async () => {
  const good = ticket();
  const p = good.split(".");
  const swap = (i, v) => p.map((x, j) => (j === i ? v : x)).join(".");
  const cases = {
    "role raised": swap(4, "owner"),
    "approval skipped": ticket({ pending: true }).split(".").map((x, j) => (j === 5 ? "c" : x)).join("."),
    "name changed": swap(6, "Owner"),
    "uid changed": swap(3, MALLORY),
    "expiry extended": swap(2, String(+p[2] + 60)),
    "wrong key": ticket({ secret: "guess" }),
    "lives longer than a ticket may": ticket({ ttlSec: TICKET_SEC + 60 }),
    "not a ticket": good.replace(/^t1\./, "v1."),
    "a part short": p.slice(0, 7).join("."),
    "empty": "",
  };
  for (const [why, t] of Object.entries(cases)) {
    assert.equal((await w.put("acme.quickieweb.com", uri(), { ticket: t })).statusCode, 403, why);
  }
  assert.equal((await w.put("acme.quickieweb.com", uri(), {})).statusCode, 403, "no ticket at all");

  w.setClock(NOW + (TICKET_SEC + 1) * 1000);
  const late = await w.put("acme.quickieweb.com", uri("my-article", name(UID, NOW + (TICKET_SEC + 1) * 1000)), { ticket: good });
  assert.equal(late.statusCode, 403, "expired");
});

test("only PUT writes", async () => {
  for (const method of ["GET", "HEAD", "POST", "DELETE", "PATCH", "OPTIONS"]) {
    assert.equal((await w.put("acme.quickieweb.com", uri(), { ticket: ticket(), method })).statusCode, 405, method);
  }
});

test("only a thread and a comment name, never anywhere else in the bucket", async () => {
  const t = ticket();
  const n = name();
  const bad = [
    `/__qw/post/${n}`, `/__qw/post/../index.html/${n}`, `/__qw/post/My-Article/${n}`,
    `/__qw/post/a//${n}`, `/__qw/post/${"a".repeat(121)}/${n}`, `/__qw/post/x/../../admin/${n}`,
    "/__qw/post/my-article/../x.json",
  ];
  for (const u of bad) assert.equal((await w.put("acme.quickieweb.com", u, { ticket: t })).statusCode, 404, u);
  for (const n2 of ["index.html", `${n}.html`, n.replace(".json", ".js"), ""]) {
    assert.equal((await w.put("acme.quickieweb.com", `/__qw/post/my-article/${n2}`, { ticket: t })).statusCode, 400, n2);
  }
});

test("a name's time must be near now, as readers will insist", async () => {
  const skew = COMMENT_LIMITS.skewSec * 1000;
  assert.ok((await w.put("acme.quickieweb.com", uri("my-article", name(UID, NOW - skew + 1000)), { ticket: ticket() })).uri);
  assert.equal((await w.put("acme.quickieweb.com", uri("my-article", name(UID, NOW - skew - 1000)), { ticket: ticket() })).statusCode, 400);
  assert.equal((await w.put("acme.quickieweb.com", uri("my-article", name(UID, NOW + skew + 1000)), { ticket: ticket() })).statusCode, 400);
});

test("a comment is 1 to objectBytes bytes, by its declared length", async () => {
  const t = ticket();
  assert.ok((await w.put("acme.quickieweb.com", uri(), { ticket: t, length: COMMENT_LIMITS.objectBytes })).uri);
  for (const length of [0, COMMENT_LIMITS.objectBytes + 1, 5e9, null, "abc", -1]) {
    assert.equal((await w.put("acme.quickieweb.com", uri(), { ticket: t, length })).statusCode, 413, String(length));
  }
});

test("an unknown host is no site", async () => {
  for (const host of ["example.com", "acme.quickieweb.com.evil.test", "a.b.quickieweb.com", "-x.quickieweb.com", null]) {
    assert.equal((await w.put(host, uri(), { ticket: ticket() })).statusCode, 404, String(host));
  }
});

test("without its secret the function fails rather than trusting any ticket", async () => {
  const bare = loadWriter({ now: NOW });
  await assert.rejects(bare.put("acme.quickieweb.com", uri(), { ticket: ticket() }), /no _secret/);
});

// ------------------------------------------------------------------ pacts
const source = readFileSync(path.join(ROOT, "infra", "edge", "comment-writer.js"), "utf8");
const constant = (n) => JSON.parse(source.match(new RegExp(`^var ${n} = (.+);$`, "m"))[1].replace(/'/g, '"'));

test("the edge holds the readers' limits and the signer's lifetime", () => {
  assert.equal(constant("MAX_BYTES"), COMMENT_LIMITS.objectBytes);
  assert.equal(constant("SKEW_SEC"), COMMENT_LIMITS.skewSec);
  assert.equal(constant("TICKET_MAX_SEC"), TICKET_SEC);
  assert.equal(constant("CACHE"), COMMENT_CACHE_CONTROL);
  assert.deepEqual(constant("ROLES"), [...COMMENTER_ROLES]);
});

test("the edge writes exactly the names and threads readers accept", async () => {
  const t = ticket();
  const names = [name(), buildEntryName(NOW, UID, "a-b-c"), `${name().slice(0, -5)}-.json`, name().replace("Z-", "-"),
    name().toUpperCase(), name().replace(UID, "short")];
  for (const n of names) {
    const ok = Boolean((await w.put("acme.quickieweb.com", `/__qw/post/my-article/${n}`, { ticket: t })).uri);
    assert.equal(ok, parseEntryName(n) !== null && parseEntryName(n).uid === UID, n);
  }
  for (const thread of ["a", "a/b", "a-b/c-d", "a--b", "-a", "a/", "a_b", "2026/10/x"]) {
    const ok = Boolean((await w.put("acme.quickieweb.com", `/__qw/post/${thread}/${name()}`, { ticket: t })).uri);
    assert.equal(ok, validThread(thread), thread);
  }
});

test("the edge and shared/site.mjs agree on which site a host is", async () => {
  for (const label of ["acme", "abc", "a-b-c", "2026", "a".repeat(40), "ab", "a".repeat(41), "UPPER", "a_b", "-x", "x-"]) {
    const host = `${label}.quickieweb.com`;
    const site = hostToSiteId(host, "quickieweb.com");
    const r = await w.put(host, uri(), { ticket: site ? ticket({ siteId: site }) : ticket() });
    const fromEdge = r.uri ? r.uri.split("/")[2] : null;
    if (site !== null && !/--/.test(label)) assert.equal(fromEdge, site, label);
    if (fromEdge !== null) assert.equal(fromEdge, site, `edge writes for "${label}", which the admin would never serve`);
  }
});

test("the deployed function fits CloudFront's 10 KB limit once comments are stripped", () => {
  const stripped = source.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.ok(Buffer.byteLength(stripped) < 10240, `${Buffer.byteLength(stripped)} bytes`);
});
