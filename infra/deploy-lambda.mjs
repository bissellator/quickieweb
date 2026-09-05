#!/usr/bin/env node
// Creates or updates the admin Lambda, its execution role, and its Function URL.
//
//   node infra/deploy-lambda.mjs                       create/update
//   node infra/deploy-lambda.mjs --client-id <id>      set the Google client id
//
// Idempotent: every step checks first. Re-running after a code change just
// pushes new bytes.
//
// The execution role is scoped narrowly on purpose:
//   staging bucket  read/write   (drafts, media, admins.json)
//   live bucket     read/write   (publish target)
//   cloudfront      invalidation on this one distribution
// Nothing else. No iam:*, no s3:* on all buckets, no wildcard resources beyond
// the two bucket ARNs.

import { writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "config.json");
const config = await loadConfig(ROOT).catch(reportConfigError);

// Buckets stay where they are; the function moves.
//
// An inherited comment here blamed the REGION for public function URLs returning
// 403: "a us-west-2 function URL with AuthType NONE returns 403 no matter how
// the resource policy is written". That is not true, and believing it costs an
// afternoon. A us-west-2 function with a public URL answers 200 perfectly well.
// The real cause is a resource policy carrying only lambda:InvokeFunctionUrl --
// a public URL needs lambda:InvokeFunction as well. See the add-permission loop
// below. The region is a deployment preference, nothing more.
const REGION = config.deploy.lambdaRegion ?? config.deploy.region;
const BUCKET_REGION = config.deploy.region;
const LIVE = config.deploy.bucket;
const STAGING = config.deploy.stagingBucket;
const DIST = config.deploy.distributionId;
// The template library + account registry bucket, shared by every site in this
// installation. Empty is tolerated so an existing single-site install still
// deploys; the function reports the gap through /api/health rather than failing
// on a cold start.
const PLATFORM = config.deploy.platformBucket ?? "";
const LOGS = config.hosted?.tenantLogBucket ?? config.deploy.logBucket ?? "";
const FN = config.deploy.functionName || "qw-admin";
const ROLE = `${FN}-role`;
const ZIP = path.join(ROOT, "infra", `${FN}.zip`);

const argv = process.argv.slice(2);
const clientIdArg = argv.includes("--client-id") ? argv[argv.indexOf("--client-id") + 1] : null;
const CLIENT_ID = clientIdArg ?? config.deploy.googleClientId ?? "";

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

const ACCOUNT = (await aws(["sts", "get-caller-identity"], { region: "us-east-1" })).Account;
console.log(`deploy ${FN}  account=${ACCOUNT} region=${REGION}`);

// ---------------------------------------------------------------------- role
step(1, "Execution role");
const trust = {
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
};

let roleArn = (await aws(["iam", "get-role", "--role-name", ROLE], { region: "us-east-1", allowFail: true }))?.Role?.Arn;
if (!roleArn) {
  const res = await aws(["iam", "create-role", "--role-name", ROLE,
    "--assume-role-policy-document", JSON.stringify(trust),
    "--description", `Execution role for the ${FN} Lambda`], { region: "us-east-1" });
  roleArn = res.Role.Arn;
  log(`created ${roleArn}`);
  // IAM is eventually consistent; creating a function too soon fails with
  // "The role defined for the function cannot be assumed by Lambda."
  await new Promise((r) => setTimeout(r, 12000));
} else {
  log(`exists ${roleArn}`);
}

await aws(["iam", "attach-role-policy", "--role-name", ROLE,
  "--policy-arn", "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"], { region: "us-east-1" });

// Buckets this function may touch. On a self-hosted install that is one site's
// pair; on the hosted platform it is the shared tenant pair, with per-site
// isolation enforced by the key prefix rather than by IAM. That is the honest
// trade of the `prefix` driver and the reason keyFor() in shared/site.mjs is the
// only place a tenant key is built.
const CONTENT_BUCKETS = [...new Set([
  STAGING, LIVE,
  config.hosted?.tenantStagingBucket, config.hosted?.tenantLiveBucket,
].filter((b) => b && !String(b).includes("REPLACE-ME")))];
if (!CONTENT_BUCKETS.length) {
  console.error("FATAL: no content buckets configured.\n" +
    "  Run infra/provision-hosted.mjs (hosted) or infra/provision.mjs (self-hosted)\n" +
    "  before deploying the function.");
  process.exit(1);
}

