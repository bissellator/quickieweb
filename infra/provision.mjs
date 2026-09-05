#!/usr/bin/env node
// Idempotent provisioning for the delivery stack named in config.json.
// Check-then-create throughout, so re-running is always safe.
//
//   node infra/provision.mjs            create/verify everything
//   node infra/provision.mjs --status   report only, change nothing
//
// Creates, in order:
//   1. live bucket    (private, OAC-only, serves the published site)
//   2. staging bucket (private, never public, holds drafts + admins.json)
//   3. ACM cert in us-east-1, DNS-validated through the Route 53 zone
//   4. CloudFront distribution: /api/* + /admin/* -> Lambda, /* -> live bucket
//   5. A/AAAA alias records at apex and www
//
// Every step checks for an existing resource first, so re-running is safe.
// Nothing here is destructive: it never deletes a bucket, cert, or distribution.

import { writeFile } from "node:fs/promises";
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

const DOMAIN = config.site.domain;
const WWW = `www.${DOMAIN}`;
const REGION = config.deploy.region;
const LIVE_BUCKET = config.deploy.bucket;
const STAGING_BUCKET = config.deploy.stagingBucket ?? `${LIVE_BUCKET}-staging`;

// ----------------------------------------------------------------- aws helper
async function aws(args, { region = REGION, allowFail = false } = {}) {
  const full = [...args, "--region", region, "--output", "json"];
  try {
    const { stdout } = await execFileAsync("aws", full, { maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch (err) {
    if (allowFail) return null;
    const msg = String(err.stderr || err.message).trim();
    throw new Error(`aws ${args.slice(0, 3).join(" ")} failed:\n  ${msg}`);
  }
}

const log = (s) => console.log(s);
const step = (n, s) => console.log(`\n[${n}] ${s}`);

let ACCOUNT;

// --------------------------------------------------------------------- zone
async function hostedZoneId() {
  const zones = await aws(["route53", "list-hosted-zones"], { region: "us-east-1" });
  const z = zones.HostedZones.find((h) => h.Name === `${DOMAIN}.`);
  if (!z) throw new Error(`No Route 53 hosted zone for ${DOMAIN}. Is the domain registered?`);
  return z.Id.split("/").pop();
}

// ------------------------------------------------------------------ buckets
async function ensureBucket(name, purpose) {
  const exists = await aws(["s3api", "head-bucket", "--bucket", name], { allowFail: true });
  // head-bucket returns empty on success; null means it failed (missing or denied)
  const found = exists !== null || (await aws(["s3api", "get-bucket-location", "--bucket", name], { allowFail: true })) !== null;

  if (found) {
    log(`    exists: ${name} (${purpose})`);
  } else {
    if (STATUS_ONLY) { log(`    MISSING: ${name} (${purpose})`); return; }
    const createArgs = ["s3api", "create-bucket", "--bucket", name];
    if (REGION !== "us-east-1") {
      createArgs.push("--create-bucket-configuration", `LocationConstraint=${REGION}`);
    }
    await aws(createArgs);
    log(`    created: ${name} (${purpose})`);
  }
  if (STATUS_ONLY) return;

  // Both buckets are fully private. The live one is reachable only through
  // CloudFront OAC; the staging one is reachable only through the Lambda role.
  await aws(["s3api", "put-public-access-block", "--bucket", name,
    "--public-access-block-configuration",
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"]);

  await aws(["s3api", "put-bucket-encryption", "--bucket", name,
    "--server-side-encryption-configuration",
    JSON.stringify({ Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] })]);

  await aws(["s3api", "put-bucket-versioning", "--bucket", name,
    "--versioning-configuration", "Status=Enabled"]);

  log(`    secured: private + AES256 + versioning`);
}

// --------------------------------------------------------------------- cert
async function ensureCertificate(zoneId) {
  // CloudFront only accepts certs from us-east-1, regardless of bucket region.
  const list = await aws(["acm", "list-certificates", "--certificate-statuses",
    "PENDING_VALIDATION", "ISSUED"], { region: "us-east-1" });

  let arn = list.CertificateSummaryList.find((c) => c.DomainName === DOMAIN)?.CertificateArn;

  if (!arn) {
    if (STATUS_ONLY) { log("    MISSING: certificate"); return null; }
    const res = await aws(["acm", "request-certificate",
      "--domain-name", DOMAIN,
      "--subject-alternative-names", WWW,
      "--validation-method", "DNS",
      "--key-algorithm", "RSA_2048"], { region: "us-east-1" });
    arn = res.CertificateArn;
    log(`    requested: ${arn.split("/").pop()}`);
    // ACM needs a moment before the validation CNAMEs appear.
    await new Promise((r) => setTimeout(r, 8000));
  } else {
    log(`    exists: ${arn.split("/").pop()}`);
  }

  const detail = await aws(["acm", "describe-certificate", "--certificate-arn", arn], { region: "us-east-1" });
  const status = detail.Certificate.Status;
  log(`    status: ${status}`);
  if (status === "ISSUED" || STATUS_ONLY) return arn;

  // Write the DNS validation records into our own zone so ACM can verify.
  const opts = detail.Certificate.DomainValidationOptions ?? [];
  const changes = [];
  const seen = new Set();
  for (const o of opts) {
    const rr = o.ResourceRecord;
    if (!rr || seen.has(rr.Name)) continue;
    seen.add(rr.Name);
    changes.push({
      Action: "UPSERT",
      ResourceRecordSet: { Name: rr.Name, Type: rr.Type, TTL: 300, ResourceRecords: [{ Value: rr.Value }] },
    });
  }
  if (!changes.length) {
    log("    no validation records available yet -- re-run in a minute");
    return arn;
  }
  await aws(["route53", "change-resource-record-sets", "--hosted-zone-id", zoneId,
    "--change-batch", JSON.stringify({ Comment: "ACM DNS validation", Changes: changes })],
    { region: "us-east-1" });
  log(`    wrote ${changes.length} validation CNAME(s) into the zone`);
  log("    ACM will validate within a few minutes");
  return arn;
}

// --------------------------------------------------------------- cloudfront
async function ensureOac() {
  const list = await aws(["cloudfront", "list-origin-access-controls"], { region: "us-east-1" });
  const items = list.OriginAccessControlList?.Items ?? [];
  const found = items.find((o) => o.Name === `${LIVE_BUCKET}-oac`);
  if (found) { log(`    exists: OAC ${found.Id}`); return found.Id; }
  if (STATUS_ONLY) { log("    MISSING: OAC"); return null; }

  const res = await aws(["cloudfront", "create-origin-access-control",
    "--origin-access-control-config", JSON.stringify({
      Name: `${LIVE_BUCKET}-oac`,
      Description: `OAC for the ${LIVE_BUCKET} live bucket`,
      SigningProtocol: "sigv4",
      SigningBehavior: "always",
      OriginAccessControlOriginType: "s3",
    })], { region: "us-east-1" });
  log(`    created: OAC ${res.OriginAccessControl.Id}`);
  return res.OriginAccessControl.Id;
}

async function findDistribution() {
  const list = await aws(["cloudfront", "list-distributions"], { region: "us-east-1" });
  const items = list.DistributionList?.Items ?? [];
  return items.find((d) => (d.Aliases?.Items ?? []).includes(DOMAIN)) ?? null;
}

async function ensureDistribution(certArn, oacId) {
  const existing = await findDistribution();
  if (existing) {
    log(`    exists: ${existing.Id} (${existing.DomainName}) status=${existing.Status}`);
    return existing;
  }
  if (STATUS_ONLY) { log("    MISSING: distribution"); return null; }
  if (!certArn || !oacId) { log("    skipped: needs an issued cert and an OAC"); return null; }

  const cert = await aws(["acm", "describe-certificate", "--certificate-arn", certArn], { region: "us-east-1" });
  if (cert.Certificate.Status !== "ISSUED") {
    log(`    skipped: certificate is ${cert.Certificate.Status}, not ISSUED yet. Re-run when it validates.`);
    return null;
  }

  const originId = "s3-live";
  const cfg = {
    CallerReference: `${DOMAIN}-${Date.now()}`,
    Comment: `${DOMAIN} static site`,
    Enabled: true,
    Aliases: { Quantity: 2, Items: [DOMAIN, WWW] },
    DefaultRootObject: "index.html",
    Origins: {
      Quantity: 1,
      Items: [{
        Id: originId,
        DomainName: `${LIVE_BUCKET}.s3.${REGION}.amazonaws.com`,
        OriginAccessControlId: oacId,
        S3OriginConfig: { OriginAccessIdentity: "" },
        OriginShield: { Enabled: false },
        CustomHeaders: { Quantity: 0 },
      }],
    },
    DefaultCacheBehavior: {
      TargetOriginId: originId,
      ViewerProtocolPolicy: "redirect-to-https",
      AllowedMethods: { Quantity: 2, Items: ["GET", "HEAD"], CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] } },
      Compress: true,
      // CachingOptimized -- AWS managed policy, stable id
      CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
    },
    CustomErrorResponses: {
      Quantity: 1,
      Items: [{ ErrorCode: 404, ResponsePagePath: "/index.html", ResponseCode: "404", ErrorCachingMinTTL: 60 }],
    },
    ViewerCertificate: {
      ACMCertificateArn: certArn,
      SSLSupportMethod: "sni-only",
      MinimumProtocolVersion: "TLSv1.2_2021",
    },
    PriceClass: "PriceClass_100",
    HttpVersion: "http2and3",
    IsIPV6Enabled: true,
  };

  const res = await aws(["cloudfront", "create-distribution", "--distribution-config", JSON.stringify(cfg)],
    { region: "us-east-1" });
  const d = res.Distribution;
  log(`    created: ${d.Id} (${d.DomainName})`);
  return { Id: d.Id, DomainName: d.DomainName, Status: d.Status, ARN: d.ARN };
}

// Only CloudFront may read the live bucket, and only this distribution.
async function ensureBucketPolicy(distributionId) {
  if (STATUS_ONLY || !distributionId) return;
  const policy = {
    Version: "2008-10-17",
    Statement: [{
      Sid: "AllowCloudFrontServicePrincipalReadOnly",
      Effect: "Allow",
      Principal: { Service: "cloudfront.amazonaws.com" },
      Action: "s3:GetObject",
      Resource: `arn:aws:s3:::${LIVE_BUCKET}/*`,
      Condition: { StringEquals: { "AWS:SourceArn": `arn:aws:cloudfront::${ACCOUNT}:distribution/${distributionId}` } },
    }],
  };
  await aws(["s3api", "put-bucket-policy", "--bucket", LIVE_BUCKET, "--policy", JSON.stringify(policy)]);
  log(`    live bucket readable only by distribution ${distributionId}`);
}

// --------------------------------------------------------------------- dns
async function ensureAliases(zoneId, cfDomain) {
  if (STATUS_ONLY || !cfDomain) return;
  const CF_ZONE = "Z2FDTNDATAQYW2"; // fixed CloudFront hosted zone id, all regions
  const changes = [];
  for (const name of [DOMAIN, WWW]) {
    for (const type of ["A", "AAAA"]) {
      changes.push({
        Action: "UPSERT",
        ResourceRecordSet: {
          Name: name, Type: type,
          AliasTarget: { HostedZoneId: CF_ZONE, DNSName: cfDomain, EvaluateTargetHealth: false },
        },
      });
    }
  }
  await aws(["route53", "change-resource-record-sets", "--hosted-zone-id", zoneId,
    "--change-batch", JSON.stringify({ Comment: "CloudFront aliases", Changes: changes })],
    { region: "us-east-1" });
  log(`    4 alias records -> ${cfDomain} (alias queries are not billed)`);
}

// -------------------------------------------------------------------- main
ACCOUNT = (await aws(["sts", "get-caller-identity"], { region: "us-east-1" })).Account;
log(`provision ${DOMAIN}${STATUS_ONLY ? " (status only)" : ""}  account=${ACCOUNT} region=${REGION}`);

step(1, "Hosted zone");
const zoneId = await hostedZoneId();
log(`    ${zoneId}`);

step(2, "Buckets");
await ensureBucket(LIVE_BUCKET, "live");
await ensureBucket(STAGING_BUCKET, "staging + admin config");

step(3, "Certificate (us-east-1)");
const certArn = await ensureCertificate(zoneId);

step(4, "CloudFront");
const oacId = await ensureOac();
const dist = await ensureDistribution(certArn, oacId);
if (dist) await ensureBucketPolicy(dist.Id);

step(5, "DNS aliases");
await ensureAliases(zoneId, dist?.DomainName);

if (!STATUS_ONLY) {
  config.deploy.stagingBucket = STAGING_BUCKET;
  if (certArn) config.deploy.certificateArn = certArn;
  if (dist) {
    config.deploy.distributionId = dist.Id;
    config.deploy.distributionDomain = dist.DomainName;
  }
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  log(`\nconfig.json updated`);
}

log(`\n${dist ? `live at https://${DOMAIN} once the distribution deploys (~5-10 min)` : "re-run once the certificate is ISSUED to create the distribution"}`);
