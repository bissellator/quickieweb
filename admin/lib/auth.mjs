// Authentication and authorization for the admin plane.
//
// TWO SEPARATE THINGS, and conflating them is the classic way to build an
// admin that anyone can walk into:
//
//   Authentication  -- "Google says this really is alice@example.com."
//                      Proven by verifying the RS256 signature on a Google ID
//                      token against Google's published JWKS. Cannot be forged
//                      without Google's private key.
//
//   Authorization   -- "alice@example.com is on our admin list."
//                      A lookup in admins.json, which lives in the PRIVATE
//                      staging bucket.
//
// The email is only ever taken from the *verified* token payload. A client-
// supplied email field is never trusted anywhere in this file, because a
// request body is just whatever the caller decided to type.
//
// Worth contrasting with the common browser-side pattern of requesting a Google
// *access token* for some Google API and letting Google enforce access to the
// resource. There, the email the page displays is cosmetic and it does not
// matter. There is no equivalent enforcement in front of an S3 bucket, so
// verification has to happen here, on the server, before any write.

import { createVerify, createPublicKey } from "node:crypto";

const JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const CLOCK_SKEW_SEC = 300;

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

// Microsoft: one key set for every tenant, personal accounts included.
const MS_JWKS_URI = "https://login.microsoftonline.com/common/discovery/v2.0/keys";
// The tenant every personal Microsoft account (outlook.com, hotmail.com, ...)
// signs in through. Fixed by Microsoft.
const MS_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
const MS_ISSUER_RE = /^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\/v2\.0$/;

// Providers rotate signing keys; cache them but honour the cache header so a
// rotation does not lock every admin out until the next cold start.
const jwksCache = new Map();   // uri -> { keys, expiresAt }

async function fetchJwks(uri = JWKS_URI, label = "Google") {
  const hit = jwksCache.get(uri);
  if (hit?.keys && Date.now() < hit.expiresAt) return hit.keys;

  const res = await fetch(uri);
  if (!res.ok) throw new AuthError(`Could not fetch ${label} JWKS (HTTP ${res.status})`, 503);

  const body = await res.json();
  if (!Array.isArray(body.keys) || !body.keys.length) {
    throw new AuthError(`${label} JWKS response contained no keys`, 503);
  }

  // Respect max-age, floor of 5 minutes so a bad header cannot hammer anyone.
  const cc = res.headers.get("cache-control") ?? "";
  const maxAge = Number(cc.match(/max-age=(\d+)/)?.[1] ?? 3600);
  jwksCache.set(uri, { keys: body.keys, expiresAt: Date.now() + Math.max(maxAge, 300) * 1000 });
  return body.keys;
}

const b64uToBuf = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

function jwkToPem(jwk) {
  return createPublicKey({ key: jwk, format: "jwk" });
}

/**
 * Verify a Google ID token and return its payload.
 * Throws AuthError on anything that is not a valid, current, correctly-audienced
 * token. There is no path through this function that trusts unverified input.
 */
export async function verifyGoogleIdToken(idToken, clientId) {
  if (!idToken || typeof idToken !== "string") throw new AuthError("Missing ID token");
  if (!clientId) throw new AuthError("Server misconfigured: no GOOGLE_CLIENT_ID", 500);

  const parts = idToken.split(".");
  if (parts.length !== 3) throw new AuthError("Malformed ID token");

  const [headerB64, payloadB64, sigB64] = parts;

  let header, payload;
  try {
    header = JSON.parse(b64uToBuf(headerB64).toString("utf8"));
    payload = JSON.parse(b64uToBuf(payloadB64).toString("utf8"));
  } catch {
    throw new AuthError("Unparseable ID token");
  }

  // Only RS256. Refusing to read `alg` from the token as an instruction is what
  // stops the "alg: none" and HMAC-confusion families of attack.
  if (header.alg !== "RS256") throw new AuthError(`Unexpected token algorithm: ${header.alg}`);

  const keys = await fetchJwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new AuthError("Token signed with an unknown key");

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  if (!verifier.verify(jwkToPem(jwk), b64uToBuf(sigB64))) {
    throw new AuthError("ID token signature is not valid");
  }

  // Signature is good. Now the claims have to be for US, and current.
  const now = Math.floor(Date.now() / 1000);
  if (!ISSUERS.has(payload.iss)) throw new AuthError(`Unexpected issuer: ${payload.iss}`);
  if (payload.aud !== clientId) throw new AuthError("Token was issued for a different application");
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_SEC < now) {
    throw new AuthError("ID token has expired");
  }
  if (typeof payload.iat === "number" && payload.iat - CLOCK_SKEW_SEC > now) {
    throw new AuthError("ID token is not valid yet");
  }
  if (!payload.email) throw new AuthError("Token carries no email claim");
  // An unverified Google email can be an address the holder does not control.
  if (payload.email_verified !== true && payload.email_verified !== "true") {
    throw new AuthError("Google has not verified that email address");
  }

  return {
    email: String(payload.email).toLowerCase(),
    name: payload.name ?? null,
    picture: payload.picture ?? null,
    sub: payload.sub,
    expiresAt: payload.exp,
  };
}

