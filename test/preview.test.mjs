// The preview token.
//
//   node --test test/preview.test.mjs
//
// It is a credential that travels in a URL, so it gets the same scrutiny as the
// session token: forgery, tampering, expiry, and confusion with the other HMAC
// issued under the same secret.

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  issuePreviewToken, verifyPreviewToken, previewFile, PREVIEW_TTL_SEC, PREVIEW_HEADERS,
} from "../admin/lib/preview.mjs";
import { issueSession, verifySession } from "../admin/lib/auth.mjs";

const SECRET = "a".repeat(64);
const CLAIMS = { siteId: "acme", templateId: "plain", email: "a@e.com" };

test("a token round-trips its claims", () => {
  const { token, expiresAt } = issuePreviewToken(CLAIMS, SECRET);
  const back = verifyPreviewToken(token, SECRET);
  assert.equal(back.siteId, "acme");
  assert.equal(back.templateId, "plain");
  assert.equal(back.email, "a@e.com");
  assert.ok(expiresAt > Date.now());
  assert.ok(expiresAt <= Date.now() + PREVIEW_TTL_SEC * 1000 + 1000);
});

test("the signature actually binds the claims", () => {
  const { token } = issuePreviewToken(CLAIMS, SECRET);
  const [body, sig] = token.split(".");

  // Repoint it at another tenant's site, keeping the signature.
  const forged = Buffer.from(JSON.stringify({
    ...JSON.parse(Buffer.from(body, "base64url").toString("utf8")), s: "victim",
  })).toString("base64url");
  assert.throws(() => verifyPreviewToken(`${forged}.${sig}`, SECRET), /not valid/);

  // Flip a bit in the signature.
  //
  // Deliberately NOT by swapping the last base64url character: an HMAC-SHA256 is
  // 32 bytes = 256 bits, base64url packs 6 bits per character, so the 43rd
  // character carries only 4 significant bits and its low 2 are discarded on
  // decode. "A", "B", "C" and "D" all decode to the same byte. An earlier
  // version of this test flipped exactly that and passed or failed depending on
  // which character the signature happened to end with.
  const bytes = Buffer.from(sig, "base64url");
  bytes[0] ^= 0x01;
  const bad = bytes.toString("base64url");
  assert.notEqual(bad, sig, "the mutation must actually change the bytes");
  assert.throws(() => verifyPreviewToken(`${body}.${bad}`, SECRET), /not valid/);

  // And every position, not just the first, so a partial comparison would show.
  for (let i = 0; i < bytes.length; i++) {
    const flipped = Buffer.from(sig, "base64url");
    flipped[i] ^= 0x80;
    assert.throws(() => verifyPreviewToken(`${body}.${flipped.toString("base64url")}`, SECRET),
      /not valid/, `a flipped bit in signature byte ${i} must be rejected`);
  }
});

test("another secret cannot mint one", () => {
  const { token } = issuePreviewToken(CLAIMS, SECRET);
  assert.throws(() => verifyPreviewToken(token, "b".repeat(64)), /not valid/);
});

test("an expired token is refused, and says so usefully", () => {
  const body = Buffer.from(JSON.stringify({
    s: "acme", t: "", e: "a@e.com", x: Math.floor(Date.now() / 1000) - 1,
  })).toString("base64url");
  const sig = createHmac("sha256", SECRET).update(`preview.${body}`).digest("base64url");
  const err = (() => { try { verifyPreviewToken(`${body}.${sig}`, SECRET); } catch (e) { return e; } })();
  assert.match(err.message, /expired/);
  assert.equal(err.status, 410, "410 Gone, not a bare 403 -- the link was valid, it aged out");
});

test("a session token is not a preview token, and vice versa", () => {
  // Both are HMACs under the same secret. The domain prefix is what stops one
  // being replayed as the other.
  const { token: session } = issueSession({ email: "a@e.com", role: "user", name: "A" }, SECRET);
  assert.throws(() => verifyPreviewToken(session.replace(/^qw\./, ""), SECRET));

  const { token: preview } = issuePreviewToken(CLAIMS, SECRET);
  assert.throws(() => verifySession(`qw.${preview}`, SECRET));
});

