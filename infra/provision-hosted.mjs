#!/usr/bin/env node
// The hosted delivery stack: two shared tenant buckets and one distribution.
//
//   node infra/provision-hosted.mjs
//   node infra/provision-hosted.mjs --status    report only, change nothing
//
// Run infra/provision-hosted-dns.mjs first -- this needs the certificate.
//
// WHAT THIS BUILDS
//
//   quickieweb-sites-staging   private. NOT an origin on anything.
//   quickieweb-sites-live      OAC-readable by exactly one distribution.
//   a CloudFront Function       Host -> /sites/<id>/ , on viewer-request
//   one distribution            quickieweb.com + *.quickieweb.com
//
// TWO BUCKETS, NOT ONE WITH stage/ AND prod/ PREFIXES
//
// The live bucket has a policy granting reads to CloudFront. The staging bucket
// has no such policy and is not an origin. Merge them and that structural
// boundary becomes a Resource ARN -- get `/*` where you meant `/sites/*/prod/*`
// once, and every tenant's unpublished drafts are world-readable. Two buckets
// means leaking staging requires adding an origin AND writing a policy.
//
// Object prefixes are therefore an operational tool, not the security boundary:
// `aws s3 rm --recursive s3://bucket/sites/acme/` is how a tenant is deleted.
// Between tenants, isolation is enforced by keyFor() in shared/site.mjs and by
// the edge function -- which is why both are heavily tested.
//
// Every step checks first, so re-running is safe. Nothing here deletes anything.

import { readFile, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "config.json");
const config = await loadConfig(ROOT).catch(reportConfigError);

const STATUS_ONLY = process.argv.includes("--status");

const hosted = config.hosted ?? {};
const DOMAIN = hosted.domain;
const CERT = hosted.certificateArn;
const ZONE_ID = hosted.hostedZoneId;
const REGION = config.deploy.region;
const FN_URL = config.deploy.functionUrl ?? "";

const STAGING = hosted.tenantStagingBucket || `${DOMAIN.split(".")[0]}-sites-staging`;
const LIVE = hosted.tenantLiveBucket || `${DOMAIN.split(".")[0]}-sites-live`;
const CF_FUNCTION = `${DOMAIN.split(".")[0]}-tenant-router`;
const OAC_NAME = `${DOMAIN.split(".")[0]}-sites-oac`;

for (const [k, v] of Object.entries({ "hosted.domain": DOMAIN, "hosted.certificateArn": CERT, "hosted.hostedZoneId": ZONE_ID })) {
  if (!v || String(v).includes("REPLACE-ME")) {
    console.error(`FATAL: ${k} is not set. Run: node infra/provision-hosted-dns.mjs`);
    process.exit(1);
  }
}

async function aws(args, { region = REGION, allowFail = false } = {}) {
  try {
    const { stdout } = await execFileAsync("aws", [...args, "--region", region, "--output", "json"],
      { maxBuffer: 32e6 });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`aws ${args.slice(0, 2).join(" ")} failed:\n  ${String(err.stderr || err.message).trim()}`);
  }
}

const log = (s) => console.log(`    ${s}`);
const step = (n, s) => console.log(`\n[${n}] ${s}`);

const ACCOUNT = (await aws(["sts", "get-caller-identity"])).Account;
console.log(`hosted stack for ${DOMAIN}${STATUS_ONLY ? "  (status only)" : ""}  account=${ACCOUNT}`);

// ----------------------------------------------------------------- buckets
async function ensureBucket(name, { versioned }) {
  const exists = (await aws(["s3api", "head-bucket", "--bucket", name], { allowFail: true })) !== null
    || (await aws(["s3api", "list-objects-v2", "--bucket", name, "--max-keys", "1"], { allowFail: true })) !== null;

  if (exists) { log(`${name}: exists`); }
  else if (STATUS_ONLY) { log(`${name}: MISSING`); return false; }
  else {
    const create = ["s3api", "create-bucket", "--bucket", name];
    if (REGION !== "us-east-1") create.push("--create-bucket-configuration", `LocationConstraint=${REGION}`);
    await aws(create);
    log(`${name}: created`);
  }
  if (STATUS_ONLY) return true;

  // All four, always. This is what stops anyone from ever attaching a public
  // policy or a public ACL to a bucket full of customer sites -- including us,
  // by accident, at 2am.
  await aws(["s3api", "put-public-access-block", "--bucket", name,
    "--public-access-block-configuration",
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"]);

  // ACLs off entirely. With OAC there is no reason for an object ACL to exist,
  // and "the object was public because of its ACL" is a whole class of incident
  // that simply cannot happen once ownership is enforced.
  await aws(["s3api", "put-bucket-ownership-controls", "--bucket", name,
    "--ownership-controls", JSON.stringify({ Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] })]);

  await aws(["s3api", "put-bucket-encryption", "--bucket", name,
    "--server-side-encryption-configuration",
    JSON.stringify({ Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] })]);

  if (versioned) {
    await aws(["s3api", "put-bucket-versioning", "--bucket", name,
      "--versioning-configuration", "Status=Enabled"]);
  }
  log(`${name}: BPA on, ACLs disabled, SSE-S3${versioned ? ", versioned" : ""}`);
  return true;
}

