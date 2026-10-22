// Comment tickets: who may have one, the commenter session, and the S3 POST
// policy that S3 enforces on every upload.
//
//   node --test test/comment-ticket.test.mjs
//
// The policy is the security boundary for writes -- size, type, prefix, author
// -- so the tests decode it and check every condition, rather than trusting
// that a signed blob says what it should.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

import {
  commenterUid, commentDecision, signCommentGrant, signCommentSession, verifyCommenterToken,
  signCommentTicket, signingKey, COMMENT_GRANT_SEC, COMMENT_SESSION_SEC, TICKET_SEC,
  CREDENTIAL_MARGIN_SEC, COMMENT_CACHE_CONTROL,
} from "../shared/comment-ticket.mjs";
import { COMMENT_LIMITS, ticketProblem } from "../shared/comments.mjs";
import { normalizeSite, normalizeSiteComments } from "../shared/site.mjs";

const SECRET = "test-secret-0123456789abcdef";
const NOW = Date.UTC(2026, 9, 22, 15, 30, 12, 123);
const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", sessionToken: "tok/en+=" };

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
  bucket: "quickieweb-sites-live", region: "us-west-2", sitePrefix: "sites/acme", pending: false,
  uid: "0123456789abcdef", name: "Renée O", credentials: creds, now: NOW, ...extra,
});
const policyOf = (t) => JSON.parse(Buffer.from(t.fields.Policy, "base64").toString("utf8"));

test("SigV4 key derivation matches AWS's published example", () => {
  // From the AWS General Reference, "Examples of how to derive a signing key".
  assert.equal(signingKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20120215", "us-east-1", "iam").toString("hex"),
    "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d");
});

test("the policy pins prefix, size, type and author -- every field it carries", () => {
  const t = ticket();
  const p = policyOf(t);
  assert.equal(p.expiration, new Date(NOW + TICKET_SEC * 1000).toISOString());
  assert.deepEqual(p.conditions.slice(0, 3), [
    { bucket: "quickieweb-sites-live" },
    ["starts-with", "$key", "sites/acme/_comments/"],
    ["content-length-range", 1, COMMENT_LIMITS.objectBytes],
  ]);
  // Every form field except the policy and signature is an exact-match condition,
  // so the form cannot differ from what was signed.
  const pinned = Object.assign({}, ...p.conditions.slice(3));
  const { Policy, "X-Amz-Signature": sig, ...rest } = t.fields;
  assert.deepEqual(pinned, rest);
  assert.equal(pinned["Content-Type"], "application/json");
  assert.equal(pinned["Cache-Control"], COMMENT_CACHE_CONTROL);
  assert.equal(pinned["x-amz-meta-uid"], "0123456789abcdef");
  assert.equal(pinned["x-amz-meta-name"], "Ren%C3%A9e%20O", "metadata travels as a header, so it is ASCII");
  assert.equal(pinned["x-amz-meta-role"], "none", "pinned even when there is no role, so one cannot be added");
  assert.equal(policyOf(ticket({ role: "editor" })).conditions.find((c) => "x-amz-meta-role" in c)["x-amz-meta-role"], "editor");
  assert.throws(() => ticket({ role: "staff" }), /not a commenter role/);
  assert.equal(pinned["X-Amz-Credential"], "AKIDEXAMPLE/20261022/us-west-2/s3/aws4_request");
  assert.equal(pinned["X-Amz-Date"], "20261022T153012Z");
  assert.equal(pinned["X-Amz-Security-Token"], "tok/en+=");
});

test("the signature is SigV4 over the base64 policy", () => {
  const t = ticket();
  const want = createHmac("sha256", signingKey(creds.secretAccessKey, "20261022", "us-west-2", "s3"))
    .update(t.fields.Policy).digest("hex");
  assert.equal(t.fields["X-Amz-Signature"], want);
});

test("a ticket never outlives the credentials that signed it", () => {
  const expiration = new Date(NOW + 20 * 60e3);
  const t = ticket({ credentials: { ...creds, expiration } });
  assert.equal(t.expires, new Date(NOW + (20 * 60 - CREDENTIAL_MARGIN_SEC) * 1000).toISOString());
  assert.equal(policyOf(t).expiration, t.expires);
  assert.equal(ticket({ credentials: { ...creds, expiration: new Date(NOW + 10 * 3600e3) } }).expires,
    new Date(NOW + TICKET_SEC * 1000).toISOString(), "long-lived credentials still get the normal hour");
  assert.throws(() => ticket({ credentials: { ...creds, expiration: new Date(NOW + 60e3) } }), /about to expire/);
});

test("a site that requires approval gets tickets for _pending/ only", () => {
  const t = ticket({ pending: true });
  assert.equal(t.prefix, "sites/acme/_pending/");
  assert.equal(t.pending, true);
  assert.deepEqual(policyOf(t).conditions[1], ["starts-with", "$key", "sites/acme/_pending/"]);
});

test("a ticket is exactly what the browser library accepts", () => {
  assert.equal(ticketProblem(ticket()), null);
  assert.equal(ticketProblem(ticket({ pending: true })), null);
  const noToken = ticket({ credentials: { ...creds, sessionToken: undefined } });
  assert.equal(noToken.fields["X-Amz-Security-Token"], undefined);
  assert.equal(ticketProblem(noToken), null);
});

test("a ticket is never signed for something it should not cover", () => {
  assert.throws(() => ticket({ sitePrefix: "sites/*" }), /site prefix/);
  assert.throws(() => ticket({ sitePrefix: "sites/acme/../beta" }), /site prefix/);
  assert.throws(() => ticket({ uid: "../x" }), /uid/);
  assert.throws(() => ticket({ bucket: "Bad Bucket" }), /bucket/);
  assert.throws(() => ticket({ credentials: {} }), /credentials/);
});