/**
 * Which provider minted this ID token, read from its UNVERIFIED issuer.
 *
 * Only ever used to pick which verifier runs, and each verifier then checks the
 * issuer itself against the signature it validates -- so lying about the issuer
 * just sends a token to a verifier that rejects it.
 */
export function idTokenProvider(idToken) {
  try {
    const payload = JSON.parse(b64uToBuf(String(idToken).split(".")[1] ?? "").toString("utf8"));
    return MS_ISSUER_RE.test(payload?.iss ?? "") ? "microsoft" : "google";
  } catch {
    // Unparseable: let the Google verifier produce its precise error.
    return "google";
  }
}

/**
 * Verify a Microsoft (Entra ID or personal account) ID token.
 *
 * Same discipline as Google's -- RS256 only, the key from Microsoft's JWKS, the
 * audience pinned, the clock checked -- plus one rule Google does not need.
 *
 * THE EMAIL MUST BE ONE MICROSOFT VOUCHES FOR
 *
 * In a work or school tenant the `email` claim is an attribute an administrator
 * can set to anything, verified or not. Trusting it is the "nOAuth" class of
 * account takeover: make a tenant, set your user's email to the victim's, sign
 * in to any app that keys accounts on email. Since access here IS keyed on
 * email, an address is accepted only when:
 *   - it is a personal Microsoft account (the consumer tenant), whose address is
 *     the account's own verified sign-in name; or
 *   - the token carries xms_edov=true: Microsoft asserting that the email's
 *     domain is verified as owned by that tenant. It is an optional claim the
 *     app registration has to ask for (see the Microsoft section of docs/ADMIN.md).
 */
export async function verifyMicrosoftIdToken(idToken, clientId) {
  if (!idToken || typeof idToken !== "string") throw new AuthError("Missing ID token");
  if (!clientId) throw new AuthError("Microsoft sign-in is not configured on this installation", 400);

  const parts = idToken.split(".");
  if (parts.length !== 3) throw new AuthError("Malformed ID token");
  const [headerB64, payloadB64, sigB64] = parts;

  let header, payload;
  try {
    header = JSON.parse(b64uToBuf(headerB64).toString("utf8"));
    payload = JSON.parse(b64uToBuf(payloadB64).toString("utf8"));
  } catch {
    throw new AuthError("Unparseable ID token");
  }
  if (header.alg !== "RS256") throw new AuthError(`Unexpected token algorithm: ${header.alg}`);

  const keys = await fetchJwks(MS_JWKS_URI, "Microsoft");
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new AuthError("Token signed with an unknown key");

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  if (!verifier.verify(jwkToPem(jwk), b64uToBuf(sigB64))) {
    throw new AuthError("ID token signature is not valid");
  }

  const now = Math.floor(Date.now() / 1000);
  // The issuer names the tenant, and must name the SAME tenant as `tid`: the
  // common key set signs for every tenant, so the issuer is what binds a token
  // to one of them.
  const tenant = MS_ISSUER_RE.exec(payload.iss ?? "")?.[1];
  if (!tenant || tenant !== payload.tid) throw new AuthError(`Unexpected issuer: ${payload.iss}`);
  if (payload.aud !== clientId) throw new AuthError("Token was issued for a different application");
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_SEC < now) {
    throw new AuthError("ID token has expired");
  }
  if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_SEC > now) {
    throw new AuthError("ID token is not valid yet");
  }

  const personal = tenant === MS_CONSUMER_TENANT;
  const email = String(payload.email ?? (personal ? payload.preferred_username : "") ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AuthError("Token carries no email address");
  const domainVerified = payload.xms_edov === true || payload.xms_edov === "true" || payload.xms_edov === 1 || payload.xms_edov === "1";
  if (!personal && !domainVerified) {
    throw new AuthError("Microsoft has not verified that this organisation owns the email address on this account, " +
      "so it cannot be used to sign in here.", 403);
  }

  return {
    email,
    name: payload.name ?? null,
    picture: null,
    sub: `ms:${tenant}:${payload.oid ?? payload.sub}`,
    expiresAt: payload.exp,
  };
}

// ------------------------------------------------------------- authorization

export const ROLES = ["owner", "editor"];

