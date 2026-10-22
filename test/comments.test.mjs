// Page comments: the rules, the S3 list reader, the thread fold, and the browser
// client as browsers receive it.
//
//   node --test test/comments.test.mjs
//
// The tests that matter most are the hostile ones. Anyone with a ticket can put
// any bytes under a comment key, so every check here is a check a READER makes
// on something an attacker wrote -- and the client tests run the generated
// source, not the module, so they test what actually ships.

import test from "node:test";
import assert from "node:assert/strict";

import {
  COMMENT_LIMITS as L, lintComment, threadFromPath, siteFromHost, slugify, stampOf, buildEntryName,
  parseEntryName, parseListXml, checkEntry, checkObject, foldThread, ticketProblem, clientSource,
} from "../shared/comments.mjs";

const T0 = Date.UTC(2026, 9, 22, 15, 30, 12, 123);
const UID = "k3m9x2p7q4w8";
const OTHER = "z9y8x7w6v5u4";
const comment = (extra = {}) => ({ v: 1, kind: "comment", thread: "my-article", body: "Nice post.", ...extra });

// ------------------------------------------------------------------- lint
test("a plain comment passes, with or without a subject", () => {
  assert.deepEqual(lintComment(comment(), "my-article"), []);
  assert.deepEqual(lintComment(comment({ subject: "Great post" }), "my-article"), []);
  assert.deepEqual(lintComment(comment({ body: "line one\nline two\ttabbed" }), "my-article"), []);
});

test("anything that is not a comment object is refused", () => {
  for (const v of [null, 1, "text", [comment()], undefined]) {
    assert.deepEqual(lintComment(v), ["a comment must be a JSON object"], JSON.stringify(v));
  }
});

test("empty, oversized and wrongly typed text is refused", () => {
  assert.match(lintComment(comment({ body: "   " })).join(), /comment is empty/);
  assert.match(lintComment(comment({ body: 42 })).join(), /comment must be text/);
  assert.match(lintComment(comment({ body: "x".repeat(L.bodyChars + 1) })).join(), /longer than 2000/);
  assert.match(lintComment(comment({ subject: "s".repeat(L.subjectChars + 1) })).join(), /subject is longer/);
  assert.match(lintComment(comment({ subject: "two\nlines" })).join(), /one line/);
});

test("length is counted in characters, not UTF-16 units", () => {
  // 2000 emoji is 4000 UTF-16 units and 8000 bytes: allowed, and still under objectBytes.
  assert.deepEqual(lintComment(comment({ body: "😀".repeat(L.bodyChars) })), []);
});

test("control and direction-override characters are refused", () => {
  for (const ch of ["\u0000", "\u0007", "\r", "\u007f", "\u0085", "﻿", "‮", "⁦"]) {
    assert.match(lintComment(comment({ body: `a${ch}b` })).join(), /control characters/, JSON.stringify(ch));
  }
});

test("only the v1 fields are allowed, at version 1, in this thread", () => {
  assert.match(lintComment(comment({ author: "me" })).join(), /unexpected field "author"/);
  assert.match(lintComment(comment({ html: "<b>" })).join(), /unexpected field "html"/);
  assert.match(lintComment(comment({ v: 2 })).join(), /unsupported version/);
  assert.match(lintComment(comment({ kind: "video" })).join(), /unknown kind/);
  assert.match(lintComment(comment(), "other-article").join(), /another thread/);
  assert.match(lintComment(comment({ thread: "../x" })).join(), /thread is not valid/);
});

test("an event must name a comment, and carries nothing else", () => {
  const ref = buildEntryName(T0, UID, "great-post");
  assert.deepEqual(lintComment({ v: 1, kind: "resolve", thread: "t", ref }), []);
  assert.match(lintComment({ v: 1, kind: "retract", thread: "t", ref: "nope" }).join(), /ref is not a comment name/);
  assert.match(lintComment({ v: 1, kind: "resolve", thread: "t", ref, body: "x" }).join(), /unexpected field "body"/);
});

