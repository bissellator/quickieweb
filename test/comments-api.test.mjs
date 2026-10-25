// The Lambda's part in comments: commenter sign-in, tickets, and moderation.
//
//   node --test test/comments-api.test.mjs
//
// The bucket is a Map, and every upload goes through the shipped edge writer
// (infra/edge/comment-writer.js), so a test can run the whole life of a
// moderated comment -- sign in, cookie, ticket, upload, approve -- and then hand
// the result to the same checks a reader's browser makes.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  readCookie, commenterFrom, grantRedirect, sessionCookies, hintCookie, CLEAR_SESSION_COOKIES, ticketFor, settingsFrom,
  listPending, listPublished, approve, reject, removeComment, discard, PENDING_PREFIX, COMMENTS_PREFIX,
} from "../admin/lib/comments.mjs";
import { buildEntryName, checkEntry, checkObject, ticketProblem, COMMENT_LIMITS } from "../shared/comments.mjs";
import { commenterUid } from "../shared/comment-ticket.mjs";
import { normalizeSite } from "../shared/site.mjs";
import { loadWriter } from "./comment-writer-harness.mjs";

const SECRET = "test-secret-0123456789abcdef";
const NOW = Date.UTC(2026, 9, 22, 15, 30, 12, 123);
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
  const t = ticketFor({ site: site(), commenter: commenterFrom(headers, "acme", SECRET, NOW), secret: SECRET, now: NOW });
  assert.equal(ticketProblem(t), null);
  assert.equal(t.prefix, "_comments/");
  assert.equal(t.uid, commenterUid("sam@example.com", SECRET));
  assert.equal(t.name, "Sam O");
});

test("the ticket follows the site's settings as they are now, not at sign-in", () => {
  const commenter = commenterFrom(signIn().headers, "acme", SECRET, NOW);
  const ticket = (s) => ticketFor({ site: s, commenter, secret: SECRET, now: NOW });
  assert.equal(ticket(site({ approval: true })).prefix, "_pending/");
  assert.throws(() => ticket(site({ who: "off" })), (e) => e.status === 403);
  assert.throws(() => ticket(site({ who: "members" })), (e) => e.status === 403);
  assert.equal(ticket(site({ who: "members" }, [{ email: "sam@example.com", role: "editor" }])).pending, false);
  assert.throws(() => ticketFor({ site: site(), commenter: null, secret: SECRET, now: NOW }),
    (e) => e.status === 401, "no cookie is a 401, which the library reads as 'sign in'");
});

