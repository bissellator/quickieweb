// The server side of comments: who may have an upload ticket, the session that
// proves who they are, and the S3 POST policy that IS the ticket.
//
// Pure apart from node:crypto. No S3, no network: the Lambda passes in its own
// credentials and the site record, and gets back JSON to answer with.
//
// WHY A SECOND SESSION, NOT A FIELD ON qw_access
//
// qw_access is the edge's: `v1.<site>.<level>.<exp>.<hmac>`, checked on every
// page view by a CloudFront Function with ~3 KB of room left. Commenting needs
// more -- who the person is, so S3 can pin their uid and name on every object --
// and none of it is the edge's business. So a commenter gets their own cookie,
// qw_commenter, set and read by the Lambda on the site's own host at
// /api/comments/*, and the edge function does not change at all.
//
//   cg1.<site>.<exp>.<payload>.<hmac>   a GRANT: minted on the console host after
//                                       sign-in, carried in one redirect, 2 minutes
//   cs1.<site>.<exp>.<payload>.<hmac>   a SESSION: the qw_commenter cookie, 12 hours
//
// <payload> is base64url JSON { e: email, n: display name }. The email is kept
// (signed, HttpOnly, never shown) so every ticket re-checks membership and the
// site's current settings: removing someone, or turning comments off, takes
// effect within one ticket lifetime, not one session.
//
// THE uid
//
// Comment keys are public, so the uid in them must not be a plain hash of the
// email -- anyone could hash an address they know and look for it. It is an
// HMAC under the access secret: stable per person, meaningless to anyone else.
//
// APPROVAL
//
// A site that requires approval gets tickets for _pending/ instead of
// _comments/. The edge only ever serves _comments/, so a pending comment is not
// hidden by the reader library -- it is unreachable. Approving is a CMS action
// that copies it across. The policy pins one prefix, so changing the setting
// reaches readers within one ticket lifetime (TICKET_SEC).

import { createHmac, timingSafeEqual } from "node:crypto";
import { COMMENT_LIMITS } from "./comments.mjs";
import { roleInSite } from "./site.mjs";

export const COMMENTER_COOKIE = "qw_commenter";
export const COMMENT_GRANT_SEC = 120;
export const COMMENT_SESSION_SEC = 43200;
// Short, and refetched by the library as it expires. A Lambda's own credentials
// do not outlive a few hours either, and S3 refuses a policy once the
// credentials that signed it have expired, whatever the policy says.
export const TICKET_SEC = 3600;
// A ticket never outlives the credentials that signed it, less this much, so a
// reader is never handed a policy S3 is about to stop honouring.
export const CREDENTIAL_MARGIN_SEC = 300;
// Comment objects are never rewritten -- approval copies to a new key -- so the
// CDN and browsers may keep them forever.
export const COMMENT_CACHE_CONTROL = "public, max-age=31536000, immutable";

const SITE_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

const hmacHex = (key, text) => createHmac("sha256", key).update(text).digest("hex");
const b64u = (s) => Buffer.from(s, "utf8").toString("base64url");
const unb64u = (s) => Buffer.from(s, "base64url").toString("utf8");

function secretOrThrow(secret) {
  if (!secret) throw new Error("no access secret configured");
  return secret;
}

/** The public id a person comments under on every site. */
export function commenterUid(email, secret) {
  const addr = String(email ?? "").trim().toLowerCase();
  if (!addr.includes("@")) throw new Error("a commenter needs an email address");
  return hmacHex(secretOrThrow(secret), `commenter:${addr}`).slice(0, 16);
}

/**
 * Whether this person may comment on this site right now, and where their
 * comments go. `email` is null for someone not signed in.
 */
/** What x-amz-meta-role may hold: a site role, or "none" for everyone else. */
export const COMMENTER_ROLES = Object.freeze(["owner", "admin", "editor", "viewer", "none"]);

export function commentDecision(siteRecord, email) {
  const { who, approval } = siteRecord.comments;
  if (who === "off") return { allowed: false, status: 403, reason: "Comments are turned off on this site." };
  if (!email) return { allowed: false, status: 401, reason: "Sign in to comment." };
  const role = roleInSite(email, siteRecord);
  if (who === "members" && !role) {
    return { allowed: false, status: 403, reason: `Only members of this site can comment, and ${email} is not one.` };
  }
  // Someone with a role on the site is not moderated: approval exists for
  // strangers, and a member's resolve waiting in a queue would be absurd.
  return { allowed: true, pending: approval && !role, role: role ?? "none" };
}

// -------------------------------------------------------------- tokens

export function signCommenterToken({ kind, siteId, email, name, secret, ttlSec, now = Date.now() }) {
  if (kind !== "cg1" && kind !== "cs1") throw new Error(`unknown commenter token kind ${kind}`);
  if (!SITE_RE.test(siteId ?? "")) throw new Error(`not a site id: ${siteId}`);
  const addr = String(email ?? "").trim().toLowerCase();
  if (!addr.includes("@")) throw new Error("a commenter token needs an email address");
  // Never derived from the address: the sign-in page promises the email is not
  // shown, and the part before the @ is often most of it.
  const display = String(name ?? "").trim().slice(0, COMMENT_LIMITS.authorChars) || "Reader";
  const body = `${kind}.${siteId}.${Math.floor(now / 1000) + ttlSec}.${b64u(JSON.stringify({ e: addr, n: display }))}`;
  return `${body}.${hmacHex(secretOrThrow(secret), body)}`;
}

