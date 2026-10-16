// Reader-access tokens: what the edge accepts as proof of a reading level.
//
//   <kind>.<site>.<level>.<exp>.<hmac>
//
//   g1   a GRANT. Minted by the Lambda after sign-in, carried in one redirect
//        URL to /__qw/session on the site, valid for at most 2 minutes. It ends
//        up in browser history, which is why it is that short.
//   v1   a SESSION. Minted by the edge from a grant, stored in the host-only
//        qw_access cookie, valid for 12 hours.
//
// The kind is part of the signed text, so a grant can never be replayed as a
// session or the reverse. The site is too, so a cookie for one tenant is
// worthless on another even if a browser were tricked into sending it.
//
// No base64, no JSON: every field is already [a-z0-9-], which is exactly what a
// CloudFront Function can split and compare in a few bytes of code. The edge has
// its own copy of verify() in infra/edge/tenant-router.js (it cannot import);
// test/edge.test.mjs runs both against the same tokens.
//
// Pure apart from node:crypto. No S3, no network.

import { createHmac, timingSafeEqual } from "node:crypto";
import { ACCESS_LEVELS } from "./site.mjs";

export const GRANT_TTL_SEC = 60;
export const GRANT_MAX_SEC = 120;
export const SESSION_SEC = 43200;

const SITE_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

function hmac(body, secret) {
  if (!secret) throw new Error("no access secret configured");
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** Mint a token. Refuses anything the edge would not accept, rather than emit it. */
export function signAccessToken({ kind, siteId, level, ttlSec, secret, now = Date.now() }) {
  if (kind !== "g1" && kind !== "v1") throw new Error(`unknown token kind ${kind}`);
  if (!SITE_RE.test(siteId ?? "")) throw new Error(`not a site id: ${siteId}`);
  if (!ACCESS_LEVELS.includes(level)) throw new Error(`not an access level: ${level}`);
  const exp = Math.floor(now / 1000) + ttlSec;
  const body = `${kind}.${siteId}.${level}.${exp}`;
  return `${body}.${hmac(body, secret)}`;
}

export const signGrant = ({ siteId, level, secret, now }) =>
  signAccessToken({ kind: "g1", siteId, level, ttlSec: GRANT_TTL_SEC, secret, now });

/** The level a token carries, or null if it is wrong in any way. Mirrors the edge. */
export function verifyAccessToken(token, { kind, siteId, maxSec, secret, now = Date.now() }) {
  const p = String(token ?? "").split(".");
  if (p.length !== 5 || p[0] !== kind || p[1] !== siteId) return null;
  if (!ACCESS_LEVELS.includes(p[2])) return null;
  const exp = Number.parseInt(p[3], 10);
  const t = Math.floor(now / 1000);
  if (!(exp > t) || exp > t + maxSec) return null;
  const want = Buffer.from(hmac(p.slice(0, 4).join("."), secret));
  const got = Buffer.from(p[4]);
  return got.length === want.length && timingSafeEqual(got, want) ? p[2] : null;
}