test("a site on its own buckets cannot have comments yet", () => {
  const s = normalizeSite({ siteId: "solo", storage: { driver: "buckets", stagingBucket: "a", liveBucket: "b" } });
  assert.throws(() => ticketFor({ site: s, commenter: { email: "sam@example.com", name: "Sam" }, secret: SECRET, now: NOW }),
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

test("the edge may write new comments, and nothing else, and never over an old one", async () => {
  const tpl = JSON.parse(await readFile(new URL("../infra/iam/tenant-live-bucket-policy.json", import.meta.url), "utf8"));
  const writes = tpl.Statement.filter((s) => s.Effect === "Allow" && [].concat(s.Action).some((a) => /Put|\*/.test(a)));
  assert.equal(writes.length, 1, "exactly one Allow grants writing");
  const [st] = writes;
  assert.equal(st.Sid, "CommentsWriteFromOurDistribution");
  assert.deepEqual([].concat(st.Action), ["s3:PutObject"]);
  assert.deepEqual(st.Principal, { Service: "cloudfront.amazonaws.com" });
  assert.deepEqual(st.Resource, ["arn:aws:s3:::__BUCKET__/sites/*/_comments/*", "arn:aws:s3:::__BUCKET__/sites/*/_pending/*"]);
  assert.deepEqual(st.Condition, {
    StringEquals: { "AWS:SourceArn": "arn:aws:cloudfront::__ACCOUNT__:distribution/__DISTRIBUTION__" },
    Null: { "s3:if-none-match": "false" },
  }, "a PUT without If-None-Match -- one that could replace an object -- is refused by S3");
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
  const edge = loadWriter({ secret: SECRET, now: NOW });
  return {
    objects, ops,
    setClock: (ms) => { clock = ms; edge.setClock(ms); },
    /**
     * A browser's PUT: through the edge writer, then what S3 does with what the
     * edge sends it. `key` is site-relative, as the library builds it from the
     * ticket. Refusals throw with the status, as the library would see it.
     */
    upload: async (ticket, key, text) => {
      assert.ok(key.startsWith(ticket.prefix), "the library writes under the ticket's prefix");
      const rest = key.slice(ticket.prefix.length);
      const r = await edge.put("acme.quickieweb.com", `/__qw/post/${rest}`,
        { ticket: ticket.token, length: Buffer.byteLength(text) });
      if (r.statusCode) throw Object.assign(new Error(`edge refused: ${r.statusCode} ${r.body}`), { status: r.statusCode });
      const stored = r.uri.replace(/^\/sites\/acme\//, "");
      assert.equal(stored, key, "the edge stores it where the library said");
      if (r.headers["if-none-match"]?.value === "*" && objects.has(stored)) {
        throw Object.assign(new Error("S3: PreconditionFailed"), { status: 412 });
      }
      const h = (n) => r.headers[`x-amz-meta-${n}`].value;
      objects.set(stored, { text, modified: clock, meta: { uid: h("uid"), name: h("name"), role: h("role") } });
    },
    /** An object put there some other way -- by a bug, or before the edge writer. */
    plant: (key, text, meta) => { objects.set(key, { text, modified: clock, meta }); },
  };
}

const body = (extra = {}) => JSON.stringify({ v: 1, kind: "comment", thread: "my-article", body: "Hello", ...extra });

test("the queue shows checked comments, and junk as junk", async () => {
  const b = bucket();
  const t = ticketFor({ site: site({ approval: true }), commenter: { email: "sam@example.com", name: "Sam O" }, secret: SECRET, now: NOW });
  const good = buildEntryName(NOW, t.uid, "hello");
  await b.upload(t, `${t.prefix}my-article/${good}`, body());
  await b.upload(t, `${t.prefix}my-article/${buildEntryName(NOW + 1, t.uid, "gif")}`, "GIF89a");
  await assert.rejects(b.upload(t, `${t.prefix}my-article/notes.txt`, "hi"), (e) => e.status === 400, "the edge refuses a non-comment name");
  b.plant(`${t.prefix}my-article/notes.txt`, "hi", { uid: t.uid, name: "Sam%20O", role: "none" });

  const pending = await listPending(b.ops);
  assert.equal(pending.length, 3);
  const ok = pending.find((p) => p.name === good);
  assert.deepEqual(ok.author, { uid: t.uid, name: "Sam O", role: "none" });
  assert.equal(ok.comment.body, "Hello");
  assert.deepEqual(pending.filter((p) => p.problem).map((p) => p.problem).sort(), ["not JSON", "not a comment key"]);
});

test("approval cannot publish junk, and reject removes anything waiting", async () => {
  const b = bucket();
  const t = ticketFor({ site: site({ approval: true }), commenter: { email: "sam@example.com", name: "Sam" }, secret: SECRET, now: NOW });
  const junk = `${PENDING_PREFIX}my-article/${buildEntryName(NOW, t.uid, "x")}`;
  await b.upload(t, junk, "<script>alert(1)</script>");
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
  const t = ticketFor({ site: s, commenter: commenterFrom(headers, "acme", SECRET, NOW), secret: SECRET, now: NOW });
  assert.equal(t.pending, true);

  const name = buildEntryName(NOW, t.uid, "great-post");
  await b.upload(t, `${t.prefix}my-article/${name}`, body({ subject: "Great post" }));
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

test("the hint is re-issued with the role as it stands, not as it was at sign-in", () => {
  const who = { email: "sam@example.com", name: "Sam O" };
  assert.match(hintCookie(who, site()), /^qw_cmt=none:Sam%20O; Secure; SameSite=Lax; Path=\/; Max-Age=43200$/);
  assert.match(hintCookie(who, site({}, [{ email: "sam@example.com", role: "owner" }])), /^qw_cmt=owner:Sam%20O;/);
});

test("a member's ticket pins their role and skips the approval queue", () => {
  const s = site({ approval: true }, [{ email: "sam@example.com", role: "editor" }]);
  const t = ticketFor({ site: s, commenter: { email: "sam@example.com", name: "Sam" }, secret: SECRET, now: NOW });
  assert.equal(t.role, "editor");
  assert.equal(t.token.split(".")[4], "editor");
  assert.equal(t.pending, false);
  assert.equal(t.prefix, "_comments/");
});

test("deleting a comment takes its events with it, and nothing else", async () => {
  const b = bucket();
  const t = ticketFor({ site: site(), commenter: { email: "sam@example.com", name: "Sam" }, secret: SECRET, now: NOW });
  const at = (ms, slug) => `${t.prefix}my-article/${buildEntryName(ms, t.uid, slug)}`;
  const a = buildEntryName(NOW, t.uid, "hello");
  const other = buildEntryName(NOW + 1, t.uid, "other");
  await b.upload(t, `${t.prefix}my-article/${a}`, body());
  await b.upload(t, `${t.prefix}my-article/${other}`, body());
  await b.upload(t, at(NOW + 2, "resolve"), JSON.stringify({ v: 1, kind: "resolve", thread: "my-article", ref: a }));
  await b.upload(t, at(NOW + 3, "resolve"), JSON.stringify({ v: 1, kind: "resolve", thread: "my-article", ref: other }));
  await b.upload(t, at(NOW + 4, "reopen"), "not json");

  const done = await removeComment(b.ops, { thread: "my-article", name: a });
  assert.deepEqual(done, { key: `${COMMENTS_PREFIX}my-article/${a}`, events: 1 });
  assert.deepEqual([...b.objects.keys()].map((k) => k.split("-").pop()).sort(), ["other.json", "reopen.json", "resolve.json"]);

  await assert.rejects(removeComment(b.ops, { thread: "my-article", name: a }), (e) => e.status === 404);
  await assert.rejects(removeComment(b.ops, { thread: "../x", name: a }), (e) => e.status === 400);
  await assert.rejects(removeComment(b.ops, { thread: "my-article", name: "index.html" }), (e) => e.status === 400);
  const ev = [...b.objects.keys()].find((k) => k.endsWith("resolve.json")).split("/").pop();
  await assert.rejects(removeComment(b.ops, { thread: "my-article", name: ev }), /only comments can be deleted/);
});

// ---------------------------------------------------------- published list

/** Tickets for a stranger and an editor of the site, on the same site. */
function twoCommenters() {
  const s = site({}, [{ email: "ed@acme.test", role: "editor" }, { email: "owner@acme.test", role: "owner" }]);
  const ticket = (email, name) => ticketFor({ site: s, commenter: { email, name }, secret: SECRET, now: NOW });
  return { sam: ticket("sam@example.com", "Sam"), ed: ticket("ed@acme.test", "Ed") };
}

test("the published list is what readers see: folded, newest first, refusals kept apart", async () => {
  const b = bucket();
  const { sam, ed } = twoCommenters();
  const put = async (t, thread, ms, slug, obj) => {
    const name = buildEntryName(ms, t.uid, slug);
    b.setClock(ms);
    await b.upload(t, `${t.prefix}${thread}/${name}`, typeof obj === "string" ? obj : JSON.stringify({ v: 1, thread, ...obj }));
    return name;
  };
  const first = await put(sam, "my-article", NOW, "first", { kind: "comment", body: "First" });
  const gone = await put(sam, "my-article", NOW + 1000, "gone", { kind: "comment", body: "Never mind" });
  await put(sam, "my-article", NOW + 2000, "retract", { kind: "retract", ref: gone });
  await put(ed, "my-article", NOW + 3000, "resolve", { kind: "resolve", ref: first });
  await put(sam, "other-post", NOW + 4000, "later", { kind: "comment", body: "Later" });
  await put(sam, "other-post", NOW + 5000, "junk", "not json");
  await put(sam, "other-post", NOW + 6000, "resolve", { kind: "resolve", ref: buildEntryName(NOW - 60000, sam.uid, "missing") });

  const got = await listPublished(b.ops);
  assert.deepEqual(got.comments.map((c) => [c.thread, c.body]), [["other-post", "Later"], ["my-article", "First"]]);
  const resolved = got.comments.find((c) => c.body === "First").resolved;
  assert.deepEqual(resolved.by, { uid: ed.uid, name: "Ed", role: "editor" });
  assert.deepEqual(got.problems.map((p) => p.problem).sort(), [
    "not JSON", "resolve refers to a comment that is not before it in this thread",
  ]);
  assert.deepEqual(got.threads, { shown: 2, total: 2 });
  assert.equal(got.truncated, false);
});

test("nobody can write over a comment: not another commenter, not its author", async () => {
  const b = bucket();
  const { sam, ed } = twoCommenters();
  const name = buildEntryName(NOW, ed.uid, "hello");
  await b.upload(ed, `${ed.prefix}my-article/${name}`, body());
  await assert.rejects(b.upload(sam, `${sam.prefix}my-article/${name}`, body({ body: "Replaced" })),
    (e) => e.status === 403, "another commenter's ticket cannot carry this uid");
  await assert.rejects(b.upload(ed, `${ed.prefix}my-article/${name}`, body({ body: "Edited" })),
    (e) => e.status === 412, "the author's own write is refused by If-None-Match");
  assert.equal(b.objects.get(`_comments/my-article/${name}`).text, body());
});

test("an overwritten comment is listed as refused, and can be discarded", async () => {
  // How the bucket looked to a reader when tickets were S3 POST policies, which
  // pinned the prefix and not the key: Sam's upload over Ed's comment.
  const b = bucket();
  const { sam, ed } = twoCommenters();
  const name = buildEntryName(NOW, ed.uid, "hello");
  b.plant(`_comments/my-article/${name}`, body({ body: "Replaced" }), { uid: sam.uid, name: "Sam", role: "none" });

  const got = await listPublished(b.ops);
  assert.equal(got.comments.length, 0);
  assert.deepEqual(got.problems.map((p) => p.problem), ["its author does not match who uploaded it"]);

  await discard(b.ops, got.problems[0].key);
  assert.equal(b.objects.size, 0);
});

test("discard takes only what readers refuse", async () => {
  const b = bucket();
  const { sam } = twoCommenters();
  const key = `${COMMENTS_PREFIX}my-article/${buildEntryName(NOW, sam.uid, "hello")}`;
  await b.upload(sam, key, body());
  await assert.rejects(discard(b.ops, key), (e) => e.status === 409 && /as a comment/.test(e.message));
  await assert.rejects(discard(b.ops, `${PENDING_PREFIX}my-article/x.json`), (e) => e.status === 400);
  await assert.rejects(discard(b.ops, `${COMMENTS_PREFIX}../x.json`), (e) => e.status === 400);
  await assert.rejects(discard(b.ops, `${COMMENTS_PREFIX}my-article/missing.json`), (e) => e.status === 404);
  assert.equal(b.objects.size, 1);
});

test("a long history is read in whole threads, most recently active first", async () => {
  const b = bucket();
  const { sam } = twoCommenters();
  const threads = ["old", "middle", "new"];
  for (const [i, thread] of threads.entries()) {
    for (let j = 0; j < 3; j++) {
      const ms = NOW + i * 10000 + j * 1000;
      b.setClock(ms);
      await b.upload(sam, `${sam.prefix}${thread}/${buildEntryName(ms, sam.uid, "c")}`, JSON.stringify({ v: 1, kind: "comment", thread, body: "x" }));
    }
  }
  const got = await listPublished(b.ops, { limit: 7 });
  assert.deepEqual([...new Set(got.comments.map((c) => c.thread))], ["new", "middle"]);
  assert.deepEqual(got.threads, { shown: 2, total: 3 });
  assert.equal(got.truncated, true);
  assert.equal(got.problems.length, 0, "no event is cut off from the comment it points at");
});