step(1, "Tenant buckets");
// Versioning on live only: it is the copy a bad publish can damage, and a
// draft's history is already in the editor.
await ensureBucket(STAGING, { versioned: false });
await ensureBucket(LIVE, { versioned: true });

// Static website hosting is never enabled on either. A website endpoint is
// public by definition and does not support OAC, so turning it on would be the
// exact end-run this whole arrangement exists to prevent.
if (!STATUS_ONLY) {
  for (const b of [STAGING, LIVE]) {
    const site = await aws(["s3api", "get-bucket-website", "--bucket", b], { allowFail: true });
    if (site) {
      console.error(`\nFATAL: ${b} has static website hosting enabled. That endpoint is public and\n` +
        "  bypasses CloudFront entirely. Remove it: aws s3api delete-bucket-website --bucket " + b);
      process.exit(1);
    }
  }
  log("neither bucket serves a public website endpoint");
}

// Record the buckets as soon as they exist, not at the end of a run that may
// stop earlier for a legitimate reason. Config should describe what is actually
// provisioned; a bucket that exists but is unrecorded is one nobody cleans up.
if (!STATUS_ONLY) {
  config.hosted.tenantStagingBucket = STAGING;
  config.hosted.tenantLiveBucket = LIVE;
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  log("recorded in config.json");
}

// ---------------------------------------------------------------- function
step(2, "Edge function");
const fnSource = (await readFile(path.join(ROOT, "infra", "edge", "tenant-router.js"), "utf8"))
  .replace("__APEX__", DOMAIN);
if (fnSource.includes("__APEX__") || !fnSource.includes(DOMAIN)) {
  throw new Error("tenant-router.js did not get its apex substituted -- refusing to publish it");
}

let fnEtag = null;
const existingFn = await aws(["cloudfront", "describe-function", "--name", CF_FUNCTION], { region: "us-east-1", allowFail: true });

if (STATUS_ONLY) {
  log(existingFn ? "exists" : "MISSING");
} else {
  const tmp = path.join(ROOT, ".tenant-router.js");
  await writeFile(tmp, fnSource);
  try {
    if (!existingFn) {
      const res = await aws(["cloudfront", "create-function", "--name", CF_FUNCTION,
        "--function-config", JSON.stringify({ Comment: `${DOMAIN} host -> tenant prefix`, Runtime: "cloudfront-js-2.0" }),
        "--function-code", `fileb://${tmp}`], { region: "us-east-1" });
      fnEtag = res.ETag;
      log("created");
    } else {
      const res = await aws(["cloudfront", "update-function", "--name", CF_FUNCTION,
        "--if-match", existingFn.ETag,
        "--function-config", JSON.stringify({ Comment: `${DOMAIN} host -> tenant prefix`, Runtime: "cloudfront-js-2.0" }),
        "--function-code", `fileb://${tmp}`], { region: "us-east-1" });
      fnEtag = res.ETag;
      log("updated");
    }
  } finally {
    await rm(tmp, { force: true });
  }

  const published = await aws(["cloudfront", "publish-function", "--name", CF_FUNCTION,
    "--if-match", fnEtag], { region: "us-east-1" });
  log(`published (${published.FunctionSummary.FunctionMetadata.Stage})`);
}

const fnArn = (await aws(["cloudfront", "describe-function", "--name", CF_FUNCTION],
  { region: "us-east-1", allowFail: true }))?.FunctionSummary?.FunctionMetadata?.FunctionARN;

// --------------------------------------------------------------------- OAC
step(3, "Origin access control");
const oacs = await aws(["cloudfront", "list-origin-access-controls"], { region: "us-east-1" });
let oacId = (oacs.OriginAccessControlList?.Items ?? []).find((o) => o.Name === OAC_NAME)?.Id;
if (oacId) {
  log(`exists: ${oacId}`);
} else if (STATUS_ONLY) {
  log("MISSING");
} else {
  const res = await aws(["cloudfront", "create-origin-access-control",
    "--origin-access-control-config", JSON.stringify({
      Name: OAC_NAME,
      Description: `OAC for ${LIVE}`,
      SigningProtocol: "sigv4",
      SigningBehavior: "always",
      OriginAccessControlOriginType: "s3",
    })], { region: "us-east-1" });
  oacId = res.OriginAccessControl.Id;
  log(`created: ${oacId}`);
}