test("markup is just text to the rules -- rendering is what keeps it inert", () => {
  // Refusing "<" would break every comment about code. The defence is
  // textContent at render time, and nothing in the client ever builds HTML.
  assert.deepEqual(lintComment(comment({ body: "<script>alert(1)</script>" })), []);
});

// ------------------------------------------------------------------ threads
test("a page path becomes a stable thread id", () => {
  assert.equal(threadFromPath("/"), "index");
  assert.equal(threadFromPath("/index.html"), "index");
  assert.equal(threadFromPath("/2026-10-15-revision-1-blood-city.html"), "2026-10-15-revision-1-blood-city");
  assert.equal(threadFromPath("/docs/"), "docs");
  assert.equal(threadFromPath("/docs/Getting Started.htm"), "docs/getting-started");
  assert.equal(threadFromPath("/a//b/"), "a/b");
  assert.ok(threadFromPath("/" + "x".repeat(500)).length <= L.threadChars);
});

test("the site comes from a hosted host, and never from anything else", () => {
  assert.equal(siteFromHost("quickieweb.com", "quickieweb.com"), "www");
  assert.equal(siteFromHost("acme.quickieweb.com", "quickieweb.com"), "acme");
  assert.equal(siteFromHost("app.quickieweb.com", "quickieweb.com"), null, "the console is not a site");
  assert.equal(siteFromHost("a.b.quickieweb.com", "quickieweb.com"), null);
  assert.equal(siteFromHost("jeffseats.com", "quickieweb.com"), null, "a custom domain must name its site");
  assert.equal(siteFromHost("evilquickieweb.com", "quickieweb.com"), null);
});

// -------------------------------------------------------------------- names
test("names round-trip, and sort in time order", () => {
  const name = buildEntryName(T0, UID, slugify("Great Post!", "comment"));
  assert.equal(name, "20261022T153012123Z-k3m9x2p7q4w8-great-post.json");
  assert.deepEqual(parseEntryName(name), { stamp: "20261022T153012123Z", at: T0, uid: UID, slug: "great-post" });
  const later = buildEntryName(T0 + 1, UID, "a");
  assert.ok(name < later, "byte order is time order");
});

test("slugs are plain, short, and never empty", () => {
  assert.equal(slugify("Café au lait", "c"), "cafe-au-lait");
  assert.equal(slugify("!!!", "comment"), "comment");
  assert.equal(slugify("😀", "comment"), "comment");
  assert.ok(slugify("word ".repeat(40), "c").length <= L.slugChars);
});

test("a malformed name is not a comment", () => {
  for (const n of [
    "20261022T153012123Z-k3m9x2p7q4w8-x.html",
    "20261340T153012123Z-k3m9x2p7q4w8-x.json", // month 13
    "20261022T153012123Z-SHOUTY12345-x.json",
    "20261022T153012123Z-short-x.json",
    "20261022T153012Z-k3m9x2p7q4w8-x.json",
    `20261022T153012123Z-k3m9x2p7q4w8-${"a".repeat(L.slugChars + 1)}.json`,
    "../20261022T153012123Z-k3m9x2p7q4w8-x.json",
  ]) {
    assert.equal(parseEntryName(n), null, n);
  }
  assert.throws(() => stampOf(NaN), /not a time/);
});

