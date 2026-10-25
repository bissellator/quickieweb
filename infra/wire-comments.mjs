#!/usr/bin/env node
// Wires the hosted stack for comments: reading and writing, both through the
// edge.
//
//   node infra/wire-comments.mjs --status   report only, change nothing
//   node infra/wire-comments.mjs
//
// SIX THINGS, EACH CHECKED BEFORE IT IS CHANGED
//
//   1. Live bucket policy: CommentsListFromOurDistribution, the ListBucket grant
//      limited to sites/*/_comments/* prefixes, and CommentsWriteFromOurDistribution,
//      PutObject under _comments/ and _pending/ only with If-None-Match. Merged
//      into the policy as it stands, so mirror grants (infra/wire-mirror.mjs)
//      are kept. The same statements are in
//      infra/iam/tenant-live-bucket-policy.json, so a later provision-hosted run
//      keeps them too.
//   2. The comment writer, infra/edge/comment-writer.js: uploaded to
//      DEVELOPMENT, run there against a ticket signed with the real secret, and
//      published to LIVE only if every case answers as it should. It is attached
//      to its own behavior alone, so publishing it changes nothing else.
//   3. A cache policy and a response headers policy for comment reads, and an
//      origin request policy for writes: the headers the writer sets, and
//      nothing else, reach S3.
//   4. The /__qw/comments/* behavior, running the same tenant router as the
//      default behavior.
//   5. The /__qw/post/* behavior, running the writer, never cached.
//   6. Live bucket CORS: the POST rule browsers needed when they uploaded to the
//      bucket directly is removed. Writes are same-origin now; nothing else
//      should be able to talk to the bucket from a browser.
//
// WHY A BEHAVIOR OF ITS OWN
//
// The default behavior's cache policy forwards no query string, and a list is
// nothing BUT a query string (list-type, prefix, start-after). This one keys on
// exactly the four the router builds. It also carries the strict headers a
// comment needs -- nosniff and a sandbox CSP -- which the shared policy cannot,
// because the console is served through the default behavior too
// (infra/wire-headers.mjs explains why, and skips this behavior).
//
// The writer has a behavior of its own for the opposite reason: it must run on
// PUT, which the default behavior does not allow, and send S3 headers the
// default behavior's policies would never forward.
//
// Needs the router that knows /__qw/comments/ (infra/provision-access.mjs)
// deployed first; until then this path falls through to a 404. The admin Lambda
// that signs edge tickets and the comments library that sends them ship after
// this (infra/deploy-lambda.mjs, infra/deploy-libs.mjs): until they do, the old
// library's uploads fail, loudly, at the missing CORS rule.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";
import { buildWriterSource, writerConfig, writerName, routerName } from "./lib/edge-function.mjs";
import { signCommentTicket } from "../shared/comment-ticket.mjs";
import { buildEntryName } from "../shared/comments.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadConfig(ROOT).catch(reportConfigError);

const STATUS_ONLY = process.argv.includes("--status");
const DIST = config.hosted?.distributionId;
const LIVE = config.hosted?.tenantLiveBucket;
const DOMAIN = config.hosted?.domain;
// infra/wire-headers.mjs names these paths too, to leave the behaviors alone.
const COMMENTS_PATH = "/__qw/comments/*";
const POST_PATH = "/__qw/post/*";
const CACHE_POLICY = "quickieweb-comments-cache";
const HEADERS_POLICY = "quickieweb-comments-headers";
const WRITE_POLICY = "quickieweb-comment-writes";
const CORS_ID = "qw-comment-uploads";
const SIDS = ["CommentsListFromOurDistribution", "CommentsWriteFromOurDistribution"];
// The standard headers infra/edge/comment-writer.js sets. CloudFront refuses
// x-amz-* in an origin request policy ("not allowed"), so the author metadata
// the function sets is not listed here: the function deletes every header it
// did not set before CloudFront sees the request.
const WRITE_HEADERS = ["content-type", "cache-control", "if-none-match"];

for (const [k, v] of Object.entries({ "hosted.distributionId": DIST, "hosted.tenantLiveBucket": LIVE, "hosted.domain": DOMAIN })) {
  if (!v || String(v).includes("REPLACE-ME")) {
    console.error(`FATAL: no ${k} in config.json. Run: node infra/provision-hosted.mjs`);
    process.exit(1);
  }
}

/**
 * An AWS CLI call. `absent` names the error that means "there is none yet"; that
 * one returns null, and every other failure throws.
 */