export const signCommentGrant = (o) => signCommenterToken({ ...o, kind: "cg1", ttlSec: COMMENT_GRANT_SEC });
export const signCommentSession = (o) => signCommenterToken({ ...o, kind: "cs1", ttlSec: COMMENT_SESSION_SEC });

/** { email, name } from a token, or null if it is wrong in any way. */
export function verifyCommenterToken(token, { kind, siteId, maxSec, secret, now = Date.now() }) {
  const p = String(token ?? "").split(".");
  if (p.length !== 5 || p[0] !== kind || p[1] !== siteId) return null;
  const exp = Number.parseInt(p[2], 10);
  const t = Math.floor(now / 1000);
  if (!(exp > t) || exp > t + maxSec) return null;
  const want = Buffer.from(hmacHex(secretOrThrow(secret), p.slice(0, 4).join(".")));
  const got = Buffer.from(p[4]);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  // Signed by us, so a payload that does not parse is a bug, not an attack.
  const { e, n } = JSON.parse(unb64u(p[3]));
  return { email: e, name: n };
}

// -------------------------------------------------------------- tickets

/** SigV4's derived key: secret -> date -> region -> service -> aws4_request. */
export function signingKey(secretAccessKey, yyyymmdd, region, service) {
  let key = `AWS4${secretAccessKey}`;
  for (const part of [yyyymmdd, region, service, "aws4_request"]) key = createHmac("sha256", key).update(part).digest();
  return key;
}

const amzDate = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/**
 * A browser-form upload ticket: an S3 POST policy, SigV4-signed with the
 * caller's credentials. S3 enforces every condition in it; the client library
 * only fills in the key and the file.
 *
 *   key            starts with <sitePrefix>/_comments/ (or _pending/)
 *   size           1 .. COMMENT_LIMITS.objectBytes
 *   Content-Type   exactly application/json
 *   Cache-Control  exactly COMMENT_CACHE_CONTROL
 *   x-amz-meta-uid / x-amz-meta-name   exactly this person
 *   x-amz-meta-role                    their role on the site when the ticket
 *                                      was issued, or "none" -- what readers
 *                                      check before honouring a resolve
 *
 * S3 also refuses a form carrying any field the policy does not name, so a
 * caller cannot add metadata of their own.
 */
export function signCommentTicket({
  bucket, region, sitePrefix, pending, uid, name, role = "none", credentials, now = Date.now(), ttlSec = TICKET_SEC,
}) {
  if (!COMMENTER_ROLES.includes(role)) throw new Error(`not a commenter role: ${role}`);
  if (!/^[a-z0-9.-]{3,63}$/.test(bucket ?? "")) throw new Error(`not a bucket name: ${bucket}`);
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(region ?? "")) throw new Error(`not a region: ${region}`);
  if (!/^sites\/[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(sitePrefix ?? "")) throw new Error(`not a site prefix: ${sitePrefix}`);
  if (!/^[a-z0-9]{8,32}$/.test(uid ?? "")) throw new Error(`not a commenter uid: ${uid}`);
  const { accessKeyId, secretAccessKey, sessionToken, expiration } = credentials ?? {};
  if (!accessKeyId || !secretAccessKey) throw new Error("no AWS credentials to sign a comment ticket with");
  if (expiration) {
    const left = Math.floor((new Date(expiration).getTime() - now) / 1000) - CREDENTIAL_MARGIN_SEC;
    if (!(left > 0)) throw new Error("the credentials to sign a comment ticket with are about to expire");
    ttlSec = Math.min(ttlSec, left);
  }

  const prefix = `${sitePrefix}/${pending ? "_pending" : "_comments"}/`;
  const date = amzDate(now);
  const scope = `${date.slice(0, 8)}/${region}/s3/aws4_request`;
  const fields = {
    "Content-Type": "application/json",
    "Cache-Control": COMMENT_CACHE_CONTROL,
    "x-amz-meta-uid": uid,
    "x-amz-meta-name": encodeURIComponent(String(name ?? "")),
    "x-amz-meta-role": role,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKeyId}/${scope}`,
    "X-Amz-Date": date,
    ...(sessionToken ? { "X-Amz-Security-Token": sessionToken } : {}),
  };
  const expires = new Date(now + ttlSec * 1000).toISOString();
  const policy = Buffer.from(JSON.stringify({
    expiration: expires,
    conditions: [
      { bucket },
      ["starts-with", "$key", prefix],
      ["content-length-range", 1, COMMENT_LIMITS.objectBytes],
      ...Object.entries(fields).map(([k, v]) => ({ [k]: v })),
    ],
  })).toString("base64");

  const key = signingKey(secretAccessKey, date.slice(0, 8), region, "s3");
  return {
    url: `https://${bucket}.s3.${region}.amazonaws.com/`,
    fields: { ...fields, Policy: policy, "X-Amz-Signature": hmacHex(key, policy) },
    prefix,
    pending: Boolean(pending),
    uid,
    name: String(name ?? ""),
    role,
    now: new Date(now).toISOString(),
    expires,
  };
}