// ------------------------------------------------------------- S3 list XML
const listXml = (entries, { truncated = false, next } = {}) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>quickieweb-sites-live</Name>
<Prefix>sites/www/_comments/my-article/</Prefix><KeyCount>${entries.length}</KeyCount><MaxKeys>1000</MaxKeys>
<IsTruncated>${truncated}</IsTruncated>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}
${entries.map((e) => `<Contents><Key>${e.key}</Key><LastModified>${new Date(e.modified).toISOString()}</LastModified><ETag>&quot;abc&quot;</ETag><Size>${e.size ?? 100}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join("")}
</ListBucketResult>`;

test("an S3 list parses, entities and all", () => {
  const page = parseListXml(listXml([{ key: "sites/www/_comments/t/a&amp;b&lt;c&#x2F;&#47;.json", modified: T0, size: 7 }],
    { truncated: true, next: "tok&amp;en" }));
  assert.deepEqual(page, {
    entries: [{ key: "sites/www/_comments/t/a&b<c//.json", modified: T0, size: 7 }],
    truncated: true,
    next: "tok&en",
  });
  assert.deepEqual(parseListXml(listXml([])).entries, []);
});

test("anything that is not a list response throws rather than reading as empty", () => {
  assert.throws(() => parseListXml("<!doctype html><h1>Not found</h1>"), /not an S3 list response/);
  assert.throws(() => parseListXml(undefined), /not an S3 list response/);
  assert.throws(() => parseListXml("<ListBucketResult><Contents><Key>k</Key></Contents></ListBucketResult>"),
    /missing its Key, LastModified or Size/);
});

// ---------------------------------------------------------- listed entries
const key = (name, thread = "my-article") => `sites/www/_comments/${thread}/${name}`;

test("a listed key is checked before anything is fetched for it", () => {
  const name = buildEntryName(T0, UID, "hi");
  const ok = checkEntry({ key: key(name), modified: T0 + 2000, size: 120 }, "my-article");
  assert.equal(ok.entry.uid, UID);
  assert.equal(ok.entry.name, name);

  assert.match(checkEntry({ key: key(name, "other"), modified: T0, size: 1 }, "my-article").reason, /not in this thread/);
  assert.match(checkEntry({ key: key("notes.txt"), modified: T0, size: 1 }, "my-article").reason, /not a comment name/);
  assert.match(checkEntry({ key: key(name), modified: T0, size: L.objectBytes + 1 }, "my-article").reason, /larger than/);
});

test("a claimed time far from S3's own clock is not believed", () => {
  // The year-2099 comment that pins itself to the top of the thread.
  const name = buildEntryName(Date.UTC(2099, 0, 1), UID, "first");
  assert.match(checkEntry({ key: key(name), modified: T0, size: 1 }, "my-article").reason, /does not match when it was stored/);
});

// --------------------------------------------------------- fetched objects
const entry = (name) => checkEntry({ key: key(name), modified: T0, size: 100 }, "my-article").entry;
const headers = (h) => (n) => (n in h ? h[n] : null);

test("a good object becomes an item with its signed author", () => {
  const e = entry(buildEntryName(T0, UID, "hi"));
  const r = checkObject(e, JSON.stringify(comment()), headers({ "x-amz-meta-uid": UID, "x-amz-meta-name": "Ren%C3%A9e%20O" }), "my-article");
  assert.deepEqual(r.item.author, { uid: UID, name: "Renée O" });
  assert.equal(r.item.comment.body, "Nice post.");
});

test("hostile objects are reasons, never items", () => {
  const e = entry(buildEntryName(T0, UID, "hi"));
  const good = { "x-amz-meta-uid": UID, "x-amz-meta-name": "Sam" };
  const cases = [
    [Buffer.alloc(64, 0xff).toString("latin1"), good, /not JSON/],
    ["<html><script>alert(1)</script></html>", good, /not JSON/],
    [JSON.stringify(comment({ body: "x‮y" })), good, /control characters/],
    [JSON.stringify(comment()), { ...good, "x-amz-meta-uid": OTHER }, /author does not match/],
    [JSON.stringify(comment()), { "x-amz-meta-uid": UID }, /author name is empty/],
    [JSON.stringify(comment()), { ...good, "x-amz-meta-name": "%E0%A4%A" }, /not readable/],
    [JSON.stringify(comment()), { ...good, "x-amz-meta-name": "a%0Ab" }, /author name must be one line/],
  ];
  for (const [text, h, why] of cases) {
    const r = checkObject(e, text, headers(h), "my-article");
    assert.equal(r.item, undefined);
    assert.match(r.reason, why);
  }
});

// --------------------------------------------------------------- folding
const item = (ms, uid, comment, name = buildEntryName(ms, uid, comment.kind)) =>
  ({ key: key(name), name, modified: ms, author: { uid, name: uid }, comment });

test("a thread folds oldest first, with resolve and reopen applied in order", () => {
  const a = item(T0, UID, comment({ body: "first" }));
  const b = item(T0 + 10, OTHER, comment({ body: "second" }));
  const r = item(T0 + 20, OTHER, { v: 1, kind: "resolve", thread: "my-article", ref: a.name });
  let t = foldThread([r, b, a]);
  assert.deepEqual(t.comments.map((c) => c.body), ["first", "second"]);
  assert.deepEqual(t.comments[0].resolved, { by: { uid: OTHER, name: OTHER }, at: T0 + 20 });
  assert.deepEqual(t.rejected, []);

  const re = item(T0 + 30, UID, { v: 1, kind: "reopen", thread: "my-article", ref: a.name });
  t = foldThread([a, b, r, re]);
  assert.equal(t.comments[0].resolved, null);
});

test("only the author can retract, and an event needs a comment before it", () => {
  const a = item(T0, UID, comment({ body: "mine" }));
  const byOther = item(T0 + 10, OTHER, { v: 1, kind: "retract", thread: "my-article", ref: a.name });
  let t = foldThread([a, byOther]);
  assert.equal(t.comments.length, 1);
  assert.match(t.rejected[0].reason, /only the author/);

  const byAuthor = item(T0 + 20, UID, { v: 1, kind: "retract", thread: "my-article", ref: a.name });
  t = foldThread([a, byAuthor]);
  assert.equal(t.comments.length, 0);

  const early = item(T0 - 10, OTHER, { v: 1, kind: "resolve", thread: "my-article", ref: a.name });
  t = foldThread([a, early]);
  assert.match(t.rejected[0].reason, /not before it/);
});

// ----------------------------------------------------------------- tickets
const NOW = new Date(T0).toISOString();
const goodTicket = (extra = {}) => ({
  url: "https://quickieweb-sites-live.s3.us-west-2.amazonaws.com/",
  fields: { "Content-Type": "application/json", "x-amz-meta-uid": UID, "x-amz-meta-name": "Sam", Policy: "p", "X-Amz-Signature": "s" },
  prefix: "sites/www/_comments/",
  pending: false,
  uid: UID,
  name: "Sam",
  now: NOW,
  expires: new Date(T0 + 3600e3).toISOString(),
  ...extra,
});

test("a ticket is checked before a browser will upload with it", () => {
  assert.equal(ticketProblem(goodTicket()), null);
  assert.match(ticketProblem(goodTicket({ url: "http://x/" })), /https/);
  assert.match(ticketProblem(goodTicket({ prefix: "sites/www/_comments" })), /prefix/);
  assert.match(ticketProblem(goodTicket({ uid: "A" })), /uid/);
  assert.match(ticketProblem(goodTicket({ expires: "soon" })), /times/);
  assert.match(ticketProblem(goodTicket({ pending: undefined })), /pending/);
});

// ------------------------------------------------- the client, as shipped
//
// The generated source is evaluated against a fake window, so this exercises
// the exact text served at /__qw/lib/comments.js.

function boot({ host = "quickieweb.com", path = "/my-article.html", routes, clock = T0 }) {
  const calls = [];
  const assigned = [];
  const window = {
    location: {
      origin: `https://${host}`, hostname: host, pathname: path, search: "?ref=x",
      assign: (u) => assigned.push(u),
    },
    FormData, Blob,
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      const route = routes(url, init);
      if (!route) throw new Error(`unexpected fetch ${url}`);
      return route;
    },
  };
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    new Function("window", clientSource({ apex: "quickieweb.com" }))(window);
  } finally {
    Date.now = realNow;
  }
  return { window, calls, assigned, Q: window.QWComments, setClock: (c) => { clock = c; } };
}

