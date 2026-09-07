// OAuth 2.1 primitives: PKCE, authorization codes, personal access tokens, and
// the signed state that carries an authorize request to the consent screen.
//
// Pure apart from node:crypto. No filesystem, no S3, no network -- which is the
// point: every rule here that decides whether a credential is accepted can be
// tested without an AWS account, and this is the file where a mistake is worst.
//
// WHY THE AUTHORIZE REQUEST IS A SIGNED JWT AND NOT SERVER STATE
//
// Nothing is stored between /authorize and /authorize/consent. The redirect
// URI, the PKCE challenge, the client id and a nonce are packed into a token
// this server signs, and handed to the consent page as a parameter. A Lambda
// that scales to zero cannot hold a pending authorization in memory, and adding
// a session store to a platform whose entire premise is not having one would be
// a strange place to start.
//
// WHY A PAT SITS UNDER THE OAUTH FLOW
//
// Consent mints a scoped personal access token and the authorization code binds
// to that token's storage HASH. The client gets an access token and a
// PAT-backed refresh token and never sees the raw secret. Revoking a connected
// app is then the same operation as revoking a token: one thing to audit
// instead of two.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export class OAuthError extends Error {
  constructor(code, description, status = 400) {
    super(description);
    this.name = "OAuthError";
    this.code = code;             // an RFC 6749 error code, for the JSON body
    this.description = description;
    this.status = status;
  }
}

// ------------------------------------------------------------------ encoding
export const b64u = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64u = (s) =>
  Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

const sha256 = (s) => createHash("sha256").update(s).digest();