// ------------------------------------------------------------ distribution
step(4, "Distribution");
const dists = await aws(["cloudfront", "list-distributions"], { region: "us-east-1" });
let dist = (dists.DistributionList?.Items ?? [])
  .find((d) => (d.Aliases?.Items ?? []).includes(DOMAIN));

if (dist) {
  log(`exists: ${dist.Id} (${dist.Status})`);
} else if (STATUS_ONLY) {
  log("MISSING");
} else {
  if (!FN_URL || FN_URL.includes("REPLACE-ME")) {
    // Not a failure. The buckets, the edge function and the OAC are all built
    // and durable; the distribution simply cannot be created before the origin
    // it routes /api/* at exists, and the Lambda in turn needs the buckets this
    // run just made. Two passes, in this order, on purpose.
    console.log("\n  Buckets, edge function and OAC are ready and re-runnable.");
    console.log("  The distribution needs the admin origin to exist first:\n");
    console.log("    node infra/deploy-lambda.mjs --client-id <id>.apps.googleusercontent.com");
    console.log("    node infra/provision-hosted.mjs      # re-run: creates the distribution\n");
    process.exit(0);
  }
  const lambdaHost = new URL(FN_URL).hostname;
  const s3Origin = `${LIVE}.s3.${REGION}.amazonaws.com`;

  const cfg = {
    CallerReference: `${DOMAIN}-hosted-${Date.now()}`,
    Comment: `${DOMAIN} hosted platform`,
    Enabled: true,
    // Aliases must include the apex explicitly: a wildcard certificate and a
    // wildcard alias both cover *.domain and neither covers domain itself.
    Aliases: { Quantity: 2, Items: [DOMAIN, `*.${DOMAIN}`] },
    ViewerCertificate: {
      ACMCertificateArn: CERT,
      SSLSupportMethod: "sni-only",
      MinimumProtocolVersion: "TLSv1.2_2021",
    },
    HttpVersion: "http2and3",
    IsIPV6Enabled: true,
    PriceClass: "PriceClass_100",
    Origins: {
      Quantity: 2,
      Items: [
        {
          Id: "sites",
          DomainName: s3Origin,
          OriginAccessControlId: oacId,
          S3OriginConfig: { OriginAccessIdentity: "" },
          CustomHeaders: { Quantity: 0 },
        },
        {
          Id: "admin-api",
          DomainName: lambdaHost,
          CustomOriginConfig: {
            HTTPPort: 80, HTTPSPort: 443,
            OriginProtocolPolicy: "https-only",
            OriginSslProtocols: { Quantity: 1, Items: ["TLSv1.2"] },
            OriginReadTimeout: 30, OriginKeepaliveTimeout: 5,
          },
          CustomHeaders: { Quantity: 0 },
        },
      ],
    },
    DefaultCacheBehavior: {
      TargetOriginId: "sites",
      ViewerProtocolPolicy: "redirect-to-https",
      AllowedMethods: { Quantity: 2, Items: ["GET", "HEAD"], CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] } },
      Compress: true,
      // CachingOptimized. The tenant prefix is in the rewritten URI, so the
      // cache key is naturally per-tenant and Host does not need to be in it.
      CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
      FunctionAssociations: {
        Quantity: 1,
        Items: [{ EventType: "viewer-request", FunctionARN: fnArn }],
      },
    },
    CacheBehaviors: {
      Quantity: 1,
      Items: [{
        PathPattern: "/api/*",
        TargetOriginId: "admin-api",
        ViewerProtocolPolicy: "https-only",
        AllowedMethods: {
          Quantity: 7, Items: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
          CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
        },
        Compress: true,
        // CachingDisabled + AllViewerExceptHostHeader: the admin API must never
        // be cached, and the Lambda function URL rejects a forwarded Host that
        // is not its own.
        CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
        OriginRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
        // No edge function here: /api/* is not tenant-prefixed. The site a
        // request is for travels as ?site= or X-QW-Site and is authorized
        // against membership, not derived from a path.
      }],
    },
    CustomErrorResponses: {
      Quantity: 2,
      Items: [
        // S3 answers a missing key with 403, not 404, because the bucket policy
        // grants GetObject but not ListBucket. Both map to the same page.
        //
        // KNOWN LIMITATION: this page is fetched from the origin WITHOUT
        // re-running the viewer-request function, so it resolves at the bucket
        // root and is the same for every tenant. Per-tenant 404s would need
        // Lambda@Edge on origin-response. See README.
        { ErrorCode: 403, ResponsePagePath: "/404.html", ResponseCode: "404", ErrorCachingMinTTL: 60 },
        { ErrorCode: 404, ResponsePagePath: "/404.html", ResponseCode: "404", ErrorCachingMinTTL: 60 },
      ],
    },
  };

  const res = await aws(["cloudfront", "create-distribution", "--distribution-config", JSON.stringify(cfg)],
    { region: "us-east-1" });
  dist = res.Distribution;
  log(`created: ${dist.Id} -- deploying, usually 5-10 minutes`);
}