// The client reads Date.now() at call time, so tests pin it around each call.
async function at(ms, fn) {
  const realNow = Date.now;
  Date.now = () => ms;
  try { return await fn(); } finally { Date.now = realNow; }
}

const xmlRes = (body, status = 200) => new Response(body, { status, headers: { "content-type": "application/xml" } });
const objRes = (body, h) => new Response(body, { status: 200, headers: { "content-type": "application/json", ...h } });

test("connect works out the site and thread from where it is loaded", () => {
  const { Q } = boot({ routes: () => null });
  const c = Q.connect();
  assert.equal(c.site, "www");
  assert.equal(c.thread, "my-article");
  assert.equal(Q.connect({ thread: "custom/id" }).thread, "custom/id");
  assert.throws(() => Q.connect({ thread: "Bad Id" }), /not a valid thread/);
  assert.throws(() => boot({ host: "jeffseats.com", routes: () => null }).Q.connect(), /pass \{ site/);
  assert.equal(boot({ host: "jeffseats.com", routes: () => null }).Q.connect({ site: "jeffseats" }).site, "jeffseats");
});

test("load lists, fetches, checks and folds -- and reports what it refused", async () => {
  const good = buildEntryName(T0, UID, "hi");
  const forged = buildEntryName(T0 + 5, OTHER, "forged");
  const junk = buildEntryName(T0 + 9, OTHER, "junk");
  const objects = {
    [good]: objRes(JSON.stringify(comment({ body: "<b>hi</b>" })), { "x-amz-meta-uid": UID, "x-amz-meta-name": "Sam" }),
    [forged]: objRes(JSON.stringify(comment()), { "x-amz-meta-uid": UID, "x-amz-meta-name": "Sam" }),
    [junk]: objRes("GIF89a...", { "x-amz-meta-uid": OTHER, "x-amz-meta-name": "Eve" }),
  };
  const { Q, calls } = boot({
    routes: (url) => {
      const u = new URL(url);
      if (u.pathname === "/__qw/comments/my-article/") {
        return xmlRes(listXml([good, forged, junk, "notes.txt"].map((n) => ({ key: key(n), modified: T0 }))));
      }
      const name = u.pathname.split("/").pop();
      return objects[name];
    },
  });
  const t = await Q.connect().load();
  assert.equal(t.comments.length, 1);
  assert.equal(t.comments[0].body, "<b>hi</b>", "markup survives as text; the site renders it with textContent");
  assert.deepEqual(t.rejected.map((r) => r.reason).sort(), [
    "its author does not match who uploaded it", "not JSON", "not a comment name",
  ]);
  assert.equal(t.complete, true);
  assert.equal(t.last, key(junk));
  assert.ok(!calls.some((c) => c.url.endsWith("notes.txt")), "a refused key is never fetched");
});

test("load follows continuation tokens, and a failed list throws", async () => {
  const a = buildEntryName(T0, UID, "a");
  const b = buildEntryName(T0 + 1, UID, "b");
  const body = (n) => objRes(JSON.stringify(comment({ body: n })), { "x-amz-meta-uid": UID, "x-amz-meta-name": "Sam" });
  const { Q, calls } = boot({
    routes: (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/")) {
        return u.searchParams.get("continuation-token") === "page2"
          ? xmlRes(listXml([{ key: key(b), modified: T0 + 1 }]))
          : xmlRes(listXml([{ key: key(a), modified: T0 }], { truncated: true, next: "page2" }));
      }
      return body(u.pathname.split("/").pop());
    },
  });
  const t = await Q.connect().load();
  assert.deepEqual(t.comments.map((c) => c.body), [a, b]);
  assert.equal(calls.filter((c) => c.url.includes("/my-article/?") || c.url.endsWith("/my-article/")).length, 2);

  const broken = boot({ routes: () => new Response("<!doctype html>404", { status: 404 }) });
  await assert.rejects(broken.Q.connect().load(), (e) => e.code === "http" && e.status === 404);
});