/** Constant-time compare that cannot throw on a length mismatch. */
function sameBytes(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------- PKCE
//
// S256 only. `plain` is still in the RFC and is worthless: it makes the
// verifier and the challenge the same string, so anyone who intercepts the
// authorization request can redeem the code.
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export const isValidCodeChallenge = (c) =>
  typeof c === "string" && /^[A-Za-z0-9\-._~]{43,128}$/.test(c);

export function verifyPkce(verifier, challenge) {
  if (!VERIFIER_RE.test(String(verifier ?? ""))) return false;
  if (!isValidCodeChallenge(challenge)) return false;
  return sameBytes(b64u(sha256(verifier)), challenge);
}

// ------------------------------------------------------------ redirect URIs
//
// https, or an http loopback for a desktop client. Anything else is an open
// redirect with an authorization code attached to it, which is the single
// worst bug an authorization server can ship.
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isAllowedRedirectUri(uri) {
  let u;
  try { u = new URL(String(uri)); } catch { return false; }
  if (u.hash) return false;                        // a fragment cannot survive the redirect
  if (u.protocol === "https:") return u.hostname.length > 0;
  if (u.protocol === "http:") return LOOPBACK.has(u.hostname);
  return false;
}

/**
 * Exact string match against what the client registered.
 *
 * Deliberately not prefix or origin matching. "Starts with the registered URI"
 * lets a registered https://app.example/cb accept
 * https://app.example/cb/../../evil, and every clever relaxation of this rule
 * has produced a token-theft advisory somewhere.
 */
export function matchRedirectUri(registered, requested) {
  return Array.isArray(registered) && registered.some((r) => r === requested);
}

// -------------------------------------------------------------------- tokens
export const newClientId = () => `qwc_${randomBytes(16).toString("hex")}`;
export const newNonce = () => randomBytes(16).toString("hex");

/** A PAT. The raw secret is returned once and never stored. */
export function newPat() {
  const secret = `qwp_${b64u(randomBytes(32))}`;
  return { secret, hash: hashSecret(secret) };
}

export const looksLikePat = (t) => typeof t === "string" && t.startsWith("qwp_");

/**
 * Storage hash for a secret. Plain SHA-256 rather than a password KDF on
 * purpose: this is a 256-bit random value, not a human-chosen password, so
 * there is no dictionary to slow down and nothing for bcrypt to buy. What
 * matters is that the raw secret is never at rest.
 */
export const hashSecret = (secret) => createHash("sha256").update(String(secret)).digest("hex");

/** An authorization code. Stored by hash, so a leaked bucket listing is inert. */
export function newAuthCode() {
  const code = b64u(randomBytes(32));
  return { code, hash: hashSecret(code) };
}

// ------------------------------------------------------- signed authorize state
//
// HMAC-SHA256 over a compact payload, domain-separated from every other token
// this server signs. Without the prefix, a session token and an authorize state
// signed with the same secret could be swapped for one another.
const STATE_PREFIX = "qws.";
const STATE_TTL_SEC = 10 * 60;

export function signState(payload, secret, { now = Date.now() } = {}) {
  if (!secret) throw new OAuthError("server_error", "No signing secret", 500);
  const body = b64u(JSON.stringify({ ...payload, x: Math.floor(now / 1000) + STATE_TTL_SEC }));
  const sig = b64u(createHmac("sha256", secret).update(`${STATE_PREFIX}${body}`).digest());
  return `${STATE_PREFIX}${body}.${sig}`;
}

export function verifyState(token, secret, { now = Date.now() } = {}) {
  if (!secret) throw new OAuthError("server_error", "No signing secret", 500);
  const raw = String(token ?? "");
  if (!raw.startsWith(STATE_PREFIX)) throw new OAuthError("invalid_request", "Malformed state");

  const body = raw.slice(STATE_PREFIX.length, raw.lastIndexOf("."));
  const sig = raw.slice(raw.lastIndexOf(".") + 1);
  if (!body || !sig) throw new OAuthError("invalid_request", "Malformed state");

  const expected = b64u(createHmac("sha256", secret).update(`${STATE_PREFIX}${body}`).digest());
  if (!sameBytes(sig, expected)) throw new OAuthError("invalid_request", "State signature is not valid");

  let payload;
  try {
    payload = JSON.parse(unb64u(body).toString("utf8"));
  } catch {
    throw new OAuthError("invalid_request", "Unreadable state");
  }
  if (!payload.x || payload.x * 1000 < now) {
    throw new OAuthError("invalid_request", "This sign-in took too long. Start again.");
  }
  return payload;
}

// ----------------------------------------------------------------- registration
/**
 * Vet a dynamic client registration (RFC 7591).
 *
 * Grant and response types are constrained to what this server supports
 * regardless of what the client asked for, rather than echoed back -- a client
 * that believes it has `implicit` because it said so is a client that will send
 * a request this server refuses in a way it does not expect.
 */
export function checkRegistration(body = {}) {
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || !uris.length) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uris is required and must be a non-empty array");
  }
  if (uris.length > 8) {
    throw new OAuthError("invalid_redirect_uri", "Too many redirect_uris");
  }
  for (const uri of uris) {
    if (typeof uri !== "string" || !isAllowedRedirectUri(uri)) {
      throw new OAuthError("invalid_redirect_uri",
        `redirect_uri not allowed: ${uri}. Must be https, or http on localhost.`);
    }
  }
  const name = typeof body.client_name === "string" ? body.client_name.slice(0, 120) : "";
  return {
    redirect_uris: [...uris],
    client_name: name,
    // A public PKCE client. No secret is issued, so there is none to leak from
    // a desktop client's config file.
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
}

/** RFC 8414 discovery metadata. */
export function authorizationServerMetadata(issuer) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    // One coarse scope, advertised so discovery is well-formed. The real
    // authorization is the per-site set chosen on the consent screen: an MCP
    // client asks for scopes before it knows who you are, so it cannot name a
    // site, and the consent screen is the only place with that information.
    scopes_supported: ["quickieweb"],
    service_documentation: "https://github.com/bissellator/quickieweb/blob/main/docs/MCP.md",
  };
}

/** RFC 9728 protected-resource metadata, served by the MCP endpoint. */
export function protectedResourceMetadata(resource, issuer) {
  return {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["quickieweb"],
  };
}
