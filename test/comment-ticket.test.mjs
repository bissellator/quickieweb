// Comment tickets: who may have one, the commenter session, and the signed
// token the edge checks on every comment write.
//
//   node --test test/comment-ticket.test.mjs
//
// The token is the security boundary for writes -- site, author, role, where it
// lands -- so the tests take it apart and check every field, and
// test/comment-writer.test.mjs holds the edge to accepting exactly these.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

import {
  commenterUid, commentDecision, signCommentGrant, signCommentSession, verifyCommenterToken,
  signCommentTicket, encodeTicketName, COMMENT_GRANT_SEC, COMMENT_SESSION_SEC, TICKET_SEC, COMMENT_WRITE_PATH,
} from "../shared/comment-ticket.mjs";
import { ticketProblem } from "../shared/comments.mjs";
import { normalizeSite, normalizeSiteComments } from "../shared/site.mjs";

const SECRET = "test-secret-0123456789abcdef";
const NOW = Date.UTC(2026, 9, 22, 15, 30, 12, 123);

const site = (comments, members = [{ email: "owner@acme.test", role: "owner" }]) =>
  normalizeSite({ siteId: "acme", members, comments });

// ------------------------------------------------------------- settings
test("comments default to anyone signed in, unmoderated", () => {
  assert.deepEqual(normalizeSiteComments(undefined), { who: "signed-in", approval: false });
  assert.deepEqual(site(undefined).comments, { who: "signed-in", approval: false });
  assert.deepEqual(normalizeSiteComments({ who: "members", approval: true }), { who: "members", approval: true });
  assert.deepEqual(normalizeSiteComments({ who: "everyone", approval: "yes" }), { who: "signed-in", approval: false },
    "an unknown setting falls back to the default, and approval is only ever an explicit true");
});

test("who may comment, and whether it waits for approval", () => {
  assert.deepEqual(commentDecision(site({ who: "signed-in" }), "anyone@x.test"), { allowed: true, pending: false, role: "none" });
  assert.deepEqual(commentDecision(site({ who: "signed-in", approval: true }), "anyone@x.test"), { allowed: true, pending: true, role: "none" });
  assert.deepEqual(commentDecision(site({ who: "signed-in", approval: true }), "owner@acme.test"),
    { allowed: true, pending: false, role: "owner" }, "a member is not moderated");
  assert.equal(commentDecision(site({ who: "signed-in" }), null).status, 401);
  assert.equal(commentDecision(site({ who: "off" }), "owner@acme.test").status, 403, "off is off, even for the owner");
  assert.equal(commentDecision(site({ who: "members" }), "stranger@x.test").status, 403);
  assert.deepEqual(commentDecision(site({ who: "members" }), "OWNER@acme.test"), { allowed: true, pending: false, role: "owner" });
});

// ------------------------------------------------------------------- uid
test("a uid is stable per person, and not a hash anyone can recompute", () => {
  const uid = commenterUid("Sam@Example.com", SECRET);
  assert.match(uid, /^[0-9a-f]{16}$/);
  assert.equal(commenterUid(" sam@example.com ", SECRET), uid);
  assert.notEqual(commenterUid("sam@example.com", "another-secret"), uid);
  assert.ok(!createHash("sha256").update("sam@example.com").digest("hex").startsWith(uid));
  assert.throws(() => commenterUid("", SECRET), /email/);
  assert.throws(() => commenterUid("a@b", ""), /secret/);
});

// ---------------------------------------------------------------- tokens
const opts = (extra = {}) => ({ siteId: "acme", email: "Sam@Example.com", name: "Sam O", secret: SECRET, now: NOW, ...extra });
const verify = (token, extra = {}) => verifyCommenterToken(token,
  { kind: "cs1", siteId: "acme", maxSec: COMMENT_SESSION_SEC, secret: SECRET, now: NOW, ...extra });

test("a session round-trips who the commenter is", () => {
  assert.deepEqual(verify(signCommentSession(opts())), { email: "sam@example.com", name: "Sam O" });
  assert.deepEqual(verify(signCommentSession(opts({ name: "" }))), { email: "sam@example.com", name: "Reader" },
    "no name falls back to a neutral one, never to any part of the address");
});

