// The Lambda's part in comments: commenter sign-in, tickets, and moderation.
//
//   node --test test/comments-api.test.mjs
//
// The bucket is a Map, so the last test can run the whole life of a moderated
// comment -- sign in, cookie, ticket, upload, approve -- and then hand the
// result to the same checks a reader's browser makes.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  readCookie, commenterFrom, grantRedirect, sessionCookies, CLEAR_SESSION_COOKIES, ticketFor, settingsFrom,
  listPending, approve, reject, removeComment, PENDING_PREFIX, COMMENTS_PREFIX,
} from "../admin/lib/comments.mjs";
import { buildEntryName, checkEntry, checkObject, ticketProblem, COMMENT_LIMITS } from "../shared/comments.mjs";
import { commenterUid } from "../shared/comment-ticket.mjs";
import { normalizeSite } from "../shared/site.mjs";

const SECRET = "test-secret-0123456789abcdef";
const NOW = Date.UTC(2026, 9, 22, 15, 30, 12, 123);
const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "token" };
const actor = { email: "sam@example.com", name: "Sam O", scopes: null };

const site = (comments = {}, members = [{ email: "owner@acme.test", role: "owner" }]) => normalizeSite({
  siteId: "acme",
  members,
  comments,
  storage: {
    driver: "prefix", region: "us-west-2", prefix: "sites/acme",
    stagingBucket: "quickieweb-sites-staging", liveBucket: "quickieweb-sites-live",
  },
});

/** Sign in on the console host, follow the redirect, keep the cookie. */
function signIn(s = site(), now = NOW) {
  const url = new URL(grantRedirect({ site: s, actor, next: "/my-article.html", secret: SECRET, gateOrigin: "https://acme.quickieweb.com", now }));
  const [setCookie, hint] = sessionCookies({ siteId: url.searchParams.get("site"), grant: url.searchParams.get("g"), secret: SECRET, now });
  return { url, setCookie, hint, headers: { cookie: `other=1; ${setCookie.split(";")[0]}` } };
}

// ------------------------------------------------------------------ sign-in
test("sign-in lands on the site's own host, and comes back to the page", () => {
  const { url, setCookie, hint } = signIn();
  assert.equal(url.origin + url.pathname, "https://acme.quickieweb.com/api/comments/session");
  assert.equal(url.searchParams.get("next"), "/my-article.html");
  assert.match(setCookie, /^qw_commenter=cs1\.acme\./);
  assert.match(setCookie, /; Secure; HttpOnly; SameSite=Lax; Path=\/api\/comments; Max-Age=43200$/);
  // The hint is readable by the page (no HttpOnly), site-wide, and holds the name only.
  assert.equal(hint, `qw_cmt=none:${encodeURIComponent(actor.name)}; Secure; SameSite=Lax; Path=/; Max-Age=43200`);
  assert.ok(!hint.includes(actor.email) && !hint.includes(encodeURIComponent(actor.email)));
  assert.match(CLEAR_SESSION_COOKIES[0], /^qw_commenter=; .*Max-Age=0$/);
  assert.match(CLEAR_SESSION_COOKIES[1], /^qw_cmt=; .*Path=\/; Max-Age=0$/);
});

test("someone who may not comment is told why at sign-in, not bounced", () => {
  assert.throws(() => signIn(site({ who: "off" })), (e) => e.status === 403 && /turned off/.test(e.message));
  assert.throws(() => signIn(site({ who: "members" })), (e) => e.status === 403 && /Only members/.test(e.message));
});

test("an expired, foreign or missing grant does not become a session", () => {
  const { url } = signIn();
  const g = url.searchParams.get("g");
  assert.throws(() => sessionCookies({ siteId: "acme", grant: g, secret: SECRET, now: NOW + 121e3 }), /expired/);
  assert.throws(() => sessionCookies({ siteId: "beta", grant: g, secret: SECRET, now: NOW }), /not for this site/);
  assert.throws(() => sessionCookies({ siteId: "acme", grant: null, secret: SECRET, now: NOW }), (e) => e.status === 403);
});