test("malformed input is refused as 4xx, never a crash", () => {
  for (const bad of ["", "nodot", ".", "a.b.c", "!!!.???", null, undefined]) {
    const err = (() => { try { verifyPreviewToken(bad, SECRET); return null; } catch (e) { return e; } })();
    assert.ok(err, `expected a rejection for ${JSON.stringify(bad)}`);
    assert.ok(err.status >= 400 && err.status < 500, `${JSON.stringify(bad)} -> ${err.status}`);
  }
});

test("a missing secret fails closed", () => {
  assert.throws(() => issuePreviewToken(CLAIMS, ""), /SESSION_SECRET/);
  assert.throws(() => verifyPreviewToken("a.b", ""), /SESSION_SECRET/);
});

// ------------------------------------------------------------------ paths
test("a directory path resolves to its index", () => {
  assert.equal(previewFile([]), "index.html");
  assert.equal(previewFile([""]), "index.html");
  assert.equal(previewFile(["docs", ""]), "docs/index.html");
});

test("a file path is passed through untouched", () => {
  assert.equal(previewFile(["about.html"]), "about.html");
  assert.equal(previewFile(["assets", "style.css"]), "assets/style.css");
});

test("traversal cannot reach anything, because only rendered names exist", () => {
  // previewFile does not sanitise; it does not need to. The result is a lookup
  // key into the file map the renderer just produced, so a name that is not in
  // that map is simply absent -- there is no filesystem behind it to escape to.
  const files = { "index.html": "x", "about.html": "y" };
  for (const attempt of [["..", "..", "etc", "passwd"], ["../../secret"], ["_internal/articles/index.json"]]) {
    assert.equal(files[previewFile(attempt)], undefined, attempt.join("/"));
  }
});

// ----------------------------------------------------------------- headers
test("a preview is never indexed, shared-cached or framed off-origin", () => {
  assert.match(PREVIEW_HEADERS["x-robots-tag"], /noindex/);
  assert.match(PREVIEW_HEADERS["cache-control"], /no-store/);
  assert.match(PREVIEW_HEADERS["cache-control"], /private/);
  assert.match(PREVIEW_HEADERS["content-security-policy"], /frame-ancestors 'self'/);
  assert.equal(PREVIEW_HEADERS["x-content-type-options"], "nosniff");
});

// ---------------------------------------------------------------- media view
test("a media-view token round-trips and is not a preview token", async () => {
  const { issueMediaViewToken, verifyMediaViewToken, verifyPreviewToken } = await import("../admin/lib/preview.mjs");
  const { token } = issueMediaViewToken({ siteId: "stuck", email: "a@b.c" }, "s3cret");
  const claims = verifyMediaViewToken(token, "s3cret");
  assert.equal(claims.siteId, "stuck");
  assert.equal(claims.email, "a@b.c");
  assert.throws(() => verifyMediaViewToken(token, "other"), /not valid/);
  assert.throws(() => verifyPreviewToken(token, "s3cret"), /not valid/);
});

test("the media view serves staged images and nothing else", async () => {
  const { mediaViewKey, imageType } = await import("../admin/lib/preview.mjs");
  assert.equal(mediaViewKey(["articleimages", "x.webp"]), "articleimages/x.webp");
  assert.equal(mediaViewKey(["media", "1-a%20b.JPG"]), "media/1-a b.JPG");
  assert.equal(imageType("media/1-a b.JPG"), "image/jpeg");
  for (const bad of [[], ["index.html"], ["_internal", "articles", "x.webp"], ["..", "other", "x.png"],
    ["a", "", "x.png"], ["a%5C..%5Cx.png"]]) {
    assert.throws(() => mediaViewKey(bad), /Not an image/, JSON.stringify(bad));
  }
});