// ------------------------------------------------------------- bucket policy
step(5, "Bucket policies");
if (!STATUS_ONLY && dist) {
  const fill = (tpl) => tpl
    .replaceAll("__ACCOUNT__", ACCOUNT)
    .replaceAll("__DISTRIBUTION__", dist.Id);

  for (const [bucket, file] of [[LIVE, "tenant-live-bucket-policy.json"], [STAGING, "tenant-staging-bucket-policy.json"]]) {
    const raw = await readFile(path.join(ROOT, "infra", "iam", file), "utf8");
    const doc = JSON.parse(fill(raw.replaceAll("__BUCKET__", bucket)));
    // The "//" keys are documentation for the repo; IAM rejects them.
    delete doc["//"];
    for (const st of doc.Statement) delete st["//"];
    await aws(["s3api", "put-bucket-policy", "--bucket", bucket, "--policy", JSON.stringify(doc)]);
    log(`${bucket}: ${doc.Statement.length} statements applied`);
  }
  log(`live readable only by distribution ${dist.Id}; staging by nothing outside the account`);
}

// -------------------------------------------------------------- platform 404
step(6, "Platform 404");
if (!STATUS_ONLY) {
  const tmp = path.join(ROOT, ".platform-404.html");
  await writeFile(tmp, `<!doctype html>
<meta charset="utf-8">
<title>No site here</title>
<meta name="robots" content="noindex">
<style>body{font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;margin:15vh auto;max-width:28rem;padding:0 1.5rem;color:#14161a;background:#f7f6f3}
@media(prefers-color-scheme:dark){body{color:#e9e6e0;background:#14151a}}a{color:inherit}</style>
<h1>No site here.</h1>
<p>Nothing is published at this address.</p>
<p><a href="https://${DOMAIN}/">${DOMAIN}</a></p>
`);
  try {
    await execFileAsync("aws", ["s3", "cp", tmp, `s3://${LIVE}/404.html`,
      "--region", REGION, "--content-type", "text/html; charset=utf-8",
      "--cache-control", "public,max-age=300"]);
  } finally {
    await rm(tmp, { force: true });
  }
  log(`s3://${LIVE}/404.html (shared by every tenant -- see the limitation note above)`);
}

// --------------------------------------------------------------------- dns
step(7, "DNS aliases");
if (!STATUS_ONLY && dist?.DomainName) {
  const CF_ZONE = "Z2FDTNDATAQYW2"; // fixed CloudFront hosted zone id, all regions
  const changes = [];
  for (const name of [DOMAIN, `*.${DOMAIN}`]) {
    for (const type of ["A", "AAAA"]) {
      changes.push({
        Action: "UPSERT",
        ResourceRecordSet: {
          Name: name, Type: type,
          AliasTarget: { HostedZoneId: CF_ZONE, DNSName: dist.DomainName, EvaluateTargetHealth: false },
        },
      });
    }
  }
  await aws(["route53", "change-resource-record-sets", "--hosted-zone-id", ZONE_ID,
    "--change-batch", JSON.stringify({ Comment: "hosted platform aliases", Changes: changes })],
    { region: "us-east-1" });
  log(`${DOMAIN} and *.${DOMAIN} -> ${dist.DomainName}`);
}

// ------------------------------------------------------------------ config
if (!STATUS_ONLY && dist) {
  config.hosted.tenantStagingBucket = STAGING;
  config.hosted.tenantLiveBucket = LIVE;
  config.hosted.distributionId = dist.Id;
  config.hosted.distributionDomain = dist.DomainName;
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`\nwrote hosted.* into config.json`);
}

console.log(`\nstaging   s3://${STAGING}   (private, not an origin)`);
console.log(`live      s3://${LIVE}   (OAC, one distribution)`);
console.log(`dist      ${dist?.Id ?? "-"}  ${dist?.DomainName ?? ""}`);
console.log(`\nNext: node infra/deploy-lambda.mjs   (picks up the tenant buckets and TENANT_* env)`);