test("the cookie identifies the commenter on its own site only", () => {
  const { headers } = signIn();
  assert.deepEqual(commenterFrom(headers, "acme", SECRET, NOW), { email: "sam@example.com", name: "Sam O" });
  assert.equal(commenterFrom(headers, "beta", SECRET, NOW), null);
  assert.equal(commenterFrom({}, "acme", SECRET, NOW), null);
  assert.equal(readCookie({ Cookie: "a=1; b = 2" }, "b"), "2");
});

// ------------------------------------------------------------------ tickets
test("a signed-in commenter gets a ticket the library accepts", () => {
  const { headers } = signIn();
  const t = ticketFor({ site: site(), commenter: commenterFrom(headers, "acme", SECRET, NOW), secret: SECRET, credentials: creds, now: NOW });
  assert.equal(ticketProblem(t), null);
  assert.equal(t.prefix, "sites/acme/_comments/");
  assert.equal(t.uid, commenterUid("sam@example.com", SECRET));
  assert.equal(t.name, "Sam O");
});

test("the ticket follows the site's settings as they are now, not at sign-in", () => {
  const commenter = commenterFrom(signIn().headers, "acme", SECRET, NOW);
  const ticket = (s) => ticketFor({ site: s, commenter, secret: SECRET, credentials: creds, now: NOW });
  assert.equal(ticket(site({ approval: true })).prefix, "sites/acme/_pending/");
  assert.throws(() => ticket(site({ who: "off" })), (e) => e.status === 403);
  assert.throws(() => ticket(site({ who: "members" })), (e) => e.status === 403);
  assert.equal(ticket(site({ who: "members" }, [{ email: "sam@example.com", role: "editor" }])).pending, false);
  assert.throws(() => ticketFor({ site: site(), commenter: null, secret: SECRET, credentials: creds, now: NOW }),
    (e) => e.status === 401, "no cookie is a 401, which the library reads as 'sign in'");
});

test("a site on its own buckets cannot have comments yet", () => {
  const s = normalizeSite({ siteId: "solo", storage: { driver: "buckets", stagingBucket: "a", liveBucket: "b" } });
  assert.throws(() => ticketFor({ site: s, commenter: { email: "sam@example.com", name: "Sam" }, secret: SECRET, credentials: creds, now: NOW }),
    (e) => e.status === 409);
});

test("settings accept exactly who and approval", () => {
  assert.deepEqual(settingsFrom({ who: "members", approval: true }), { who: "members", approval: true });
  assert.throws(() => settingsFrom({ who: "everyone", approval: false }), /who must be one of/);
  assert.throws(() => settingsFrom({ who: "off", approval: "yes" }), /approval must be/);
  assert.throws(() => settingsFrom({ who: "off", approval: false, open: true }), /Unknown comment setting: open/);
});

// ------------------------------------------------------------ bucket policy
test("the edge may list comment threads, and nothing else in the bucket", async () => {
  const tpl = JSON.parse(await readFile(new URL("../infra/iam/tenant-live-bucket-policy.json", import.meta.url), "utf8"));
  const lists = tpl.Statement.filter((s) => [].concat(s.Action).some((a) => /ListBucket/.test(a)) && s.Effect === "Allow");
  assert.equal(lists.length, 1, "exactly one Allow grants listing");
  const [st] = lists;
  assert.deepEqual([].concat(st.Action), ["s3:ListBucket"]);
  assert.equal(st.Resource, "arn:aws:s3:::__BUCKET__");
  assert.deepEqual(st.Principal, { Service: "cloudfront.amazonaws.com" });
  assert.deepEqual(st.Condition, {
    StringEquals: { "AWS:SourceArn": "arn:aws:cloudfront::__ACCOUNT__:distribution/__DISTRIBUTION__" },
    StringLike: { "s3:prefix": "sites/*/_comments/*" },
  }, "a list without a comment-thread prefix -- including no prefix at all -- is refused by S3");
});

// --------------------------------------------------------------- moderation

