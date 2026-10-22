#!/usr/bin/env node
// Wires the hosted stack for comments: reading through the edge, uploading
// straight to S3.
//
//   node infra/wire-comments.mjs --status   report only, change nothing
//   node infra/wire-comments.mjs
//
// FOUR THINGS, EACH CHECKED BEFORE IT IS CHANGED
//
//   1. Live bucket policy: CommentsListFromOurDistribution, the ListBucket grant
//      limited to sites/*/_comments/* prefixes. Merged into the policy as it
//      stands, so mirror grants (infra/wire-mirror.mjs) are kept. The same
//      statement is in infra/iam/tenant-live-bucket-policy.json, so a later
//      provision-hosted run keeps it too.
//   2. Live bucket CORS: POST from any origin. Uploads are authorized by the
//      signed policy in the form, never by cookies, so "*" grants nothing a
//      ticket does not already carry. Without it the browser cannot read S3's
//      answer, and a refused upload looks the same as a network failure.
//   3. A cache policy and a response headers policy for comment reads.
//   4. The /__qw/comments/* behavior on the hosted distribution, running the
//      same tenant router as the default behavior.
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
// Needs the router that knows /__qw/comments/ (infra/provision-access.mjs)
// deployed first; until then this path falls through to a 404.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadConfig(ROOT).catch(reportConfigError);

const STATUS_ONLY = process.argv.includes("--status");
const DIST = config.hosted?.distributionId;
const LIVE = config.hosted?.tenantLiveBucket;
// infra/wire-headers.mjs names this path too, to leave the behavior alone.
const COMMENTS_PATH = "/__qw/comments/*";
const CACHE_POLICY = "quickieweb-comments-cache";
const HEADERS_POLICY = "quickieweb-comments-headers";
const CORS_ID = "qw-comment-uploads";
const SID = "CommentsListFromOurDistribution";