const inline = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "ContentObjects",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      Resource: CONTENT_BUCKETS.map((b) => `arn:aws:s3:::${b}/*`),
    },
    {
      Sid: "ListContentBuckets",
      Effect: "Allow",
      Action: ["s3:ListBucket"],
      Resource: CONTENT_BUCKETS.map((b) => `arn:aws:s3:::${b}`),
    },
    {
      Sid: "ReadAccessLogs",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:ListBucket"],
      Resource: [
        `arn:aws:s3:::${LOGS || "none"}`,
        `arn:aws:s3:::${LOGS || "none"}/*`,
      ],
    },
    {
      // The template library: READ ONLY, deliberately. The admin renders against
      // templates and must never be able to change one -- a compromised session
      // on any single site would otherwise reach every site in the installation
      // through a template they all share. Templates are written by
      // cli/templates.mjs with separate credentials.
      Sid: "ReadTemplateLibraryOnly",
      Effect: "Allow",
      Action: ["s3:GetObject"],
      Resource: `arn:aws:s3:::${PLATFORM || "none"}/templates/*`,
    },
    {
      // The account registry: read-write, because provisioning a site IS a
      // write here and nothing else. Scoped to accounts/ so the same credential
      // still cannot touch a template.
      Sid: "ReadWriteAccountRegistry",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      Resource: `arn:aws:s3:::${PLATFORM || "none"}/accounts/*`,
    },
    {
      // Listing needs the bucket ARN, not the object ARN, so it is conditioned
      // on the prefix instead -- otherwise "list the registry" would also mean
      // "enumerate every template version in the library".
      Sid: "ListPlatformPrefixes",
      Effect: "Allow",
      Action: ["s3:ListBucket"],
      Resource: `arn:aws:s3:::${PLATFORM || "none"}`,
      Condition: {
        StringLike: { "s3:prefix": ["templates/*", "accounts/*", "templates/", "accounts/"] },
      },
    },
    {
      Sid: "InvalidateOwnDistributions",
      Effect: "Allow",
      Action: ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"],
      Resource: [...new Set([DIST, config.hosted?.distributionId].filter(Boolean))]
        .map((d) => `arn:aws:cloudfront::${ACCOUNT}:distribution/${d}`),
    },
  ],
};
await aws(["iam", "put-role-policy", "--role-name", ROLE,
  "--policy-name", `${FN}-s3-cloudfront`,
  "--policy-document", JSON.stringify(inline)], { region: "us-east-1" });
log(`inline policy: ${CONTENT_BUCKETS.length} content bucket(s), templates read-only, accounts read-write`);

// ------------------------------------------------------------------ function
step(2, "Function");

// The HMAC key for admin sessions. Generated once and then read back from the
// live function config on every redeploy: regenerating it would silently sign
// everyone out, and writing it to config.json would put a secret in the repo.
const existingCfg = await aws(["lambda", "get-function-configuration", "--function-name", FN], { allowFail: true });
const SESSION_SECRET = existingCfg?.Environment?.Variables?.SESSION_SECRET || randomBytes(32).toString("hex");
log(existingCfg?.Environment?.Variables?.SESSION_SECRET
  ? "session secret: reusing the existing one (sessions survive this deploy)"
  : "session secret: generated a new one");

// The shared secret proving a request came through CloudFront. The distribution
// config is the source of truth: infra/wire-cloudfront.mjs puts it on the
// admin-lambda origin as a custom header, and it is read back here. It is
// therefore never in the repo, never in config.json, and never typed at a shell.
const distCfg = await aws(["cloudfront", "get-distribution-config", "--id", DIST],
  { region: "us-east-1", allowFail: true });
const ORIGIN_SECRET = (distCfg?.DistributionConfig?.Origins?.Items ?? [])
  .find((o) => o.Id === "admin-lambda")
  ?.CustomHeaders?.Items
  ?.find((h) => h.HeaderName.toLowerCase() === "x-qw-origin")?.HeaderValue ?? "";
log(ORIGIN_SECRET
  ? "origin secret: read from the distribution"
  : "origin secret: NOT SET on the distribution -- run infra/wire-cloudfront.mjs");

// Preserved across redeploys, never silently cleared. A deploy that dropped
// this would reopen the function URL to the whole internet without any error,
// which is precisely the kind of regression nobody notices.
const ORIGIN_ENFORCE = existingCfg?.Environment?.Variables?.ORIGIN_ENFORCE ?? "";
if (ORIGIN_ENFORCE === "1") log("origin enforcement: ON (preserved from the running function)");

// Enforcing with no secret to compare against rejects every request, including
// CloudFront's. Fail here rather than deploying a function that 403s the admin.
if (ORIGIN_ENFORCE === "1" && !ORIGIN_SECRET) {
  throw new Error(
    "ORIGIN_ENFORCE=1 but the distribution carries no x-qw-origin header.\n" +
    "  Run: node infra/wire-cloudfront.mjs   (then wait for Deployed)");
}

