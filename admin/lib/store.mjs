// S3 access for one site.
//
// Two buckets per site, and the split is the safety model:
//   staging -- everything the editor touches. Drafts, media, sitedata. Never
//              public, never fronted by CloudFront.
//   live    -- what the world sees. Only ever written by publish(), as a
//              server-side copy from staging. Readable only by CloudFront OAC.
//
// MULTI-TENANCY
//
// A store is built from a site record, never from process environment, because
// one Lambda serves many sites and "which bucket" is a property of the request,
// not of the deployment. Every key goes through keyFor() from shared/site.mjs,
// which is what makes the `prefix` driver's isolation a property of one function
// rather than of every call site remembering to prepend something.
//
// Credentials come from the Lambda execution role. There are no keys in this
// file and none in the deployed bundle.

import {
  S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand,
  ListObjectsV2Command, CopyObjectCommand, HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";

import { keyFor, unkeyFor } from "../../shared/site.mjs";

// The buckets are not necessarily in the function's region: the function lives
// in us-east-1 with the rest of the account's Lambdas, the buckets in us-west-2.
const REGION = process.env.AWS_BUCKET_REGION ?? process.env.AWS_REGION ?? "us-west-2";
export const PLATFORM_BUCKET = process.env.PLATFORM_BUCKET ?? "";

export const s3 = new S3Client({ region: REGION });
// CloudFront is a global service whose control plane lives in us-east-1;
// pointing this at the bucket region would fail to sign correctly.
const cf = new CloudFrontClient({ region: "us-east-1" });

const clean = (key) => (key.startsWith("/") ? key.slice(1) : key);

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

// -------------------------------------------------------------- cache policy
//
// CloudFront invalidation clears the edge. It cannot clear a browser. So the two
// caches get different instructions: a long `s-maxage` for the CDN, which
// publish() invalidates on every change, and a short `max-age` for browsers,
// which we have no lever over at all. A one-year max-age on an article is
// unrecallable -- a returning reader keeps the stale copy and nothing we do from
// this side reaches them.
//
// media/ is the one honest exception: those keys carry an upload timestamp, so
// the bytes at a given URL really never change and `immutable` is true rather
// than aspirational.
const YEAR = 31536000;

export function cacheControlFor(key) {
  const k = clean(key);
  // Staging-only state. Never published, never public, read back by the admin on
  // the next request -- caching it would only serve us a stale admin list.
  if (k.startsWith("_internal/") || k === "admins.json" || k === "sitedata.json") return "no-store";
  if (k.startsWith("media/")) return `public, max-age=${YEAR}, immutable`;
  return `public, max-age=300, s-maxage=${YEAR}`;
}

/** Extension -> MIME. Only the types a site or a template package contains. */
export function contentTypeFor(key) {
  const ext = String(key).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return {
    css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
    html: "text/html; charset=utf-8", json: "application/json; charset=utf-8",
    xml: "application/xml; charset=utf-8", txt: "text/plain; charset=utf-8",
    svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    webp: "image/webp", gif: "image/gif", ico: "image/svg+xml",
    woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf",
    mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg",
  }[ext] ?? "application/octet-stream";
}

// Prefixes a publish must never move. `admin/` is the tool that fixes a bad
// publish, so it must be unreachable by one; `_internal/` is the article store
// the admin edits from, and deleting it once cost the entire source of truth
// behind a rendered site.
const SKIP_PREFIXES = ["admin/", "_internal/", "admins.json", "sitedata.json"];

/**
 * A store bound to one site.
 * @param site  a normalized site record (shared/site.mjs)
 */
export function storeFor(site) {
  const st = site.storage;
  if (!st?.stagingBucket || !st?.liveBucket) {
    throw new Error(`Site "${site.siteId}" has no storage buckets configured`);
  }

  const STAGING = st.stagingBucket;
  const LIVE = st.liveBucket;
  const DISTRIBUTION_ID = st.distributionId ?? "";
  const LOG_BUCKET = st.logBucket ?? "";

  // The single point where a tenant's key is built. Nothing below concatenates a
  // prefix by hand, and nothing above passes an already-prefixed key in.
  const k = (key) => keyFor(st, key);

  async function getBuffer(key, bucket = STAGING) {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: k(key) }));
      return await streamToBuffer(res.Body);
    } catch (err) {
      if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async function getText(key, bucket = STAGING) {
    const buf = await getBuffer(key, bucket);
    return buf === null ? null : buf.toString("utf8");
  }

  async function getJson(key, fallback = null, bucket = STAGING) {
    const text = await getText(key, bucket);
    if (text === null) return fallback;
    try {
      return JSON.parse(text);
    } catch (err) {
      // A corrupt manifest must be loud. Silently returning the fallback would
      // let publish() wipe the site's article list.
      throw new Error(`${key} is not valid JSON: ${err.message}`);
    }
  }

  async function putBuffer(key, body, contentType, bucket = STAGING) {
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: k(key), Body: body, ContentType: contentType,
      // publish() copies with MetadataDirective: "COPY", so whatever is set here
      // rides through to the live bucket unchanged.
      CacheControl: cacheControlFor(key),
    }));
    return clean(key);
  }

  const putText = (key, text, contentType = "text/plain; charset=utf-8", bucket = STAGING) =>
    putBuffer(key, Buffer.from(text, "utf8"), contentType, bucket);

  const putJson = (key, obj, bucket = STAGING) =>
    putText(key, JSON.stringify(obj, null, 2), "application/json; charset=utf-8", bucket);

  async function remove(key, bucket = STAGING) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: k(key) }));
  }

  async function exists(key, bucket = STAGING) {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: k(key) }));
      return true;
    } catch {
      return false;
    }
  }

  /** Site-relative keys. Listing is always scoped to this tenant's prefix. */
  async function list(prefix = "", bucket = STAGING) {
    const out = [];
    let token;
    do {
      const res = await s3.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: k(prefix), ContinuationToken: token,
      }));
      for (const o of res.Contents ?? []) {
        const rel = unkeyFor(st, o.Key);
        // A key outside our prefix cannot happen given the Prefix above, but if
        // it ever did, silently treating it as ours is the failure that leaks
        // one tenant's file list into another's.
        if (rel === null) continue;
        out.push({ key: rel, size: o.Size, modified: o.LastModified, etag: o.ETag?.replace(/"/g, "") });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  /**
   * Copy a template asset from the platform bucket into this site's staging
   * bucket. Server-side, so the bytes never pass through this function -- and
   * once copied the site is self-contained: dropping a template version from the
   * library cannot break a site already rendered against it.
   */
  async function copyFromPlatform(sourceKey, targetKey) {
    if (!PLATFORM_BUCKET) throw new Error("PLATFORM_BUCKET is not set");
    await s3.send(new CopyObjectCommand({
      Bucket: STAGING,
      Key: k(targetKey),
      CopySource: `${PLATFORM_BUCKET}/${encodeURIComponent(clean(sourceKey)).replace(/%2F/g, "/")}`,
      MetadataDirective: "REPLACE",
      CacheControl: cacheControlFor(targetKey),
      ContentType: contentTypeFor(targetKey),
    }));
    return clean(targetKey);
  }

  // ---------------------------------------------------------------- publish
  //
  // Compare staging against live by ETag and move only what differs. The point
  // is to avoid re-uploading the whole site and then invalidating every path in
  // CloudFront, which is both slow and, past the free tier, billable per path.
  async function computeChangeset() {
    const [stagingObjs, liveObjs] = await Promise.all([list("", STAGING), list("", LIVE)]);

    const publishable = stagingObjs.filter((o) => !SKIP_PREFIXES.some((p) => o.key.startsWith(p)));
    const liveMap = new Map(liveObjs.map((o) => [o.key, o]));
    const stagingMap = new Map(publishable.map((o) => [o.key, o]));

    const upload = publishable.filter((o) => liveMap.get(o.key)?.etag !== o.etag).map((o) => o.key);

    // Anything live that staging no longer has, except things we never publish.
    const del = liveObjs
      .filter((o) => !stagingMap.has(o.key) && !SKIP_PREFIXES.some((p) => o.key.startsWith(p)))
      .map((o) => o.key);

    return { upload, delete: del };
  }

  async function publish({ upload, delete: del }, onLog = () => {}) {
    const copied = [];
    for (const key of upload) {
      await s3.send(new CopyObjectCommand({
        Bucket: LIVE,
        Key: k(key),
        CopySource: `${STAGING}/${encodeURIComponent(k(key)).replace(/%2F/g, "/")}`,
        MetadataDirective: "COPY",
      }));
      copied.push(key);
      onLog(`copied ${key}`);
    }

    const removed = [];
    for (const key of del) {
      await s3.send(new DeleteObjectCommand({ Bucket: LIVE, Key: k(key) }));
      removed.push(key);
      onLog(`deleted ${key}`);
    }

    let invalidation = null;
    if (DISTRIBUTION_ID && (copied.length || removed.length)) {
      // Invalidation paths must be the PREFIXED keys, not the reader's URLs.
      //
      // The Host->prefix rewrite is a CloudFront Function on viewer-request,
      // which runs before the cache lookup, so the cache key is the rewritten
      // path -- /sites/acme/index.html, not /index.html. Invalidating the
      // reader's URL would clear a cache entry that does not exist and leave the
      // stale one in place, which looks exactly like "publishing did nothing".
      //
      // Under the `buckets` driver the prefix is empty and the two are the same
      // string, so this is one code path rather than a special case.
      const touched = [...copied, ...removed].map((key) => `/${k(key)}`);
      // Under ~15 paths, invalidate precisely; past that a wildcard is cheaper
      // than paying per path, since only the first 1000 paths/month are free.
      // The wildcard is scoped to THIS site: `/*` on a shared distribution would
      // dump every other tenant's cache on every publish.
      const wildcard = st.driver === "prefix" ? `/${st.prefix}*` : "/*";
      const paths = touched.length > 15 ? [wildcard] : touched;
      const res = await cf.send(new CreateInvalidationCommand({
        DistributionId: DISTRIBUTION_ID,
        InvalidationBatch: {
          CallerReference: `publish-${site.siteId}-${Date.now()}`,
          Paths: { Quantity: paths.length, Items: paths },
        },
      }));
      invalidation = res.Invalidation?.Id ?? null;
      onLog(paths.length === 1 && paths[0].endsWith("*")
        ? `invalidated ${paths[0]}`
        : `invalidated ${paths.length} path(s)`);
    }

    return { copied: copied.length, removed: removed.length, invalidation };
  }

  return {
    siteId: site.siteId,
    s3,
    STAGING, LIVE, DISTRIBUTION_ID, LOG_BUCKET,
    key: k,
    getBuffer, getText, getJson, putBuffer, putText, putJson,
    remove, exists, list, copyFromPlatform, computeChangeset, publish,
  };
}