/** Shape check so a hand-edited admins.json cannot silently disable auth. */
export function normalizeAdmins(doc) {
  if (!doc || !Array.isArray(doc.admins)) {
    throw new AuthError("admins.json is malformed: expected { admins: [...] }", 500);
  }
  return doc.admins
    .filter((a) => a && typeof a.email === "string")
    .map((a) => ({
      email: a.email.trim().toLowerCase(),
      role: ROLES.includes(a.role) ? a.role : "editor",
      name: typeof a.name === "string" ? a.name : null,
      added: a.added ?? null,
    }));
}

/**
 * Resolve a verified identity against the admin list.
 * An empty list denies everyone -- it must never mean "auth disabled". That is
 * the opposite of the common basic-auth helper that returns true when no
 * credentials are configured; convenient for local dev, catastrophic if the
 * config ever fails to load in production.
 */
export function authorize(identity, adminList) {
  const match = adminList.find((a) => a.email === identity.email);
  if (!match) {
    throw new AuthError(`${identity.email} is not on the admin list`, 403);
  }
  return { ...identity, role: match.role, displayName: match.name ?? identity.name };
}

export const isOwner = (actor) => actor.role === "owner";

/**
 * Guard rails for edits to the admin list itself. Both of these exist to stop
 * an account locking itself, or everyone, out of the site permanently.
 */
export function validateAdminListChange(nextList, actor) {
  const owners = nextList.filter((a) => a.role === "owner");
  if (owners.length === 0) {
    throw new AuthError("Refusing to save: that would leave the site with no owner", 400);
  }
  if (!nextList.some((a) => a.email === actor.email)) {
    throw new AuthError("Refusing to save: that would remove your own access", 400);
  }
  const seen = new Set();
  for (const a of nextList) {
    if (seen.has(a.email)) throw new AuthError(`Duplicate entry for ${a.email}`, 400);
    seen.add(a.email);
  }
  return nextList;
}

/** Pull the bearer token out of an Authorization header. */
export function bearerFrom(req) {
  const m = (req.headers["authorization"] || "").match(/^Bearer\s+(.+)$/i);
  if (!m) throw new AuthError("Missing Authorization: Bearer <google-id-token>");
  return m[1].trim();
}

// ---------------------------------------------------------------- sessions
//
// A Google ID token is a login assertion with a one-hour life, and Google will
// not silently reissue one. Using it directly as the session credential means
// being thrown out every hour, potentially mid-article. So it is exchanged once
// for a session token this server signs itself.
//
// HMAC-SHA256 over a compact payload, with the secret held only in the Lambda's
// environment. No database, no session store, nothing to scale to zero -- the
// token carries its own claims and its own expiry, and the signature is what
// makes it trustworthy.
//
// Deliberately NOT a cookie: the client holds this in sessionStorage and sends
// it as a bearer token. A cookie would be sent automatically by the browser on
// any cross-site request, which is the entire CSRF problem. A header is not.

import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const SESSION_PREFIX = "qw.";
export const SESSION_TTL_SEC = 12 * 60 * 60; // a working day

const b64u = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export const newSessionSecret = () => randomBytes(32).toString("hex");

export function issueSession({ email, role, name }, secret) {
  if (!secret) throw new AuthError("Server misconfigured: no SESSION_SECRET", 500);
  const payload = {
    e: email,
    r: role,
    n: name ?? null,
    x: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC,
  };
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(createHmac("sha256", secret).update(body).digest());
  return { token: `${SESSION_PREFIX}${body}.${sig}`, expiresAt: payload.x * 1000 };
}

export const looksLikeSession = (t) => typeof t === "string" && t.startsWith(SESSION_PREFIX);

export function verifySession(token, secret) {
  if (!secret) throw new AuthError("Server misconfigured: no SESSION_SECRET", 500);
  const raw = token.slice(SESSION_PREFIX.length);
  const dot = raw.lastIndexOf(".");
  if (dot === -1) throw new AuthError("Malformed session token");

  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);

  const expected = createHmac("sha256", secret).update(body).digest();
  const given = unb64u(sig);
  // Length check first: timingSafeEqual throws on a mismatch rather than
  // returning false, which would surface as a 500 instead of a clean 401.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new AuthError("Session signature is not valid");
  }

  let payload;
  try {
    payload = JSON.parse(unb64u(body).toString("utf8"));
  } catch {
    throw new AuthError("Unreadable session token");
  }
  if (!payload.x || payload.x * 1000 < Date.now()) {
    throw new AuthError("Your session expired. Sign in again.");
  }
  return { email: payload.e, role: payload.r, name: payload.n, displayName: payload.n };
}