for (const [k, v] of Object.entries({ "hosted.distributionId": DIST, "hosted.tenantLiveBucket": LIVE })) {
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
step(1, "Live bucket policy: list comment threads only");
{
  const tpl = JSON.parse(await readFile(path.join(ROOT, "infra", "iam", "tenant-live-bucket-policy.json"), "utf8"));
  const want = structuredClone(tpl.Statement.find((s) => s.Sid === SID));
  if (!want) throw new Error(`the policy template has no ${SID} statement`);
  delete want["//"];
  const filled = JSON.parse(JSON.stringify(want)
    .replaceAll("__BUCKET__", LIVE).replaceAll("__ACCOUNT__", ACCOUNT).replaceAll("__DISTRIBUTION__", DIST));

  const current = await aws(["s3api", "get-bucket-policy", "--bucket", LIVE]);
  const doc = JSON.parse(current.Policy);
  const at = doc.Statement.findIndex((s) => s.Sid === SID);
  if (at !== -1 && same(doc.Statement[at], filled)) {
    log("already in place");
  } else if (STATUS_ONLY) {
    log(at === -1 ? "MISSING" : "DIFFERS from the template");
  } else {
    if (at === -1) doc.Statement.push(filled); else doc.Statement[at] = filled;
    await aws(["s3api", "put-bucket-policy", "--bucket", LIVE, "--policy", JSON.stringify(doc)]);
    log(`${at === -1 ? "added" : "updated"}; ${doc.Statement.length} statements`);
  }
}

// --------------------------------------------------------------------- CORS
step(2, "Live bucket CORS: browser uploads");
{
  const rule = {
    ID: CORS_ID,
    AllowedMethods: ["POST"],
    AllowedOrigins: ["*"],
    AllowedHeaders: ["*"],
    ExposeHeaders: ["ETag"],
    MaxAgeSeconds: 3600,
  };
  const current = await aws(["s3api", "get-bucket-cors", "--bucket", LIVE], { absent: /NoSuchCORSConfiguration/ });
  const rules = current?.CORSRules ?? [];
  const at = rules.findIndex((r) => r.ID === CORS_ID);
  if (at !== -1 && same(rules[at], rule)) {
    log("already in place");
  } else if (STATUS_ONLY) {
    log(at === -1 ? `MISSING (${rules.length} other rule(s) present)` : "DIFFERS");
  } else {
    // Other rules are kept as found: this script owns one rule, not the bucket's CORS.
    const next = at === -1 ? [...rules, rule] : rules.map((r, i) => (i === at ? rule : r));
    await aws(["s3api", "put-bucket-cors", "--bucket", LIVE, "--cors-configuration", JSON.stringify({ CORSRules: next })]);
    log(`${at === -1 ? "added" : "updated"}; ${next.length} rule(s)`);
  }
}

// ----------------------------------------------------------------- policies
/** Create or update a named CloudFront policy; returns its id (null if missing in --status). */
async function upsertPolicy({ kind, name, config: want }) {
  const listCmd = { cache: "list-cache-policies", headers: "list-response-headers-policies" }[kind];
  const listed = await aws(["cloudfront", listCmd, "--type", "custom"]);
  const items = kind === "cache"
    ? (listed.CachePolicyList?.Items ?? []).map((i) => ({ id: i.CachePolicy.Id, name: i.CachePolicy.CachePolicyConfig.Name }))
    : (listed.ResponseHeadersPolicyList?.Items ?? []).map((i) => ({ id: i.ResponseHeadersPolicy.Id, name: i.ResponseHeadersPolicy.ResponseHeadersPolicyConfig.Name }));
  const found = items.find((i) => i.name === name);
  const noun = kind === "cache" ? "cache-policy" : "response-headers-policy";
  if (STATUS_ONLY) {
    log(found ? `${name}: exists ${found.id}` : `${name}: MISSING`);
    return found?.id ?? null;
  }
  if (!found) {
    const res = await aws(["cloudfront", `create-${noun}`, `--${noun}-config`, JSON.stringify(want)]);
    const id = (res.CachePolicy ?? res.ResponseHeadersPolicy).Id;
    log(`${name}: created ${id}`);
    return id;
  }
  const current = await aws(["cloudfront", `get-${noun}`, "--id", found.id]);
  await aws(["cloudfront", `update-${noun}`, "--id", found.id, "--if-match", current.ETag, `--${noun}-config`, JSON.stringify(want)]);
  log(`${name}: updated ${found.id}`);
  return found.id;
}

step(3, "Cache and response headers policies");
const cachePolicyId = await upsertPolicy({
  kind: "cache",
  name: CACHE_POLICY,
  config: {
    Name: CACHE_POLICY,
    Comment: "Comment reads: the four list parameters the tenant router builds, nothing else",
    // Objects carry their own immutable Cache-Control (pinned by the upload
    // ticket). A list carries none, so DefaultTTL is how stale a thread may be.
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

// ----------------------------------------------------------------- behavior
step(4, `Behavior ${COMMENTS_PATH}`);
{
  const dist = await aws(["cloudfront", "get-distribution-config", "--id", DIST]);
  const cfg = dist.DistributionConfig;
  const def = cfg.DefaultCacheBehavior;
  const router = (def.FunctionAssociations?.Items ?? []).find((f) => f.EventType === "viewer-request");
  if (!router) throw new Error("the default behavior has no viewer-request function -- is this the hosted distribution?");

  const want = {
    PathPattern: COMMENTS_PATH,
    TargetOriginId: def.TargetOriginId,
    TrustedSigners: { Enabled: false, Quantity: 0 },
    TrustedKeyGroups: { Enabled: false, Quantity: 0 },
    ViewerProtocolPolicy: "redirect-to-https",
    // Reads only. Comment writes go to S3 directly and never touch CloudFront.
    AllowedMethods: { Quantity: 2, Items: ["GET", "HEAD"], CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] } },
    SmoothStreaming: false,
    Compress: true,
    LambdaFunctionAssociations: { Quantity: 0 },
    // The same router as every other path: it resolves the tenant, applies the
    // site's access level, and builds the S3 request.
    FunctionAssociations: { Quantity: 1, Items: [router] },
    FieldLevelEncryptionId: "",
    CachePolicyId: cachePolicyId ?? "(created on the real run)",
    ResponseHeadersPolicyId: headersPolicyId ?? "(created on the real run)",
  };

  const items = cfg.CacheBehaviors?.Items ?? [];
  const at = items.findIndex((b) => b.PathPattern === COMMENTS_PATH);
  const pick = (b) => ({
    origin: b.TargetOriginId, fn: b.FunctionAssociations?.Items?.[0]?.FunctionARN,
    cache: b.CachePolicyId, headers: b.ResponseHeadersPolicyId, methods: b.AllowedMethods?.Items,
  });
  if (at !== -1 && same(pick(items[at]), pick(want))) {
    log("already in place");
  } else if (STATUS_ONLY) {
    log(at === -1 ? "MISSING" : "DIFFERS");
  } else {
    const next = at === -1 ? [...items, want] : items.map((b, i) => (i === at ? { ...b, ...want } : b));
    cfg.CacheBehaviors = { Quantity: next.length, Items: next };
    await aws(["cloudfront", "update-distribution", "--id", DIST, "--if-match", dist.ETag, "--distribution-config", JSON.stringify(cfg)]);
    log(`${at === -1 ? "added" : "updated"}; CloudFront takes a few minutes to deploy`);
  }
}

console.log(STATUS_ONLY ? "\nstatus only, nothing changed." : "\ndone.");
