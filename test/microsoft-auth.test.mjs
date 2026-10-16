// Microsoft ID token verification (admin/lib/auth.mjs).
//
//   node --test test/microsoft-auth.test.mjs
//
// Real RS256 tokens signed with a throwaway key, whose public half is served as
// Microsoft's JWKS through a stubbed fetch. Nothing reaches the network.
//
// The test that matters most is the nOAuth one: a work/school tenant's `email`
// is an attribute its admin can set to anyone's address, and access here is
// keyed on email, so an unverified one must never sign anybody in.

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";

import { verifyMicrosoftIdToken, idTokenProvider } from "../admin/lib/auth.mjs";

const CLIENT = "11111111-2222-3333-4444-555555555555";
const CONSUMER = "9188040d-6c67-4c5b-b112-36a304b66dad";
const WORK = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-kid", use: "sig", alg: "RS256" };
const realFetch = globalThis.fetch;
test.before(() => {
  globalThis.fetch = async (url) => {
    if (!String(url).startsWith("https://login.microsoftonline.com/common/discovery/v2.0/keys")) {
      throw new Error(`unexpected fetch ${url}`);
    }
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "cache-control": "max-age=3600" } });
  };
});
test.after(() => { globalThis.fetch = realFetch; });

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function token(claims, { header = {}, key = privateKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = { alg: "RS256", kid: "test-kid", typ: "JWT", ...header };
  const p = { aud: CLIENT, iat: now, nbf: now, exp: now + 3600, oid: "o1", sub: "s1", name: "Jeff", ...claims };
  const body = `${b64u(h)}.${b64u(p)}`;
  const sig = createSign("RSA-SHA256").update(body).end().sign(key).toString("base64url");
  return `${body}.${sig}`;
}
const personal = (extra = {}) => token({ iss: `https://login.microsoftonline.com/${CONSUMER}/v2.0`, tid: CONSUMER, ...extra });
const work = (extra = {}) => token({ iss: `https://login.microsoftonline.com/${WORK}/v2.0`, tid: WORK, ...extra });

test("a personal Microsoft account signs in by its address", async () => {
  const id = await verifyMicrosoftIdToken(personal({ preferred_username: "Jeff@Outlook.com" }), CLIENT);
  assert.equal(id.email, "jeff@outlook.com", "the sign-in name of a personal account is its verified address");
  assert.match(id.sub, /^ms:/);
});

test("a work account whose email Microsoft has not verified is refused (nOAuth)", async () => {
  await assert.rejects(() => verifyMicrosoftIdToken(work({ email: "victim@example.com" }), CLIENT), /not verified/);
  await assert.rejects(() => verifyMicrosoftIdToken(work({ email: "victim@example.com", xms_edov: false }), CLIENT), /not verified/);
  await assert.rejects(() => verifyMicrosoftIdToken(work({ preferred_username: "victim@example.com", xms_edov: true }), CLIENT),
    /no email/, "a work account's preferred_username is not an email claim and is never used as one");
});

test("a work account with a domain-verified email signs in", async () => {
  const id = await verifyMicrosoftIdToken(work({ email: "Ann@Corp.com", xms_edov: true }), CLIENT);
  assert.equal(id.email, "ann@corp.com");
});

test("the issuer must name the same tenant as the token", async () => {
  await assert.rejects(() => verifyMicrosoftIdToken(
    token({ iss: `https://login.microsoftonline.com/${WORK}/v2.0`, tid: CONSUMER, preferred_username: "a@outlook.com" }), CLIENT),
  /issuer/, "a work tenant cannot pass itself off as the personal-account tenant");
});

test("audience, expiry, algorithm, key and signature are all enforced", async () => {
  await assert.rejects(() => verifyMicrosoftIdToken(personal({ preferred_username: "a@outlook.com", aud: "someone-else" }), CLIENT), /different application/);
  await assert.rejects(() => verifyMicrosoftIdToken(personal({ preferred_username: "a@outlook.com", exp: 1000 }), CLIENT), /expired/);
  await assert.rejects(() => verifyMicrosoftIdToken(personal({ preferred_username: "a@outlook.com", nbf: Math.floor(Date.now() / 1000) + 9999 }), CLIENT), /not valid yet/);
  await assert.rejects(() => verifyMicrosoftIdToken(token({ iss: `https://login.microsoftonline.com/${CONSUMER}/v2.0`, tid: CONSUMER }, { header: { alg: "HS256" } }), CLIENT), /algorithm/);
  await assert.rejects(() => verifyMicrosoftIdToken(token({ iss: `https://login.microsoftonline.com/${CONSUMER}/v2.0`, tid: CONSUMER }, { header: { kid: "nope" } }), CLIENT), /unknown key/);
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  await assert.rejects(() => verifyMicrosoftIdToken(token({ iss: `https://login.microsoftonline.com/${CONSUMER}/v2.0`, tid: CONSUMER, preferred_username: "a@outlook.com" }, { key: other }), CLIENT), /signature/);
});

test("with no Microsoft client id configured, Microsoft sign-in is off rather than open", async () => {
  await assert.rejects(() => verifyMicrosoftIdToken(personal({ preferred_username: "a@outlook.com" }), ""), /not configured/);
});

test("the provider is read from the issuer only to pick a verifier", () => {
  assert.equal(idTokenProvider(personal()), "microsoft");
  assert.equal(idTokenProvider(token({ iss: "https://accounts.google.com" })), "google");
  assert.equal(idTokenProvider("not.a.jwt"), "google", "garbage goes to the Google verifier, which rejects it precisely");
  assert.equal(idTokenProvider(token({ iss: "https://login.microsoftonline.com.evil.test/x/v2.0" })), "google");
});