test("posting without a session asks for sign-in, and sign-in comes back to this page", async () => {
  const { Q, assigned } = boot({
    routes: (url) => (url.includes("/api/comments/ticket") ? new Response("{}", { status: 401 }) : null),
  });
  const c = Q.connect();
  await assert.rejects(c.post({ body: "hello" }), (e) => {
    assert.equal(e.code, "signin");
    assert.equal(e.signInUrl, "https://app.quickieweb.com/access.html?site=www&for=comment&next=%2Fmy-article.html%3Fref%3Dx");
    return true;
  });
  c.signIn();
  assert.deepEqual(assigned, [c.signInUrl()]);
});

test("an invalid comment is refused before any network call", async () => {
  const { Q, calls } = boot({ routes: () => null });
  await assert.rejects(Q.connect().post({ body: "" }), (e) => e.code === "invalid" && /empty/.test(e.message));
  assert.equal(calls.length, 0);
});

test("a post is a form upload to S3, with the ticket's fields, a server-clock key, and the file last", async () => {
  let form;
  // The browser's clock is 2 minutes slow; the ticket's `now` corrects it.
  const skewed = T0 - 120e3;
  const { Q } = boot({
    clock: skewed,
    routes: (url, init) => {
      if (url === "https://quickieweb.com/api/comments/ticket?site=www") return Response.json(goodTicket());
      if (init.method === "POST") { form = init.body; return new Response(null, { status: 204 }); }
      return null;
    },
  });
  const c = Q.connect();
  const res = await at(skewed, () => c.post({ subject: "Great post", body: "Loved it." }));
  assert.equal(res.name, "20261022T153012123Z-k3m9x2p7q4w8-great-post.json");
  assert.equal(res.key, "sites/www/_comments/my-article/" + res.name);
  assert.equal(res.pending, false);

  const fields = [...form.keys()];
  assert.equal(fields.at(-1), "file", "S3 ignores fields after the file");
  assert.equal(form.get("x-amz-meta-uid"), UID);
  assert.equal(form.get("key"), res.key);
  assert.deepEqual(JSON.parse(await form.get("file").text()),
    { v: 1, kind: "comment", thread: "my-article", body: "Loved it.", subject: "Great post" });
});

