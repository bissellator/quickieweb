// The OAuth primitives and the scope model.
//
//   node --test test/oauth.test.mjs
//
// This is the file where a mistake is worst, so the tests lean on the rules
// that stop a credential being issued or accepted when it should not be:
// exact redirect matching, S256-only PKCE, signed and expiring state, and
// scopes that can only ever narrow what a role already allows.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

import {
  verifyPkce, isValidCodeChallenge, isAllowedRedirectUri, matchRedirectUri,
  signState, verifyState, checkRegistration, newPat, newAuthCode, hashSecret,
  looksLikePat, b64u, OAuthError, authorizationServerMetadata, protectedResourceMetadata,
} from "../shared/oauth.mjs";
import {
  scope, parseScope, normalizeScopes, allows, grantableFor, clampToRole,
  refusedBy, requirementFor, describeScopes, UNSCOPED_ROUTES, RESOURCES,
} from "../shared/scopes.mjs";

const SECRET = "a".repeat(64);
const challengeFor = (v) => b64u(createHash("sha256").update(v).digest());

// -------------------------------------------------------------------- PKCE
test("PKCE accepts a correct S256 verifier and nothing else", () => {
  const verifier = b64u(randomBytes(32));
  const challenge = challengeFor(verifier);

  assert.equal(verifyPkce(verifier, challenge), true);
  assert.equal(verifyPkce(b64u(randomBytes(32)), challenge), false, "a different verifier");
  assert.equal(verifyPkce(verifier, challengeFor("something else")), false);
});

test("PKCE refuses the plain method by refusing the shape it needs", () => {
  // `plain` means challenge === verifier, which is worthless: anyone who sees
  // the authorization request can redeem the code. There is no code path that
  // accepts it, so the verifier-as-challenge case must simply fail.
  const verifier = b64u(randomBytes(32));
  assert.equal(verifyPkce(verifier, verifier), false);
});

test("PKCE refuses verifiers outside the RFC length window", () => {
  for (const v of ["", "short", "a".repeat(42), "a".repeat(129), "has spaces in it!!"]) {
    assert.equal(verifyPkce(v, challengeFor(v)), false, JSON.stringify(v.slice(0, 12)));
  }
  assert.equal(isValidCodeChallenge("a".repeat(42)), false);
  assert.equal(isValidCodeChallenge("a".repeat(43)), true);
});

// ----------------------------------------------------------- redirect URIs
test("only https and http loopback are allowed", () => {
  for (const ok of [
    "https://claude.ai/api/mcp/auth_callback",
    "http://localhost:8080/cb",
    "http://127.0.0.1:53211/callback",
  ]) assert.equal(isAllowedRedirectUri(ok), true, ok);

  for (const bad of [
    "http://evil.example/cb",        // plain http off-loopback
    "javascript:alert(1)",
    "data:text/html,<script>",
    "file:///etc/passwd",
    "ftp://example.com/",
    "https://app.example/cb#frag",   // a fragment cannot survive the redirect
    "not a url",
    "",
  ]) assert.equal(isAllowedRedirectUri(bad), false, bad);
});

test("redirect matching is exact, never prefix", () => {
  const registered = ["https://app.example/cb"];
  assert.equal(matchRedirectUri(registered, "https://app.example/cb"), true);
  // Every one of these is a token-theft advisory somewhere.
  for (const bad of [
    "https://app.example/cb/../../evil",
    "https://app.example/cb/extra",
    "https://app.example/cb?next=https://evil.example",
    "https://app.example.evil/cb",
    "https://app.example/CB",
  ]) assert.equal(matchRedirectUri(registered, bad), false, bad);
});

// ------------------------------------------------------------------- state
test("state round-trips, and a tampered one is refused", () => {
  const signed = signState({ c: "qwc_x", r: "https://app.example/cb" }, SECRET);
  assert.deepEqual(
    (({ c, r }) => ({ c, r }))(verifyState(signed, SECRET)),
    { c: "qwc_x", r: "https://app.example/cb" });

  const [prefixBody, sig] = [signed.slice(0, signed.lastIndexOf(".")), signed.slice(signed.lastIndexOf(".") + 1)];
  assert.throws(() => verifyState(`${prefixBody}.${"A".repeat(sig.length)}`, SECRET), OAuthError);
  assert.throws(() => verifyState(signed, "b".repeat(64)), OAuthError, "a different secret");
  assert.throws(() => verifyState("not-a-state", SECRET), OAuthError);
});

