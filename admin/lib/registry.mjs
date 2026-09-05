// The account registry: who exists, which sites exist, and who may touch which.
//
// Lives in the platform bucket, beside the template library but under a
// different prefix, because the two need different rights:
//
//   templates/   read-only to the Lambda. A compromised editor session must not
//                be able to alter a template that every other site renders.
//   accounts/    read-write. Provisioning a site is a write here and nothing
//                else -- no bucket, no certificate, no distribution.
//
// That split is enforced by the execution-role policy in infra/deploy-lambda.mjs,
// not by convention here.
//
// User records are keyed by a hash of the address rather than the address
// itself. An S3 key turns up in access logs, CloudTrail, bucket listings and
// error messages; an email address in all of those is a needless disclosure.

import { createHash } from "node:crypto";
import {
  GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command,
} from "@aws-sdk/client-s3";

import {
  normalizeSite, validateSite, normalizeUser, roleInSite, userKeyFor, siteKeyFor,
} from "../../shared/site.mjs";

const PLATFORM = process.env.PLATFORM_BUCKET ?? "";

export class RegistryError extends Error {
  constructor(message, status = 500) { super(message); this.name = "RegistryError"; this.status = status; }
}

const requirePlatform = () => {
  if (!PLATFORM) {
    throw new RegistryError(
      "PLATFORM_BUCKET is not set on this function, so the account registry is unreachable.", 503);
  }
};

const sha256Hex = (s) => createHash("sha256").update(s).digest("hex");

export const userKey = (email) => userKeyFor(email, sha256Hex);
export const siteKey = siteKeyFor;

async function getJson(s3, key) {
  requirePlatform();
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: PLATFORM, Key: key }));
    const chunks = [];
    for await (const c of res.Body) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (err) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) return null;
    if (err instanceof SyntaxError) {
      // A corrupt registry object must be loud. Returning null would read as
      // "no such site", and the caller would happily create a second one over it.
      throw new RegistryError(`${key} is not valid JSON: ${err.message}`);
    }
    throw err;
  }
}

async function putJson(s3, key, obj) {
  requirePlatform();
  await s3.send(new PutObjectCommand({
    Bucket: PLATFORM, Key: key,
    Body: JSON.stringify(obj, null, 2),
    ContentType: "application/json; charset=utf-8",
    CacheControl: "no-store",
  }));
}

// -------------------------------------------------------------------- sites
export async function getSite(s3, siteId) {
  const raw = await getJson(s3, siteKey(siteId));
  return raw ? normalizeSite(raw) : null;
}

export async function putSite(s3, record) {
  const problems = validateSite(record);
  if (problems.length) throw new RegistryError(`Invalid site record: ${problems.join("; ")}`, 400);
  await putJson(s3, siteKey(record.siteId), { ...record, updatedAt: new Date().toISOString() });
  return record;
}

/** Every site id in the registry. Staff-only surface: it is the tenant list. */
export async function listSiteIds(s3) {
  requirePlatform();
  const out = [];
  let token;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: PLATFORM, Prefix: "accounts/sites/", ContinuationToken: token,
    }));
    for (const o of res.Contents ?? []) {
      const m = o.Key.match(/^accounts\/sites\/([^/]+)\.json$/);
      if (m) out.push(m[1]);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out.sort();
}

/**
 * Has this id already been taken? Checked against the registry rather than
 * against a list we maintain, so a site created out of band still blocks reuse
 * of its name -- reusing one would serve the previous tenant's objects.
 */
export const siteExists = async (s3, siteId) => (await getJson(s3, siteKey(siteId))) !== null;

// -------------------------------------------------------------------- users
export async function getUser(s3, email) {
  const raw = await getJson(s3, userKey(email));
  return raw ? normalizeUser(raw) : null;
}

export async function putUser(s3, record) {
  await putJson(s3, userKey(record.email), { ...record, updatedAt: new Date().toISOString() });
  return record;
}

/**
 * The user record is a convenience index, not the authority. Membership lives on
 * the site record, and every access decision is made against that -- so a stale
 * or forged siteIds list cannot grant anything. Worst case it makes a site
 * appear in a listing that then refuses to open.
 */
export async function rememberMembership(s3, email, siteId, { name = "" } = {}) {
  const existing = (await getUser(s3, email)) ?? normalizeUser({ email, name });
  if (!existing.siteIds.includes(siteId)) existing.siteIds = [...existing.siteIds, siteId];
  existing.name ||= name;
  existing.lastSeenAt = new Date().toISOString();
  return putUser(s3, existing);
}

export async function forgetMembership(s3, email, siteId) {
  const existing = await getUser(s3, email);
  if (!existing) return null;
  existing.siteIds = existing.siteIds.filter((s) => s !== siteId);
  return putUser(s3, existing);
}

// ------------------------------------------------------------------ access
export const isStaff = (user) => user?.platformRole === "staff";

/**
 * The sites this person may actually open, each with their role.
 *
 * Re-reads every site record and re-checks membership rather than trusting the
 * user's own siteIds list. That costs one GET per remembered site and buys the
 * property the whole tenancy model rests on: the answer comes from the site, so
 * removing somebody takes effect immediately and a tampered user record grants
 * nothing.
 *
 * Staff see every site. That is a deliberate exception to "users only see the
 * sites they know" and it is why `platformRole: "staff"` is set out of band, by
 * infra/seed-platform-admin.mjs, and never through the API.
 */
export async function sitesFor(s3, email, { staff = false } = {}) {
  const ids = staff ? await listSiteIds(s3) : ((await getUser(s3, email))?.siteIds ?? []);

  const out = [];
  for (const siteId of ids) {
    const site = await getSite(s3, siteId);
    if (!site) continue;
    const role = roleInSite(email, site);
    if (!role && !staff) continue;
    out.push({
      siteId: site.siteId,
      name: site.site.name,
      domain: site.site.domain,
      baseUrl: site.site.baseUrl,
      status: site.status,
      template: site.template.id,
      // Staff reaching a site they are not a member of is visible in the
      // response rather than disguised as ordinary membership.
      role: role ?? "staff",
      viaStaff: !role,
    });
  }
  return out.sort((a, b) => a.siteId.localeCompare(b.siteId));
}

/**
 * Resolve a site and the caller's role in it, or throw. This is the one place a
 * request is bound to a tenant; every route downstream takes the result rather
 * than a site id from the request.
 */
export async function authorizeSite(s3, { email, siteId, staff = false }) {
  const site = await getSite(s3, siteId);
  // Deliberately the same error for "no such site" and "not yours": otherwise
  // the API is an oracle for which tenant names exist.
  if (!site) throw new RegistryError(`No site "${siteId}", or you do not have access to it.`, 404);

  const role = roleInSite(email, site);
  if (!role && !staff) throw new RegistryError(`No site "${siteId}", or you do not have access to it.`, 404);
  if (!role && site.status !== "active") {
    throw new RegistryError(`Site "${siteId}" is ${site.status}.`, 409);
  }
  return { site, role: role ?? "staff", viaStaff: !role };
}

export { PLATFORM };