test("S3 refusing an upload is an error with its reason, and drops the ticket", async () => {
  let tickets = 0;
  const { Q } = boot({
    routes: (url, init) => {
      if (url.includes("/api/comments/ticket")) { tickets++; return Response.json(goodTicket()); }
      if (init.method === "POST") {
        return new Response("<Error><Code>EntityTooLarge</Code><Message>Your proposed upload exceeds the maximum allowed size</Message></Error>",
          { status: 400 });
      }
      return null;
    },
  });
  const c = Q.connect();
  await at(T0, () => assert.rejects(c.post({ body: "x" }),
    (e) => e.code === "upload" && e.s3Code === "EntityTooLarge" && /exceeds the maximum/.test(e.message)));
  assert.equal(tickets, 1);
  await at(T0, () => assert.rejects(c.post({ body: "y" }), (e) => e.code === "upload"));
  assert.equal(tickets, 1, "a 400 keeps the ticket");
});

test("resolve, reopen and retract are events that name their comment", async () => {
  const posted = [];
  const { Q } = boot({
    routes: (url, init) => {
      if (url.includes("/api/comments/ticket")) return Response.json(goodTicket());
      if (init.method === "POST") { posted.push(init.body); return new Response(null, { status: 204 }); }
      return null;
    },
  });
  const c = Q.connect();
  const ref = buildEntryName(T0 - 5000, OTHER, "theirs");
  await at(T0, () => c.resolve(ref));
  assert.deepEqual(JSON.parse(await posted[0].get("file").text()), { v: 1, kind: "resolve", thread: "my-article", ref });
  assert.match(posted[0].get("key"), /-resolve\.json$/);
  await assert.rejects(c.retract("not-a-name"), (e) => e.code === "invalid");
});

test("the shipped source is the tested source", () => {
  const src = clientSource({ apex: "quickieweb.com" });
  for (const fn of [lintComment, parseListXml, checkObject, foldThread]) {
    assert.ok(src.includes(String(fn)), `${fn.name} ships exactly as tested`);
  }
  assert.throws(() => clientSource({ apex: "quickieweb.com/evil" }), /not a hosted domain/);
  assert.throws(() => clientSource({}), /not a hosted domain/);
});