test("a grant is not a session, and neither works on another site", () => {
  const grant = signCommentGrant(opts());
  assert.equal(verify(grant), null);
  assert.ok(verifyCommenterToken(grant, { kind: "cg1", siteId: "acme", maxSec: COMMENT_GRANT_SEC, secret: SECRET, now: NOW }));
  assert.equal(verify(signCommentSession(opts()), { siteId: "beta" }), null);
});

test("a tampered, forged, expired or over-long token is refused", () => {
  const good = signCommentSession(opts());
  const p = good.split(".");
  const evil = Buffer.from(JSON.stringify({ e: "owner@acme.test", n: "Owner" })).toString("base64url");
  assert.equal(verify([p[0], p[1], p[2], evil, p[4]].join(".")), null, "swapped identity");
  assert.equal(verify([p[0], p[1], String(+p[2] + 999), p[3], p[4]].join(".")), null, "extended expiry");
  assert.equal(verify(signCommentSession(opts({ secret: "guess" }))), null, "wrong key");
  assert.equal(verify(good, { now: NOW + (COMMENT_SESSION_SEC + 1) * 1000 }), null, "expired");
  assert.equal(verify(signCommentGrant(opts()), { kind: "cg1", maxSec: 10 }), null, "lives longer than allowed");
  assert.equal(verify("cs1.acme.1.2"), null);
  assert.equal(verify(undefined), null);
});

// --------------------------------------------------------------- tickets
const ticket = (extra = {}) => signCommentTicket({
  siteId: "acme", pending: false, uid: "0123456789abcdef", name: "Renée O. Smith", secret: SECRET, now: NOW, ...extra,
});

test("a ticket is eight dot-separated parts, signed over the first seven", () => {
  const t = ticket();
  const p = t.token.split(".");
  assert.equal(p.length, 8, "a dot in the name must not add a part");
  const exp = Math.floor(NOW / 1000) + TICKET_SEC;
  assert.deepEqual(p.slice(0, 7), ["t1", "acme", String(exp), "0123456789abcdef", "none", "c", "Ren%C3%A9e%20O%2E%20Smith"]);
  assert.equal(p[7], createHmac("sha256", SECRET).update(p.slice(0, 7).join(".")).digest("hex"));
  assert.equal(t.expires, new Date(exp * 1000).toISOString());
  assert.equal(t.url, COMMENT_WRITE_PATH);
  assert.equal(t.prefix, "_comments/");
  assert.equal(t.name, "Renée O. Smith");
  assert.equal(decodeURIComponent(p[6]), "Renée O. Smith", "what the edge stores as x-amz-meta-name decodes to the name");
});

test("the role and the destination are in the signed part", () => {
  assert.equal(ticket({ role: "editor" }).token.split(".")[4], "editor");
  const pending = ticket({ pending: true });
  assert.equal(pending.token.split(".")[5], "p");
  assert.equal(pending.prefix, "_pending/");
  assert.equal(pending.pending, true);
  assert.throws(() => ticket({ role: "staff" }), /not a commenter role/);
});

test("a name is shown as given, bounded, and never empty", () => {
  assert.equal(ticket({ name: "" }).name, "Reader");
  assert.equal(ticket({ name: "x".repeat(200) }).name.length, 80);
  assert.equal(encodeTicketName("a.b"), "a%2Eb");
  assert.match(encodeTicketName("𝔘 'quoted' (x) *!~_-"), /^[A-Za-z0-9%_~!*'()-]+$/, "only what the edge accepts");
});

test("a ticket is exactly what the browser library accepts", () => {
  assert.equal(ticketProblem(ticket()), null);
  assert.equal(ticketProblem(ticket({ pending: true })), null);
  assert.match(ticketProblem({ ...ticket(), url: "https://evil.test/" }), /write path/);
  assert.match(ticketProblem({ ...ticket(), token: undefined }), /token/);
});

test("a ticket is never signed for something it should not cover", () => {
  assert.throws(() => ticket({ siteId: "../beta" }), /site id/);
  assert.throws(() => ticket({ siteId: "a.b" }), /site id/, "a dot would shift every part after it");
  assert.throws(() => ticket({ uid: "../x" }), /uid/);
  assert.throws(() => ticket({ secret: "" }), /secret/);
});
