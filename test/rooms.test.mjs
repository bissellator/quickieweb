// Game rooms (Vamp Town multiplayer): infra/edge/room-writer.js and the rooms()
// branch of infra/edge/tenant-router.js, loaded as shipped with the store,
// crypto and clock swapped, the same way test/edge.test.mjs loads the router.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";

import { signCommentTicket } from "../shared/comment-ticket.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APEX = "quickieweb.com";
const SECRET = "test-secret-0123456789abcdef";
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0, 0);
const store = new Map([["_secret", SECRET]]);
const fakeCf = { kvs: () => ({ exists: async (k) => store.has(k), get: async (k) => store.get(k) }) };
class FakeDate extends Date {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
}

function load(file) {
  const source = readFileSync(path.join(ROOT, "infra", "edge", file), "utf8")
    .replace("__APEX__", APEX)
    .replace(/^import cf from 'cloudfront';$/m, "")
    .replace(/^import crypto from 'crypto';$/m, "");
  // eslint-disable-next-line no-new-func -- our own file, in a test, on purpose.
  return new Function("cf", "crypto", "Date", `${source}; return handler;`)(fakeCf, crypto, FakeDate);
}
const writer = load("room-writer.js");
const router = load("tenant-router.js");

const UID = "abcdef0123456789";
const OTHER = "9999999999999999";
const ticket = (uid = UID, siteId = "jeffseats") =>
  signCommentTicket({ siteId, pending: false, uid, name: "Liz", secret: SECRET, now: NOW, ttlSec: 3600 }).token;
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:.]/g, "");
const file = (uid = UID, ms = NOW) => `${stamp(ms)}-${uid}-sess01ab.json`;

const put = (uri, { tk = ticket(), length = "200", method = "PUT", host = "jeffseats.quickieweb.com", extra = {} } = {}) => writer({
  request: {
    method, uri, querystring: { a: { value: "1" } }, cookies: { c: { value: "x" } },
    headers: {
      host: { value: host },
      "content-length": { value: length },
      ...(tk ? { "x-qw-ticket": { value: tk } } : {}),
      ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, { value: v }])),
    },
  },
});
const get = (uri, query = {}) => router({
  request: {
    uri, method: "GET", cookies: {},
    headers: { host: { value: "jeffseats.quickieweb.com" } },
    querystring: Object.fromEntries(Object.entries(query).map(([k, v]) => [k, { value: v }])),
  },
});

// ------------------------------------------------------------------ writer
test("a presence file goes to _rooms/<site>/<room>/here/, never overwriting", async () => {
  const r = await put(`/__qw/room-post/town/here/${file()}`, { extra: { "x-amz-acl": "public-read" } });
  assert.equal(r.uri, `/_rooms/jeffseats/town/here/${file()}`);
  assert.equal(r.headers["if-none-match"].value, "*");
  assert.equal(r.headers["x-amz-meta-uid"].value, UID);
  assert.equal(r.headers["cache-control"].value, "no-store");
  assert.equal(r.headers["x-amz-acl"], undefined);
  assert.equal(r.headers["x-qw-ticket"], undefined);
  assert.deepEqual(r.querystring, {});
  assert.deepEqual(r.cookies, {});
});

test("a signal goes to the recipient's folder, written under the sender's uid", async () => {
  const r = await put(`/__qw/room-post/town/sig/${OTHER}/${file()}`);
  assert.equal(r.uri, `/_rooms/jeffseats/town/sig/${OTHER}/${file()}`);
});

test("the writer refuses what it should", async () => {
  const cases = [
    [405, `/__qw/room-post/town/here/${file()}`, { method: "POST" }],
    [403, `/__qw/room-post/town/here/${file()}`, { tk: null }],
    [403, `/__qw/room-post/town/here/${file()}`, { tk: ticket(OTHER) }],
    [403, `/__qw/room-post/town/here/${file()}`, { tk: ticket(UID, "otherside") }],
    [403, `/__qw/room-post/town/here/${file()}`, { tk: ticket().replace(/.$/, "0") === ticket() ? ticket().replace(/.$/, "1") : ticket().replace(/.$/, "0") }],
    [413, `/__qw/room-post/town/here/${file()}`, { length: "16385" }],
    [413, `/__qw/room-post/town/here/${file()}`, { length: "0" }],
    [400, `/__qw/room-post/town/here/${file(UID, NOW - 11 * 60 * 1000)}`, {}],
    [400, `/__qw/room-post/town/here/nope.json`, {}],
    [404, `/__qw/room-post/../here/${file()}`, {}],
    [404, `/__qw/room-post/Town/here/${file()}`, {}],
    [404, `/__qw/room-post/town/there/${file()}`, {}],
    [404, `/__qw/room-post/town/sig/../${file()}`, {}],
    [404, `/__qw/room-post/town/here/x/${file()}`, {}],
    [404, `/__qw/room-post/town/here/${file()}`, { host: "evil.example.com" }],
  ];
  for (const [status, uri, opts] of cases) {
    const r = await put(uri, opts);
    assert.equal(r.statusCode, status, `${uri} ${JSON.stringify(opts)} -> ${JSON.stringify(r).slice(0, 200)}`);
  }
});

// ------------------------------------------------------------------ router
test("listing a room folder builds a ListObjectsV2 under _rooms/ only", async () => {
  const r = await get("/__qw/rooms/town/here/", { since: stamp(NOW), prefix: "sites/", "list-type": "1" });
  assert.equal(r.uri, "/");
  assert.deepEqual(r.querystring, {
    "list-type": { value: "2" },
    prefix: { value: "_rooms/jeffseats/town/here/" },
    "start-after": { value: `_rooms/jeffseats/town/here/${stamp(NOW)}` },
  });
  const s = await get(`/__qw/rooms/town/sig/${UID}/`, { "continuation-token": "abc" });
  assert.equal(s.querystring.prefix.value, `_rooms/jeffseats/town/sig/${UID}/`);
  assert.equal(s.querystring["continuation-token"].value, "abc");
  assert.equal(s.querystring["start-after"], undefined);
});

test("reading one signal maps to its object; anything else is a 404", async () => {
  const r = await get(`/__qw/rooms/town/sig/${UID}/${file()}`);
  assert.equal(r.uri, `/_rooms/jeffseats/town/sig/${UID}/${file()}`);
  assert.deepEqual(r.querystring, {});
  for (const uri of [
    `/__qw/rooms/town/here/${file()}`,
    `/__qw/rooms/town/sig/${UID}/../x.json`,
    `/__qw/rooms/../sig/${UID}/`,
    `/__qw/rooms/town/`,
    `/__qw/rooms/town/sig/`,
  ]) {
    assert.equal((await get(uri)).statusCode, 404, uri);
  }
});