/** A live bucket for one site: site-relative keys, S3-style metadata. */
function bucket() {
  const objects = new Map();
  const ops = {
    list: async (prefix) => [...objects].filter(([k]) => k.startsWith(prefix))
      .map(([key, o]) => ({ key, modified: new Date(o.modified), size: o.text.length })),
    read: async (key) => (objects.has(key) ? { ...objects.get(key), modified: new Date(objects.get(key).modified) } : null),
    copy: async (from, to) => { objects.set(to, { ...objects.get(from), modified: clock }); },
    remove: async (key) => { objects.delete(key); },
  };
  let clock = NOW;
  return {
    objects, ops,
    setClock: (ms) => { clock = ms; },
    /** What S3 does with a form upload under a ticket. */
    upload: (ticket, key, text) => {
      assert.ok(key.startsWith(ticket.prefix), "S3 refuses a key outside the policy's prefix");
      assert.ok(text.length >= 1 && text.length <= COMMENT_LIMITS.objectBytes);
      objects.set(key.replace(/^sites\/acme\//, ""), {
        text, modified: clock,
        meta: { uid: ticket.fields["x-amz-meta-uid"], name: ticket.fields["x-amz-meta-name"], role: ticket.fields["x-amz-meta-role"] },
      });
    },
  };
}

const body = (extra = {}) => JSON.stringify({ v: 1, kind: "comment", thread: "my-article", body: "Hello", ...extra });

test("the queue shows checked comments, and junk as junk", async () => {
  const b = bucket();
  const t = ticketFor({ site: site({ approval: true }), commenter: { email: "sam@example.com", name: "Sam O" }, secret: SECRET, credentials: creds, now: NOW });
  const good = buildEntryName(NOW, t.uid, "hello");
  b.upload(t, `${t.prefix}my-article/${good}`, body());
  b.upload(t, `${t.prefix}my-article/${buildEntryName(NOW + 1, t.uid, "gif")}`, "GIF89a");
  b.upload(t, `${t.prefix}my-article/notes.txt`, "hi");

  const pending = await listPending(b.ops);
  assert.equal(pending.length, 3);
  const ok = pending.find((p) => p.name === good);
  assert.deepEqual(ok.author, { uid: t.uid, name: "Sam O", role: "none" });
  assert.equal(ok.comment.body, "Hello");
  assert.deepEqual(pending.filter((p) => p.problem).map((p) => p.problem).sort(), ["not JSON", "not a comment key"]);
});

test("approval cannot publish junk, and reject removes anything waiting", async () => {
  const b = bucket();
  const t = ticketFor({ site: site({ approval: true }), commenter: { email: "sam@example.com", name: "Sam" }, secret: SECRET, credentials: creds, now: NOW });
  const junk = `${PENDING_PREFIX}my-article/${buildEntryName(NOW, t.uid, "x")}`;
  b.upload(t, `sites/acme/${junk}`, "<script>alert(1)</script>");
  await assert.rejects(approve(b.ops, junk, NOW), (e) => e.status === 409 && /Reject it instead/.test(e.message));
  await reject(b.ops, junk);
  assert.equal(b.objects.size, 0);

  await assert.rejects(approve(b.ops, "_comments/my-article/x.json"), (e) => e.status === 400);
  await assert.rejects(approve(b.ops, junk), (e) => e.status === 404 && /already/.test(e.message));
  await assert.rejects(reject(b.ops, "_comments/my-article/x.json"), (e) => e.status === 400);
});