async function aws(args, { absent } = {}) {
  try {
    const { stdout } = await execFileAsync("aws", [...args, "--output", "json"], { maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch (err) {
    const detail = String(err.stderr || err.message).trim();
    if (absent && absent.test(detail)) return null;
    throw new Error(`aws ${args.slice(0, 2).join(" ")} failed:\n  ${detail}`);
  }
}

const log = (s) => console.log(`    ${s}`);
const step = (n, s) => console.log(`\n[${n}] ${s}`);
// AWS hands configs back with its own key order and list order (["HEAD","GET"]),
// so "is it already in place" compares a canonical form, not raw JSON.
const canon = (v) => Array.isArray(v)
  ? v.map(canon).sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1))
  : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
    : v;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

console.log(`distribution ${DIST}, bucket ${LIVE}${STATUS_ONLY ? "  (status only)" : ""}`);
const { Account: ACCOUNT } = await aws(["sts", "get-caller-identity"]);

// ------------------------------------------------------------ bucket policy
step(1, "Live bucket policy: list comment threads, write new comments");
{
  const tpl = JSON.parse(await readFile(path.join(ROOT, "infra", "iam", "tenant-live-bucket-policy.json"), "utf8"));
  const current = await aws(["s3api", "get-bucket-policy", "--bucket", LIVE]);
  const doc = JSON.parse(current.Policy);
  let changed = 0;
  for (const sid of SIDS) {
    const want = structuredClone(tpl.Statement.find((s) => s.Sid === sid));
    if (!want) throw new Error(`the policy template has no ${sid} statement`);
    delete want["//"];
    const filled = JSON.parse(JSON.stringify(want)
      .replaceAll("__BUCKET__", LIVE).replaceAll("__ACCOUNT__", ACCOUNT).replaceAll("__DISTRIBUTION__", DIST));
    const at = doc.Statement.findIndex((s) => s.Sid === sid);
    if (at !== -1 && same(doc.Statement[at], filled)) {
      log(`${sid}: already in place`);
    } else if (STATUS_ONLY) {
      log(`${sid}: ${at === -1 ? "MISSING" : "DIFFERS from the template"}`);
    } else {
      if (at === -1) doc.Statement.push(filled); else doc.Statement[at] = filled;
      log(`${sid}: ${at === -1 ? "adding" : "updating"}`);
      changed++;
    }
  }
  if (changed) {
    await aws(["s3api", "put-bucket-policy", "--bucket", LIVE, "--policy", JSON.stringify(doc)]);
    log(`written; ${doc.Statement.length} statements`);
  }
}

// ------------------------------------------------------------------- writer
step(2, "Comment writer function");
const WRITER = writerName(DOMAIN);
let writerArn = null;
{
  // The writer reads the ticket secret from the store the router already uses,
  // so it is associated with whatever the router is associated with.
  const router = await aws(["cloudfront", "describe-function", "--name", routerName(DOMAIN), "--stage", "LIVE"]);
  const kvsArn = router.FunctionSummary?.FunctionConfig?.KeyValueStoreAssociations?.Items?.[0]?.KeyValueStoreARN;
  if (!kvsArn) throw new Error(`${routerName(DOMAIN)} has no edge store. Run: node infra/provision-access.mjs`);

  const src = await buildWriterSource(ROOT, DOMAIN);
  const live = await aws(["cloudfront", "describe-function", "--name", WRITER, "--stage", "LIVE"], { absent: /NoSuchFunctionExists/ });
  const liveCode = live ? await functionCode(WRITER, "LIVE") : null;
  const liveConfig = live?.FunctionSummary?.FunctionConfig;
  const upToDate = liveCode === src && liveConfig?.KeyValueStoreAssociations?.Items?.[0]?.KeyValueStoreARN === kvsArn;

  if (upToDate) {
    log(`LIVE is current (${Buffer.byteLength(src)} bytes)`);
    writerArn = live.FunctionSummary.FunctionMetadata.FunctionARN;
  } else if (STATUS_ONLY) {
    log(live ? "LIVE DIFFERS from infra/edge/comment-writer.js" : "MISSING");
    writerArn = live?.FunctionSummary?.FunctionMetadata?.FunctionARN ?? null;
  } else {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "qw-writer-"));
    try {
      const file = path.join(tmp, "writer.js");
      await writeFile(file, src);
      const dev = await aws(["cloudfront", "describe-function", "--name", WRITER, "--stage", "DEVELOPMENT"], { absent: /NoSuchFunctionExists/ });
      const args = ["--function-config", JSON.stringify(writerConfig(DOMAIN, kvsArn)), "--function-code", `fileb://${file}`];
      const res = dev
        ? await aws(["cloudfront", "update-function", "--name", WRITER, "--if-match", dev.ETag, ...args])
        : await aws(["cloudfront", "create-function", "--name", WRITER, ...args]);
      log(`DEVELOPMENT ${dev ? "updated" : "created"} (${Buffer.byteLength(src)} bytes)`);
      await testWriter(tmp, res.ETag, kvsArn);
      const pub = await aws(["cloudfront", "publish-function", "--name", WRITER, "--if-match", res.ETag]);
      writerArn = pub.FunctionSummary.FunctionMetadata.FunctionARN;
      log("published to LIVE");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}

/** A function's code at a stage, as text. */
async function functionCode(name, stage) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "qw-fn-"));
  try {
    const out = path.join(tmp, "code.js");
    await execFileAsync("aws", ["cloudfront", "get-function", "--name", name, "--stage", stage, out]);
    return await readFile(out, "utf8");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Run DEVELOPMENT against real requests before anything is published. The
 * accepted case carries a ticket signed with the store's own secret, so it also
 * proves the function can reach the store -- the part a unit test cannot.
 * The secret is read into memory for this and never printed or written.
 */
async function testWriter(tmp, etag, kvsArn) {
  const secret = (await aws(["cloudfront-keyvaluestore", "get-key", "--kvs-arn", kvsArn, "--key", "_secret"])).Value;
  const now = Date.now();
  const t = signCommentTicket({ siteId: "www", pending: false, uid: "0000000000000000", name: "Edge test", secret, now, ttlSec: 300 });
  const other = signCommentTicket({ siteId: "www", pending: false, uid: "1111111111111111", name: "Other", secret, now, ttlSec: 300 });
  const name = buildEntryName(now, "0000000000000000", "edge-test");
  const req = (method, uri, ticket) => ({
    method, uri, querystring: {}, cookies: {},
    headers: {
      host: { value: DOMAIN },
      "content-length": { value: "50" },
      ...(ticket ? { "x-qw-ticket": { value: ticket } } : {}),
      "x-amz-acl": { value: "public-read" },
    },
  });
  const cases = [
    { why: "a valid write", request: req("PUT", `/__qw/post/edge-test/${name}`, t.token),
      want: { uri: `/sites/www/_comments/edge-test/${name}`, ifNoneMatch: "*", uid: "0000000000000000", acl: undefined } },
    { why: "someone else's uid", request: req("PUT", `/__qw/post/edge-test/${name}`, other.token), want: { status: 403 } },
    { why: "no ticket", request: req("PUT", `/__qw/post/edge-test/${name}`, null), want: { status: 403 } },
    { why: "not a PUT", request: req("GET", `/__qw/post/edge-test/${name}`, t.token), want: { status: 405 } },
    { why: "outside a thread", request: req("PUT", `/__qw/post/../admin/${name}`, t.token), want: { status: 404 } },
  ];
  let failed = 0;
  for (const c of cases) {
    const ev = path.join(tmp, "event.json");
    await writeFile(ev, JSON.stringify({ version: "1.0", context: { eventType: "viewer-request" }, viewer: { ip: "198.51.100.1" }, request: c.request }));
    const out = await aws(["cloudfront", "test-function", "--name", WRITER, "--if-match", etag, "--stage", "DEVELOPMENT", "--event-object", `fileb://${ev}`]);
    const r = out.TestResult ?? {};
    if (r.FunctionErrorMessage) { failed++; log(`FAIL ${c.why}: ${r.FunctionErrorMessage}`); continue; }
    const o = JSON.parse(r.FunctionOutput ?? "{}");
    const got = o.response
      ? { status: o.response.statusCode }
      : {
          uri: o.request?.uri, ifNoneMatch: o.request?.headers?.["if-none-match"]?.value,
          uid: o.request?.headers?.["x-amz-meta-uid"]?.value, acl: o.request?.headers?.["x-amz-acl"]?.value,
        };
    const ok = Object.entries(c.want).every(([k, v]) => got[k] === v);
    if (!ok) failed++;
    log(`${ok ? "ok  " : "FAIL"} ${c.why} -> ${JSON.stringify(got)}  (${r.ComputeUtilization}% compute)`);
  }
  if (failed) throw new Error(`${failed} writer test(s) failed on DEVELOPMENT; LIVE is untouched`);
}

// ----------------------------------------------------------------- policies
/** Create or update a named CloudFront policy; returns its id (null if missing in --status). */
async function upsertPolicy({ kind, name, config: want }) {
  const listCmd = { cache: "list-cache-policies", headers: "list-response-headers-policies", origin: "list-origin-request-policies" }[kind];
  const listed = await aws(["cloudfront", listCmd, "--type", "custom"]);
  const items = {
    cache: () => (listed.CachePolicyList?.Items ?? []).map((i) => ({ id: i.CachePolicy.Id, name: i.CachePolicy.CachePolicyConfig.Name })),
    headers: () => (listed.ResponseHeadersPolicyList?.Items ?? []).map((i) => ({ id: i.ResponseHeadersPolicy.Id, name: i.ResponseHeadersPolicy.ResponseHeadersPolicyConfig.Name })),
    origin: () => (listed.OriginRequestPolicyList?.Items ?? []).map((i) => ({ id: i.OriginRequestPolicy.Id, name: i.OriginRequestPolicy.OriginRequestPolicyConfig.Name })),
  }[kind]();
  const found = items.find((i) => i.name === name);
  const noun = { cache: "cache-policy", headers: "response-headers-policy", origin: "origin-request-policy" }[kind];
  if (STATUS_ONLY) {
    log(found ? `${name}: exists ${found.id}` : `${name}: MISSING`);
    return found?.id ?? null;
  }
  if (!found) {
    const res = await aws(["cloudfront", `create-${noun}`, `--${noun}-config`, JSON.stringify(want)]);
    const id = (res.CachePolicy ?? res.ResponseHeadersPolicy ?? res.OriginRequestPolicy).Id;
    log(`${name}: created ${id}`);
    return id;
  }
  const current = await aws(["cloudfront", `get-${noun}`, "--id", found.id]);
  await aws(["cloudfront", `update-${noun}`, "--id", found.id, "--if-match", current.ETag, `--${noun}-config`, JSON.stringify(want)]);
  log(`${name}: updated ${found.id}`);
  return found.id;
}

step(3, "Cache, response headers and origin request policies");
const cachePolicyId = await upsertPolicy({
  kind: "cache",
  name: CACHE_POLICY,
  config: {
    Name: CACHE_POLICY,
    Comment: "Comment reads: the four list parameters the tenant router builds, nothing else",
    // Objects carry their own immutable Cache-Control (set by the comment
    // writer). A list carries none, so DefaultTTL is how stale a thread may be.
    MinTTL: 0,
    DefaultTTL: 10,
    MaxTTL: 31536000,
    ParametersInCacheKeyAndForwardedToOrigin: {
      EnableAcceptEncodingGzip: true,
      EnableAcceptEncodingBrotli: true,
      HeadersConfig: { HeaderBehavior: "none" },
      CookiesConfig: { CookieBehavior: "none" },
      QueryStringsConfig: {
        QueryStringBehavior: "whitelist",
        QueryStrings: { Quantity: 4, Items: ["list-type", "prefix", "start-after", "continuation-token"] },
      },
    },
  },
});

const headersPolicyId = await upsertPolicy({
  kind: "headers",
  name: HEADERS_POLICY,
  config: {
    Name: HEADERS_POLICY,
    Comment: "Comment reads: inert data, never a document",
    SecurityHeadersConfig: {
      StrictTransportSecurity: { Override: true, AccessControlMaxAgeSec: 63072000, IncludeSubdomains: true, Preload: false },
      // Whatever an uploader claimed, a comment is never sniffed into HTML or
      // script, and opened directly it renders nothing and runs nothing.
      ContentTypeOptions: { Override: true },
      ContentSecurityPolicy: { Override: true, ContentSecurityPolicy: "sandbox; default-src 'none'" },
      FrameOptions: { Override: true, FrameOption: "DENY" },
      ReferrerPolicy: { Override: true, ReferrerPolicy: "no-referrer" },
    },
  },
});

const writePolicyId = await upsertPolicy({
  kind: "origin",
  name: WRITE_POLICY,
  config: {
    Name: WRITE_POLICY,
    Comment: "Comment writes: only the headers the comment writer sets reach S3",
    HeadersConfig: { HeaderBehavior: "whitelist", Headers: { Quantity: WRITE_HEADERS.length, Items: WRITE_HEADERS } },
    CookiesConfig: { CookieBehavior: "none" },
    QueryStringsConfig: { QueryStringBehavior: "none" },
  },
});

// ---------------------------------------------------------------- behaviors
step(4, `Behaviors ${COMMENTS_PATH} and ${POST_PATH}`);
{
  const dist = await aws(["cloudfront", "get-distribution-config", "--id", DIST]);
  const cfg = dist.DistributionConfig;
  const def = cfg.DefaultCacheBehavior;
  const router = (def.FunctionAssociations?.Items ?? []).find((f) => f.EventType === "viewer-request");
  if (!router) throw new Error("the default behavior has no viewer-request function -- is this the hosted distribution?");

  const managed = await aws(["cloudfront", "list-cache-policies", "--type", "managed"]);
  const noCache = (managed.CachePolicyList?.Items ?? []).find((i) => i.CachePolicy.CachePolicyConfig.Name === "Managed-CachingDisabled");
  if (!noCache) throw new Error("CloudFront's managed CachingDisabled policy was not found");

  const base = {
    TargetOriginId: def.TargetOriginId,
    TrustedSigners: { Enabled: false, Quantity: 0 },
    TrustedKeyGroups: { Enabled: false, Quantity: 0 },
    ViewerProtocolPolicy: "redirect-to-https",
    SmoothStreaming: false,
    LambdaFunctionAssociations: { Quantity: 0 },
    FieldLevelEncryptionId: "",
    ResponseHeadersPolicyId: headersPolicyId ?? "(created on the real run)",
  };
  const wants = [
    {
      ...base,
      PathPattern: COMMENTS_PATH,
      // Reads only. Writes are the next behavior's.
      AllowedMethods: { Quantity: 2, Items: ["GET", "HEAD"], CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] } },
      Compress: true,
      // The same router as every other path: it resolves the tenant, applies the
      // site's access level, and builds the S3 request.
      FunctionAssociations: { Quantity: 1, Items: [router] },
      CachePolicyId: cachePolicyId ?? "(created on the real run)",
    },
    {
      ...base,
      PathPattern: POST_PATH,
      // CloudFront offers GET/HEAD, +OPTIONS, or all seven; PUT needs all seven.
      // The writer answers 405 to everything but PUT.
      AllowedMethods: {
        Quantity: 7, Items: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
        CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
      },
      Compress: false,
      FunctionAssociations: { Quantity: 1, Items: [{ EventType: "viewer-request", FunctionARN: writerArn ?? "(created on the real run)" }] },
      CachePolicyId: noCache.CachePolicy.Id,
      OriginRequestPolicyId: writePolicyId ?? "(created on the real run)",
    },
  ];

  const pick = (b) => ({
    origin: b.TargetOriginId, fn: b.FunctionAssociations?.Items?.[0]?.FunctionARN,
    cache: b.CachePolicyId, request: b.OriginRequestPolicyId ?? null, headers: b.ResponseHeadersPolicyId,
    methods: b.AllowedMethods?.Items,
  });
  let items = cfg.CacheBehaviors?.Items ?? [];
  let changed = 0;
  for (const want of wants) {
    const at = items.findIndex((b) => b.PathPattern === want.PathPattern);
    if (at !== -1 && same(pick(items[at]), pick(want))) {
      log(`${want.PathPattern}: already in place`);
    } else if (STATUS_ONLY) {
      log(`${want.PathPattern}: ${at === -1 ? "MISSING" : "DIFFERS"}`);
    } else {
      items = at === -1 ? [...items, want] : items.map((b, i) => (i === at ? { ...b, ...want } : b));
      log(`${want.PathPattern}: ${at === -1 ? "adding" : "updating"}`);
      changed++;
    }
  }
  if (changed) {
    cfg.CacheBehaviors = { Quantity: items.length, Items: items };
    await aws(["cloudfront", "update-distribution", "--id", DIST, "--if-match", dist.ETag, "--distribution-config", JSON.stringify(cfg)]);
    log("distribution updated; CloudFront takes a few minutes to deploy");
  }
}

// --------------------------------------------------------------------- CORS
step(5, "Live bucket CORS: no browser uploads to the bucket");
{
  // Other rules are kept as found: this script owns one rule, not the bucket's CORS.
  const current = await aws(["s3api", "get-bucket-cors", "--bucket", LIVE], { absent: /NoSuchCORSConfiguration/ });
  const rules = current?.CORSRules ?? [];
  const rest = rules.filter((r) => r.ID !== CORS_ID);
  if (rest.length === rules.length) {
    log("no upload rule, nothing to remove");
  } else if (STATUS_ONLY) {
    log(`${CORS_ID} is still present`);
  } else if (rest.length) {
    await aws(["s3api", "put-bucket-cors", "--bucket", LIVE, "--cors-configuration", JSON.stringify({ CORSRules: rest })]);
    log(`${CORS_ID} removed; ${rest.length} other rule(s) kept`);
  } else {
    await aws(["s3api", "delete-bucket-cors", "--bucket", LIVE]);
    log(`${CORS_ID} removed; the bucket has no CORS rules now`);
  }
}

console.log(STATUS_ONLY ? "\nstatus only, nothing changed." : "\ndone.");