const env = {
  Variables: {
    AWS_BUCKET_REGION: BUCKET_REGION,
    // The library and the account registry. Without this the function cannot
    // render or authorize anything, which /api/health reports as unconfigured.
    PLATFORM_BUCKET: PLATFORM,
    // Which apex maps a Host header to a site id. Empty on a self-hosted
    // install, where the admin names the site explicitly instead.
    HOSTED_DOMAIN: config.hosted?.domain ?? "",
    // Where a newly provisioned tenant's bytes go. A site's OWN buckets come
    // from its registry record, not from here -- these are only the defaults
    // stamped into a record at creation time.
    TENANT_STAGING_BUCKET: config.hosted?.tenantStagingBucket ?? "",
    TENANT_LIVE_BUCKET: config.hosted?.tenantLiveBucket ?? "",
    TENANT_DISTRIBUTION_ID: config.hosted?.distributionId ?? "",
    TENANT_DISTRIBUTION_DOMAIN: config.hosted?.distributionDomain ?? "",
    TENANT_LOG_BUCKET: config.hosted?.tenantLogBucket ?? "",
    GOOGLE_CLIENT_ID: CLIENT_ID,
    SESSION_SECRET,
    ORIGIN_SECRET,
    ORIGIN_ENFORCE,
    NODE_OPTIONS: "--enable-source-maps",
  },
};

const existing = await aws(["lambda", "get-function", "--function-name", FN], { allowFail: true });
if (!existing) {
  await aws(["lambda", "create-function", "--function-name", FN,
    "--runtime", "nodejs22.x",
    "--role", roleArn,
    "--handler", "server.handler",
    "--zip-file", `fileb://${ZIP}`,
    "--timeout", "60",
    "--memory-size", "1024",       // sharp wants headroom; also buys faster CPU
    "--architectures", "x86_64",
    "--environment", JSON.stringify(env)]);
  log(`created ${FN}`);
} else {
  await aws(["lambda", "update-function-code", "--function-name", FN, "--zip-file", `fileb://${ZIP}`]);
  // Code and config updates cannot overlap; wait for the first to settle.
  await execFileAsync("aws", ["lambda", "wait", "function-updated", "--function-name", FN, "--region", REGION]);
  await aws(["lambda", "update-function-configuration", "--function-name", FN,
    "--timeout", "60", "--memory-size", "1024",
    "--environment", JSON.stringify(env)]);
  log(`updated ${FN}`);
}
await execFileAsync("aws", ["lambda", "wait", "function-updated", "--function-name", FN, "--region", REGION]);

if (!CLIENT_ID) {
  log("WARNING: GOOGLE_CLIENT_ID is empty. The admin will refuse to sign anyone in");
  log("         until you re-run with --client-id <your-google-oauth-client-id>.");
}

// ---------------------------------------------------------------- function url
step(3, "Function URL");
let fnUrl = (await aws(["lambda", "get-function-url-config", "--function-name", FN], { allowFail: true }))?.FunctionUrl;
if (!fnUrl) {
  // AuthType NONE because CloudFront fronts it and the app does its own
  // verification. IAM auth would require SigV4 from the browser, which a
  // static page cannot do without shipping credentials.
  const res = await aws(["lambda", "create-function-url-config", "--function-name", FN,
    "--auth-type", "NONE", "--invoke-mode", "BUFFERED"]);
  fnUrl = res.FunctionUrl;
  log(`created ${fnUrl}`);
} else {
  log(`exists ${fnUrl}`);
}

// A public function URL needs BOTH grants, which is not obvious and cost real
// time to find: lambda:InvokeFunctionUrl alone returns a bare 403 with an
// unhelpful "Forbidden" and no clue that a second statement is missing.
// FunctionUrlAuthType cannot be used as a condition on lambda:InvokeFunction --
// AddPermission rejects it -- so that grant is necessarily unconditioned.
//
// The exposure is invocation itself: anyone who learns the URL can wake the
// function and cost us a millisecond. They can do nothing else, because every
// /api route verifies a Google token, and ORIGIN_ENFORCE exists to require
// CloudFront's shared secret once wire-cloudfront.mjs has set it.
for (const [sid, action] of [
  ["FunctionURLAllowPublicFunctionUrl", "lambda:InvokeFunctionUrl"],
  ["FunctionURLAllowPublicInvokeFunction", "lambda:InvokeFunction"],
]) {
  const args = ["lambda", "add-permission", "--function-name", FN,
    "--statement-id", sid, "--action", action, "--principal", "*"];
  // Only InvokeFunctionUrl accepts the auth-type condition.
  if (action === "lambda:InvokeFunctionUrl") args.push("--function-url-auth-type", "NONE");
  // Already present is the normal case on a re-run, not a failure.
  await aws(args, { allowFail: true });
}
log("invoke permission in place (both InvokeFunctionUrl and InvokeFunction)");

config.deploy.functionName = FN;
config.deploy.functionUrl = fnUrl;
if (CLIENT_ID) config.deploy.googleClientId = CLIENT_ID;
await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");

console.log(`\nconfig.json updated`);
console.log(`next: node infra/wire-cloudfront.mjs   (route /api/* and /admin/* to the function)`);