test("a moderated comment, start to finish, is accepted by a reader after approval", async () => {
  const b = bucket();
  const s = site({ approval: true });
  const { headers } = signIn(s);
  const t = ticketFor({ site: s, commenter: commenterFrom(headers, "acme", SECRET, NOW), secret: SECRET, credentials: creds, now: NOW });
  assert.equal(t.pending, true);

  const name = buildEntryName(NOW, t.uid, "great-post");
  b.upload(t, `${t.prefix}my-article/${name}`, body({ subject: "Great post" }));
  assert.ok(![...b.objects.keys()].some((k) => k.startsWith(COMMENTS_PREFIX)), "nothing is public before approval");

  // Approved two days later: the copy is renamed with the approval time,
  // because a reader only believes a key's time near S3's LastModified.
  const later = NOW + 2 * 86400e3;
  b.setClock(later);
  const { key } = await approve(b.ops, `${PENDING_PREFIX}my-article/${name}`, later);
  assert.equal(key, `${COMMENTS_PREFIX}my-article/${buildEntryName(later, t.uid, "great-post")}`);
  assert.equal(b.objects.has(`${PENDING_PREFIX}my-article/${name}`), false);

  const stored = b.objects.get(key);
  const entry = checkEntry({ key: `sites/acme/${key}`, modified: stored.modified, size: stored.text.length }, "my-article").entry;
  assert.ok(entry, "the reader accepts the approved key");
  const header = (h) => (h.startsWith("x-amz-meta-") ? stored.meta[h.slice(11)] ?? null : null);
  const item = checkObject(entry, stored.text, header, "my-article").item;
  assert.deepEqual(item.author, { uid: t.uid, name: "Sam O", role: "none" }, "the author S3 pinned on upload survives approval");
  assert.equal(item.comment.subject, "Great post");
});

test("the hint carries the role at sign-in, for drawing buttons", () => {
  const members = [{ email: "sam@example.com", role: "editor" }, { email: "owner@acme.test", role: "owner" }];
  const s = site({}, members);
  const url = new URL(grantRedirect({ site: s, actor, next: "/a.html", secret: SECRET, gateOrigin: "https://acme.quickieweb.com", now: NOW }));
  const [, hint] = sessionCookies({ siteId: "acme", grant: url.searchParams.get("g"), secret: SECRET, site: s, now: NOW });
  assert.match(hint, /^qw_cmt=editor:Sam%20O;/);
});

test("a member's ticket pins their role and skips the approval queue", () => {
  const s = site({ approval: true }, [{ email: "sam@example.com", role: "editor" }]);
  const t = ticketFor({ site: s, commenter: { email: "sam@example.com", name: "Sam" }, secret: SECRET, credentials: creds, now: NOW });
  assert.equal(t.role, "editor");
  assert.equal(t.fields["x-amz-meta-role"], "editor");
  assert.equal(t.pending, false);
  assert.ok(t.prefix.endsWith("/_comments/"));
});

test("deleting a comment takes its events with it, and nothing else", async () => {
  const b = bucket();
  const t = ticketFor({ site: site(), commenter: { email: "sam@example.com", name: "Sam" }, secret: SECRET, credentials: creds, now: NOW });
  const at = (ms, slug) => `${t.prefix}my-article/${buildEntryName(ms, t.uid, slug)}`;
  const a = buildEntryName(NOW, t.uid, "hello");
  const other = buildEntryName(NOW + 1, t.uid, "other");
  b.upload(t, `${t.prefix}my-article/${a}`, body());
  b.upload(t, `${t.prefix}my-article/${other}`, body());
  b.upload(t, at(NOW + 2, "resolve"), JSON.stringify({ v: 1, kind: "resolve", thread: "my-article", ref: a }));
  b.upload(t, at(NOW + 3, "resolve"), JSON.stringify({ v: 1, kind: "resolve", thread: "my-article", ref: other }));
  b.upload(t, at(NOW + 4, "reopen"), "not json");

  const done = await removeComment(b.ops, { thread: "my-article", name: a });
  assert.deepEqual(done, { key: `${COMMENTS_PREFIX}my-article/${a}`, events: 1 });
  assert.deepEqual([...b.objects.keys()].map((k) => k.split("-").pop()).sort(), ["other.json", "reopen.json", "resolve.json"]);

  await assert.rejects(removeComment(b.ops, { thread: "my-article", name: a }), (e) => e.status === 404);
  await assert.rejects(removeComment(b.ops, { thread: "../x", name: a }), (e) => e.status === 400);
  await assert.rejects(removeComment(b.ops, { thread: "my-article", name: "index.html" }), (e) => e.status === 400);
  const ev = [...b.objects.keys()].find((k) => k.endsWith("resolve.json")).split("/").pop();
  await assert.rejects(removeComment(b.ops, { thread: "my-article", name: ev }), /only comments can be deleted/);
});
