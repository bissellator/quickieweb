#!/usr/bin/env node
// Routes /api/* and /admin/* on the CloudFront distribution to the admin Lambda.
//
//   node infra/wire-cloudfront.mjs
//
// This follows the ordinary CloudFront-in-front-of-S3-and-Lambda pattern, which
// is worth stating because the "more secure looking" alternative does not work:
//
//   Lambda function URL origins are PLAIN CUSTOM ORIGINS with AuthType NONE.
//   They do NOT use Origin Access Control.
//
// OAC is used for the S3 origins here and everywhere else in the account, and
// that is correct. For Lambda function URLs it was tried (AuthType AWS_IAM +
// an OAC of type "lambda", resource policy scoped to this distribution's ARN)
// and every request came back 403 AccessDeniedException from the function URL,
// even though a SigV4 request signed by an IAM user succeeded. Rather than keep
// guessing, this now mirrors snowflake-cost-analysis (E1DQ63MYKEVP3C), which
// works: same CachingDisabled policy, same AllViewerExceptHostHeader policy,
// same https-only custom origin, no OAC.
//
// The trade-off, stated plainly: the function URL is publicly reachable. That is
// acceptable ONLY because the Lambda authenticates every /api request itself --
// Google ID token signature verified against Google's JWKS, then the email
// checked against admins.json. Network reachability was never the control.
//
// AllViewerExceptHostHeader is required, not incidental: forwarding the viewer's
// Host header to a function URL breaks it.

import { writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";

const execFileAsync = promisify(execFile);
const DRY = process.argv.includes("--dry-run");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "config.json");
const config = await loadConfig(ROOT).catch(reportConfigError);

// The function lives in lambdaRegion (us-east-1), which is NOT the bucket
// region. Reading the function URL from the bucket region points the origin
// at a function that does not exist there.
const REGION = config.deploy.lambdaRegion ?? config.deploy.region;
const DIST = config.deploy.distributionId;
const FN = config.deploy.functionName ?? "qw-admin";

// AWS managed policy ids, stable across accounts. Same pair the working
// snowflake-cost-analysis distribution uses for its /api/* behavior.
const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
const ALL_VIEWER_EXCEPT_HOST = "b689b0a8-53d0-40ab-baf2-68738e2966ac";
// The admin UI is static objects now, so it gets the opposite treatment from
// /api/*: cache it. Managed-CachingOptimized, the same policy the site uses.
const CACHING_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6";

const S3_ORIGIN_ID = "s3-live";
// Lowercase: CloudFront normalises header names, and the Lambda compares
// against the lowercased key it receives in the event.
const ORIGIN_HEADER = "x-qw-origin";
const SITE_POLICY = "qw-site-headers";
const ADMIN_POLICY = "qw-admin-headers";
const REWRITE_FN = "qw-admin-rewrite";

