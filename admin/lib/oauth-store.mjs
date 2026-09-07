// OAuth records in the platform bucket, beside the account registry.
//
//   oauth/clients/<client_id>.json   a dynamically registered client
//   oauth/codes/<code_hash>.json     a one-time authorization code
//   oauth/pats/<hash>.json           a scoped token, and what it may reach
//
// The platform bucket already holds the registry, is already versioned, and is
// already unreachable by any site's publish. Credentials belong with the
// account records that authorize them rather than in a store of their own.
//
// NOTHING HERE HOLDS A RAW SECRET. A PAT and an authorization code are both
// stored under the SHA-256 of the secret, so the object name is the lookup key
// and the object body proves nothing on its own. Someone who lists this prefix
// learns that tokens exist and what they may reach; they cannot use one.

import {
  GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command,
} from "@aws-sdk/client-s3";

import { OAuthError } from "../../shared/oauth.mjs";
import { normalizeScopes } from "../../shared/scopes.mjs";

const PLATFORM = process.env.PLATFORM_BUCKET ?? "";

const clientKey = (id) => `oauth/clients/${id}.json`;
const codeKey = (hash) => `oauth/codes/${hash}.json`;
const patKey = (hash) => `oauth/pats/${hash}.json`;

function requirePlatform() {
  if (!PLATFORM) {
    throw new OAuthError("server_error",
      "PLATFORM_BUCKET is not set on this function, so no credential can be issued.", 503);
  }
}

async function getJson(s3, key) {
  requirePlatform();
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: PLATFORM, Key: key }));
    const chunks = [];
    for await (const c of res.Body) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (err) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

async function putJson(s3, key, obj) {
  requirePlatform();
  await s3.send(new PutObjectCommand({
    Bucket: PLATFORM, Key: key,
    Body: JSON.stringify(obj, null, 2),
    ContentType: "application/json",
    CacheControl: "no-store",
  }));
  return obj;
}

const remove = (s3, key) =>
  s3.send(new DeleteObjectCommand({ Bucket: PLATFORM, Key: key }));

// ------------------------------------------------------------------ clients
export const getClient = (s3, clientId) =>
  clientId ? getJson(s3, clientKey(clientId)) : Promise.resolve(null);

export const putClient = (s3, client) => putJson(s3, clientKey(client.client_id), client);

// -------------------------------------------------------------------- codes
/**
 * Store a one-time authorization code.
 *
 * Short-lived on purpose: a code is redeemed within seconds of being issued, so
 * a ten-minute window is generous and anything longer is only useful to someone
 * who found it in a log.
 */
export const putCode = (s3, hash, record) =>
  putJson(s3, codeKey(hash), { ...record, createdAt: new Date().toISOString() });

/**
 * Read and delete a code in one move.
 *
 * Deleting before the caller has finished with it is deliberate: a code
 * presented twice must fail the second time even if the first redemption is
 * still in flight. The RFC calls replay an attack, not a retry, and the right
 * response to seeing one is to refuse -- which this does by there being nothing
 * left to find.
 */
export async function takeCode(s3, hash) {
  const record = await getJson(s3, codeKey(hash));
  if (!record) return null;
  await remove(s3, codeKey(hash)).catch(() => { /* already gone: still consumed */ });
  return record;
}

// --------------------------------------------------------------------- PATs
/**
 * @param record { hash, email, name, scopes, clientId?, source, expiresAt }
 */
export async function putPat(s3, record) {
  const stored = {
    hash: record.hash,
    email: record.email,
    name: record.name ?? "",
    scopes: normalizeScopes(record.scopes),
    // "console" for one a person minted by hand, "oauth" for one consent
    // issued. Worth keeping so a Connected apps list can show only the latter.
    source: record.source === "oauth" ? "oauth" : "console",
    clientId: record.clientId ?? null,
    clientName: record.clientName ?? "",
    createdAt: new Date().toISOString(),
    expiresAt: record.expiresAt ?? null,
    lastUsedAt: null,
  };
  return putJson(s3, patKey(record.hash), stored);
}

export async function getPat(s3, hash) {
  const record = await getJson(s3, patKey(hash));
  if (!record) return null;
  if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) {
    // Expiry is enforced on read rather than swept: there is no scheduler here,
    // and a token nobody presents costs nothing to leave lying around.
    return null;
  }
  return record;
}

export const revokePat = (s3, hash) => remove(s3, patKey(hash));

/**
 * Every token belonging to one person.
 *
 * A full scan of the prefix, which is fine at this size and honest about why:
 * an index keyed by email would be a second thing to keep in step with the
 * objects, and the failure mode of a stale index here is a revoked token that
 * still works.
 */
export async function listPatsFor(s3, email) {
  requirePlatform();
  const out = [];
  let token;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: PLATFORM, Prefix: "oauth/pats/", ContinuationToken: token,
    }));
    for (const o of res.Contents ?? []) {
      const record = await getJson(s3, o.Key);
      if (!record || record.email !== email) continue;
      if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) continue;
      // The hash is the object name and the lookup key. Returning it would let
      // a listing be replayed as a credential, so it never leaves this module.
      const { hash, ...safe } = record;
      out.push({ ...safe, id: hash.slice(0, 12) });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/** Find one of a person's tokens by the short id a listing showed. */
export async function findPatByShortId(s3, email, shortId) {
  requirePlatform();
  let token;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: PLATFORM, Prefix: "oauth/pats/", ContinuationToken: token,
    }));
    for (const o of res.Contents ?? []) {
      const hash = o.Key.slice("oauth/pats/".length).replace(/\.json$/, "");
      if (!hash.startsWith(shortId)) continue;
      const record = await getJson(s3, o.Key);
      if (record?.email === email) return record;
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return null;
}

/**
 * Note that a token was used. Best-effort: a failure here must never turn a
 * good request into a failed one, because this is bookkeeping for a listing,
 * not part of the authorization decision.
 */
export async function touchPat(s3, record) {
  const today = new Date().toISOString().slice(0, 10);
  if ((record.lastUsedAt ?? "").slice(0, 10) === today) return;
  try {
    await putJson(s3, patKey(record.hash), { ...record, lastUsedAt: new Date().toISOString() });
  } catch { /* bookkeeping only */ }
}

export { PLATFORM };