test("state expires", () => {
  const signed = signState({ c: "qwc_x" }, SECRET, { now: 0 });
  assert.ok(verifyState(signed, SECRET, { now: 9 * 60 * 1000 }), "still good at 9 minutes");
  assert.throws(() => verifyState(signed, SECRET, { now: 11 * 60 * 1000 }), OAuthError,
    "an authorize request left open all day must not still be redeemable");
});

test("state cannot be swapped for another token this server signs", () => {
  // Domain separation: a session token and an authorize state are HMACed with
  // the same secret, so the prefix is what stops one being presented as the
  // other.
  const signed = signState({ c: "qwc_x" }, SECRET);
  assert.ok(signed.startsWith("qws."));
  assert.throws(() => verifyState(signed.replace(/^qws\./, "qw."), SECRET), OAuthError);
});

// ------------------------------------------------------------ registration
test("registration requires at least one usable redirect_uri", () => {
  assert.throws(() => checkRegistration({}), OAuthError);
  assert.throws(() => checkRegistration({ redirect_uris: [] }), OAuthError);
  assert.throws(() => checkRegistration({ redirect_uris: ["http://evil.example/cb"] }), OAuthError);
  assert.throws(() => checkRegistration({ redirect_uris: Array(9).fill("https://a.example/cb") }), OAuthError);
});

test("registration constrains grants rather than echoing what was asked for", () => {
  const client = checkRegistration({
    redirect_uris: ["https://claude.ai/cb"],
    client_name: "Claude Desktop",
    grant_types: ["implicit", "password"],
    token_endpoint_auth_method: "client_secret_basic",
  });
  assert.deepEqual(client.grant_types, ["authorization_code", "refresh_token"]);
  assert.deepEqual(client.response_types, ["code"]);
  assert.equal(client.token_endpoint_auth_method, "none");
  assert.equal(client.client_name, "Claude Desktop");
});

// ------------------------------------------------------------------ secrets
test("a PAT is returned once and stored only as a hash", () => {
  const { secret, hash } = newPat();
  assert.ok(looksLikePat(secret));
  assert.equal(hash, hashSecret(secret));
  assert.ok(!hash.includes(secret), "the stored form must not contain the secret");
  assert.notEqual(newPat().secret, secret, "and must not repeat");
});

test("an authorization code is stored by hash too", () => {
  const { code, hash } = newAuthCode();
  assert.equal(hash, hashSecret(code));
  assert.notEqual(code, hash);
});

// ------------------------------------------------------------------- scopes
test("a scope names a site, a resource and an action", () => {
  assert.equal(scope("crunchyts", "templates", "write"), "qw:crunchyts:templates:write");
  assert.deepEqual(parseScope("qw:crunchyts:templates:write"),
    { site: "crunchyts", resource: "templates", action: "write" });

  for (const bad of ["templates:write", "qw:site:nonsense:read", "qw::templates:read", "", "qw:a:b"]) {
    assert.equal(parseScope(bad), null, bad);
  }
  assert.throws(() => scope("s", "nonsense", "read"));
  assert.throws(() => scope("s", "content", "delete"));
});

test("write implies read, and nothing implies another site", () => {
  const s = ["qw:acme:content:write"];
  assert.equal(allows(s, { site: "acme", resource: "content", action: "write" }), true);
  assert.equal(allows(s, { site: "acme", resource: "content", action: "read" }), true,
    "a token that can replace an article but not read one describes no real client");
  assert.equal(allows(s, { site: "acme", resource: "templates", action: "read" }), false);
  assert.equal(allows(s, { site: "other", resource: "content", action: "read" }), false);
  assert.equal(allows([], { site: "acme", resource: "content", action: "read" }), false);
});