async function aws(args, { region = REGION, allowFail = false } = {}) {
  try {
    const { stdout } = await execFileAsync("aws", [...args, "--region", region, "--output", "json"],
      { maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`aws ${args.slice(0, 3).join(" ")} failed:\n  ${String(err.stderr || err.message).trim()}`);
  }
}

const step = (n, s) => console.log(`\n[${n}] ${s}`);
const log = (s) => console.log(`    ${s}`);

console.log(`wire ${FN} -> distribution ${DIST}`);

// ------------------------------------------------------- 1. function url
step(1, "Function URL");
const urlCfg = await aws(["lambda", "get-function-url-config", "--function-name", FN]);
if (urlCfg.AuthType !== "NONE") {
  await aws(["lambda", "update-function-url-config", "--function-name", FN, "--auth-type", "NONE"]);
  log(`auth type set to NONE (was ${urlCfg.AuthType})`);
  // A newly created or newly changed function URL takes a few minutes to accept
  // traffic. Assuming an early 403 is a misconfiguration is how the first
  // attempt at this ended up rebuilt around OAC for no reason.
  log("note: auth-type changes take a few minutes to take effect");
} else {
  log("already NONE");
}
const FN_HOST = new URL(urlCfg.FunctionUrl).host;
log(`origin host ${FN_HOST}`);

// The OAC-era statement, if a previous run left one behind.
await aws(["lambda", "remove-permission", "--function-name", FN,
  "--statement-id", "AllowCloudFrontOac"], { allowFail: true });

const policy = await aws(["lambda", "get-policy", "--function-name", FN], { allowFail: true });
const hasPublic = policy && JSON.parse(policy.Policy).Statement
  .some((s) => s.Sid === "AllowPublicFunctionUrl");
if (!hasPublic) {
  await aws(["lambda", "add-permission", "--function-name", FN,
    "--statement-id", "AllowPublicFunctionUrl",
    "--action", "lambda:InvokeFunctionUrl",
    "--principal", "*",
    "--function-url-auth-type", "NONE"]);
  log("added public invoke statement");
} else {
  log("public invoke statement already present");
}

// --------------------------------------------------- 2. origin + behaviors
step(2, "Distribution config");
const current = await aws(["cloudfront", "get-distribution-config", "--id", DIST], { region: "us-east-1" });
const etag = current.ETag;
const cfg = current.DistributionConfig;

// Resolve what infra/wire-edge.mjs created. Fail loudly rather than quietly
// attaching nothing: a distribution that silently lost its COOP header is a
// distribution nobody can sign in to.
const policies = await aws(["cloudfront", "list-response-headers-policies", "--type", "custom"],
  { region: "us-east-1" });
const policyId = (name) => {
  const hit = (policies?.ResponseHeadersPolicyList?.Items ?? [])
    .find((i) => i.ResponseHeadersPolicy?.ResponseHeadersPolicyConfig?.Name === name);
  if (!hit) throw new Error(`No response headers policy named ${name}. Run: node infra/wire-edge.mjs`);
  return hit.ResponseHeadersPolicy.Id;
};
const siteHeadersId = policyId(SITE_POLICY);
const adminHeadersId = policyId(ADMIN_POLICY);

const fn = await aws(["cloudfront", "describe-function", "--name", REWRITE_FN, "--stage", "LIVE"],
  { region: "us-east-1", allowFail: true });
if (!fn) throw new Error(`No published function named ${REWRITE_FN}. Run: node infra/wire-edge.mjs`);
const rewriteFnArn = fn.FunctionSummary.FunctionMetadata.FunctionARN;

log(`site headers  ${siteHeadersId}`);
log(`admin headers ${adminHeadersId}`);
log(`rewrite fn    ${rewriteFnArn}`);

const LAMBDA_ORIGIN_ID = "admin-lambda";

// The shared secret that proves a request came through CloudFront.
//
// The distribution config IS the source of truth for it -- deliberately. It is
// readable with get-distribution-config, so deploy-lambda.mjs can fetch it and
// hand the same value to the function, and it never has to live in the repo,
// in config.json, or in anyone's shell history.
//
// Reused if already present so re-running this script does not silently rotate
// the secret out from under a Lambda that is still enforcing the old one.
const priorLambdaOrigin = cfg.Origins.Items.find((o) => o.Id === LAMBDA_ORIGIN_ID);
const priorSecret = (priorLambdaOrigin?.CustomHeaders?.Items ?? [])
  .find((h) => h.HeaderName.toLowerCase() === ORIGIN_HEADER)?.HeaderValue;
const originSecret = priorSecret ?? randomBytes(32).toString("hex");
log(priorSecret
  ? `${ORIGIN_HEADER} already set, reusing`
  : `${ORIGIN_HEADER} generated (new secret)`);

const origins = cfg.Origins.Items.filter((o) => o.Id !== LAMBDA_ORIGIN_ID);
origins.push({
  Id: LAMBDA_ORIGIN_ID,
  DomainName: FN_HOST,
  // Required by UpdateDistribution even when empty: the API rejects the whole
  // config with "The 'originPath' field is missing" rather than defaulting it.
  OriginPath: "",
  // Deliberately no OriginAccessControlId -- see the header comment.
  CustomOriginConfig: {
    HTTPPort: 80,
    HTTPSPort: 443,
    OriginProtocolPolicy: "https-only",
    OriginSslProtocols: { Quantity: 1, Items: ["TLSv1.2"] },
    OriginReadTimeout: 60,
    OriginKeepaliveTimeout: 5,
  },
  // CloudFront overwrites a same-named header from the viewer before forwarding,
  // so this cannot be spoofed by a caller coming through the CDN. It is a
  // bearer secret against the function URL, which is the only thing it needs
  // to be: whoever does not have it cannot reach the origin directly.
  CustomHeaders: {
    Quantity: 1,
    Items: [{ HeaderName: ORIGIN_HEADER, HeaderValue: originSecret }],
  },
  OriginShield: { Enabled: false },
  ConnectionAttempts: 3,
  ConnectionTimeout: 10,
});
cfg.Origins = { Quantity: origins.length, Items: origins };

// UpdateDistribution validates against the full legacy schema and rejects the
// whole config for each omitted field, one error at a time. These are all
// "off", but they have to be present and explicit.
const OFF = {
  SmoothStreaming: false,
  FieldLevelEncryptionId: "",
  LambdaFunctionAssociations: { Quantity: 0, Items: [] },
  TrustedSigners: { Enabled: false, Quantity: 0, Items: [] },
  TrustedKeyGroups: { Enabled: false, Quantity: 0, Items: [] },
};

// /api/* is the only thing left on compute, and it stays uncached. Its cache
// key contains no Authorization header, so caching here would risk handing one
// viewer's authenticated response to the next anonymous caller.
const apiBehavior = () => ({
  PathPattern: "/api/*",
  TargetOriginId: LAMBDA_ORIGIN_ID,
  ViewerProtocolPolicy: "redirect-to-https",
  AllowedMethods: {
    Quantity: 7,
    Items: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
    CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
  },
  Compress: true,
  CachePolicyId: CACHING_DISABLED,
  OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST,
  FunctionAssociations: { Quantity: 0, Items: [] },
  ...OFF,
});

// "/admin*" not "/admin/*": bare /admin does not match "/admin/*" and would
// fall through to the default behavior. The rewrite function turns it into a
// 301 to /admin/, and turns /admin/ into /admin/index.html -- DefaultRootObject
// only ever applies to "/", never to a subdirectory.
const adminBehavior = (headersId, fnArn) => ({
  PathPattern: "/admin*",
  TargetOriginId: S3_ORIGIN_ID,
  ViewerProtocolPolicy: "redirect-to-https",
  // Static files. No writes reach this origin, so no write methods.
  AllowedMethods: {
    Quantity: 2, Items: ["GET", "HEAD"],
    CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
  },
  Compress: true,
  CachePolicyId: CACHING_OPTIMIZED,
  // No origin request policy: an S3 origin behind OAC has no use for forwarded
  // viewer headers, and forwarding Authorization to S3 would be actively odd.
  ResponseHeadersPolicyId: headersId,
  FunctionAssociations: {
    Quantity: 1,
    Items: [{ EventType: "viewer-request", FunctionARN: fnArn }],
  },
  ...OFF,
});

const keep = (cfg.CacheBehaviors?.Items ?? []).filter(
  (b) => !["/api/*", "/admin/*", "/admin*", "/admin"].includes(b.PathPattern));
const behaviors = [...keep, apiBehavior(), adminBehavior(adminHeadersId, rewriteFnArn)];
cfg.CacheBehaviors = { Quantity: behaviors.length, Items: behaviors };

// The public site had no security headers at all -- no policy on any behavior.
cfg.DefaultCacheBehavior.ResponseHeadersPolicyId = siteHeadersId;

// Scanners probing for /wp-admin/ and /.env are most of the traffic that is not
// a reader. Cache the answer hard so they stop reaching S3.
//
// 404 only, deliberately NOT 403: CustomErrorResponses apply to the whole
// distribution, not per behavior, so mapping 403 would rewrite the API's own
// "Only an owner can change the admin list" into an HTML page -- and the
// origin-lockdown 403 along with it. The live bucket policy now grants
// s3:ListBucket to the CloudFront principal, which is what makes S3 answer a
// missing key with 404 instead of AccessDenied, so 404 alone is sufficient.
cfg.CustomErrorResponses = {
  Quantity: 1,
  Items: [{
    ErrorCode: 404,
    ResponsePagePath: "/404.html",
    ResponseCode: "404",
    ErrorCachingMinTTL: 86400,
  }],
};

console.log("\n  resulting behaviors:");
for (const b of [cfg.DefaultCacheBehavior, ...behaviors]) {
  const pattern = b.PathPattern ?? "(default)";
  const fnCount = b.FunctionAssociations?.Quantity ?? 0;
  console.log(`    ${pattern.padEnd(12)} -> ${String(b.TargetOriginId).padEnd(13)}` +
    ` headers=${b.ResponseHeadersPolicyId ? "yes" : "NONE"} fn=${fnCount}`);
}
console.log(`  custom error responses: ${cfg.CustomErrorResponses.Items
  .map((e) => `${e.ErrorCode}->${e.ResponsePagePath} (${e.ErrorCachingMinTTL}s)`).join(", ")}`);

if (DRY) {
  console.log("\ndry run: distribution NOT updated.");
  process.exit(0);
}

await aws(["cloudfront", "update-distribution", "--id", DIST,
  "--if-match", etag, "--distribution-config", JSON.stringify(cfg)], { region: "us-east-1" });
log(`/admin* -> ${S3_ORIGIN_ID} (cached, rewritten at the edge), /api/* -> ${LAMBDA_ORIGIN_ID}`);

delete config.deploy.lambdaOacId;
await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");

console.log(`\nCloudFront takes ~5-10 min to redeploy, then:`);
console.log(`  https://${config.site.domain}/admin/`);