test("a scope is a ceiling: an editor cannot grant writes", () => {
  const asked = [
    "qw:acme:content:write", "qw:acme:content:read",
    "qw:acme:templates:write", "qw:acme:publish:write",
  ];
  const asOwner = clampToRole(asked, "owner", "acme");
  assert.deepEqual(asOwner, normalizeScopes(asked), "an owner may grant all of it");

  const asEditor = clampToRole(asked, "editor", "acme");
  assert.deepEqual(asEditor, ["qw:acme:content:read"],
    "an editor may grant reads only -- editing while someone watches is not the " +
    "same as minting a credential that edits unattended");

  // And the refusal is enumerable, so a consent screen can say why.
  assert.ok(refusedBy(asked, "editor", "acme").includes("qw:acme:publish:write"));
  assert.deepEqual(clampToRole(asked, null, "acme"), [], "a non-member grants nothing");

  assert.deepEqual(clampToRole(asked, "admin", "acme"), normalizeScopes(asked),
    "an admin may grant what an owner may");
  assert.deepEqual(clampToRole(asked, "viewer", "acme"), [],
    "a viewer grants nothing, not even reads: a read token would see drafts the viewer cannot");
});

test("a scope for another site is dropped, whatever the role", () => {
  assert.deepEqual(clampToRole(["qw:other:content:write"], "owner", "acme"), []);
});

test("stats is read-only even for an owner", () => {
  assert.ok(!grantableFor("owner", "acme").includes("qw:acme:stats:write"));
  assert.ok(grantableFor("owner", "acme").includes("qw:acme:stats:read"));
});

test("publish is its own resource, separable from content", () => {
  assert.ok(RESOURCES.includes("publish"));
  const draftOnly = clampToRole(
    RESOURCES.filter((r) => r !== "publish").map((r) => `qw:acme:${r}:write`), "owner", "acme");
  assert.equal(allows(draftOnly, { site: "acme", resource: "content", action: "write" }), true);
  assert.equal(allows(draftOnly, { site: "acme", resource: "publish", action: "write" }), false,
    "an agent that drafts but cannot publish is the common case");
});

// ------------------------------------------------------------ route mapping
test("every route maps to a resource, or to nothing at all", () => {
  assert.deepEqual(requirementFor("articles", "GET"), { resource: "content", action: "read" });
  assert.deepEqual(requirementFor("articles", "PUT"), { resource: "content", action: "write" });
  assert.deepEqual(requirementFor("publish", "GET"), { resource: "publish", action: "read" });
  assert.deepEqual(requirementFor("publish", "POST"), { resource: "publish", action: "write" });

  // An unlisted route resolves to null, which callers must read as "no token
  // reaches this" -- failing closed rather than open.
  assert.equal(requirementFor("something-new", "GET"), null);
  for (const r of ["health", "session", "me", "sites"]) assert.ok(UNSCOPED_ROUTES.has(r));
});

// -------------------------------------------------------------- description
test("scopes summarize per site, with write outranking read", () => {
  const out = describeScopes([
    "qw:acme:content:read", "qw:acme:content:write", "qw:www:stats:read",
  ]);
  const acme = out.find((s) => s.site === "acme");
  assert.deepEqual(acme.grants, [{ resource: "content", action: "write" }],
    "showing both read and write for one resource is noise");
  assert.deepEqual(out.find((s) => s.site === "www").grants,
    [{ resource: "stats", action: "read" }]);
});

// ---------------------------------------------------------------- discovery
test("discovery metadata advertises S256 and public clients only", () => {
  const m = authorizationServerMetadata("https://app.quickieweb.com");
  assert.deepEqual(m.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(m.token_endpoint_auth_methods_supported, ["none"]);
  assert.equal(m.authorization_endpoint, "https://app.quickieweb.com/authorize");
  assert.equal(m.registration_endpoint, "https://app.quickieweb.com/register");
  assert.ok(!("device_authorization_endpoint" in m), "not implemented, so not advertised");

  const r = protectedResourceMetadata("https://mcp.quickieweb.com/mcp", "https://app.quickieweb.com");
  assert.deepEqual(r.authorization_servers, ["https://app.quickieweb.com"]);
});
