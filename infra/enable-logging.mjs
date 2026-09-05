#!/usr/bin/env node
// Turns on CloudFront access logging so the admin has something to report on.
//
//   node infra/enable-logging.mjs
//   node infra/enable-logging.mjs --status
//
// Uses CloudFront standard logging v2 (the CloudWatch Logs delivery API) with
// JSON output to S3 -- the shape admin/lib/cfparser.mjs reads. v2 is worth the
// slightly fiddlier setup: it emits one JSON object per line instead of the
// legacy tab-separated W3C format, so a field added by AWS later cannot silently
// shift every column.
//
// There is no tracking script anywhere on the public site. No cookies, no
// beacon, no third party. The CDN already writes down every request it serves;
// reading that costs nothing extra and follows people around the internet
// exactly zero times.
//
// Raw logs expire after 30 days by lifecycle rule. The aggregated daily reports
// the admin keeps are small and hold no IP addresses.

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

const DIST = config.deploy.distributionId;
const REGION = config.deploy.region;
const STATUS_ONLY = process.argv.includes("--status");
const LOG_BUCKET = config.deploy.logBucket ?? `${config.deploy.bucket}-logs`;
const RETAIN_DAYS = 30;

async function aws(args, { region = "us-east-1", allowFail = false } = {}) {
  try {
    const { stdout } = await execFileAsync("aws", [...args, "--region", region, "--output", "json"],
      { maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`aws ${args.slice(0, 3).join(" ")} failed:\n  ${String(err.stderr || err.message).trim()}`);
  }
}

const step = (n, s) => console.log(`\n[${n}] ${s}`);
const log = (s) => console.log(`    ${s}`);

const ACCOUNT = (await aws(["sts", "get-caller-identity"])).Account;
console.log(`enable logging for ${DIST}${STATUS_ONLY ? " (status only)" : ""}`);

// ------------------------------------------------------------- 1. log bucket
step(1, "Log bucket");
const found = await aws(["s3api", "get-bucket-location", "--bucket", LOG_BUCKET],
  { region: REGION, allowFail: true });
if (found) {
  log(`exists ${LOG_BUCKET}`);
} else if (STATUS_ONLY) {
  log(`MISSING ${LOG_BUCKET}`);
} else {
  const create = ["s3api", "create-bucket", "--bucket", LOG_BUCKET];
  if (REGION !== "us-east-1") create.push("--create-bucket-configuration", `LocationConstraint=${REGION}`);
  await aws(create, { region: REGION });
  log(`created ${LOG_BUCKET}`);
}

if (!STATUS_ONLY) {
  await aws(["s3api", "put-public-access-block", "--bucket", LOG_BUCKET,
    "--public-access-block-configuration",
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"],
    { region: REGION });

  // Raw logs hold IP addresses. Keep them long enough to reprocess a bad run,
  // not long enough to become a liability.
  await aws(["s3api", "put-bucket-lifecycle-configuration", "--bucket", LOG_BUCKET,
    "--lifecycle-configuration", JSON.stringify({
      Rules: [{
        ID: "expire-raw-logs",
        Status: "Enabled",
        Filter: { Prefix: "" },
        Expiration: { Days: RETAIN_DAYS },
      }],
    })], { region: REGION });
  log(`private, raw logs expire after ${RETAIN_DAYS} days`);

  // The delivery service writes as a service principal, not as us.
  await aws(["s3api", "put-bucket-policy", "--bucket", LOG_BUCKET,
    "--policy", JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Sid: "AWSLogDeliveryWrite",
        Effect: "Allow",
        Principal: { Service: "delivery.logs.amazonaws.com" },
        Action: "s3:PutObject",
        Resource: `arn:aws:s3:::${LOG_BUCKET}/*`,
        Condition: { StringEquals: { "aws:SourceAccount": ACCOUNT } },
      }],
    })], { region: REGION });
  log("delivery.logs.amazonaws.com may write");
}

if (STATUS_ONLY) {
  step(2, "Delivery");
  const src = await aws(["logs", "describe-delivery-sources", "--max-results", "50"], { allowFail: true });
  const mine = (src?.deliverySources ?? []).filter((s) => (s.resourceArns ?? []).some((a) => a.includes(DIST)));
  log(mine.length ? `source exists: ${mine[0].name}` : "MISSING delivery source");
  process.exit(0);
}

// ---------------------------------------------------------- 2. delivery v2
step(2, "Standard logging v2 (JSON to S3)");
const SRC = `qw-${DIST}-src`;
const DST = `qw-${DIST}-dst`;
const DIST_ARN = `arn:aws:cloudfront::${ACCOUNT}:distribution/${DIST}`;

await aws(["logs", "put-delivery-source", "--name", SRC,
  "--resource-arn", DIST_ARN, "--log-type", "ACCESS_LOGS"]);
log(`source ${SRC}`);

const dst = await aws(["logs", "put-delivery-destination", "--name", DST,
  "--output-format", "json",
  "--delivery-destination-configuration",
  JSON.stringify({ destinationResourceArn: `arn:aws:s3:::${LOG_BUCKET}` })]);
const dstArn = dst.deliveryDestination.arn;
log(`destination ${DST} (json)`);

const existing = await aws(["logs", "describe-deliveries", "--max-results", "50"], { allowFail: true });
const already = (existing?.deliveries ?? []).some(
  (d) => d.deliverySourceName === SRC && d.deliveryDestinationArn === dstArn);

if (already) {
  log("delivery already wired");
} else {
  await aws(["logs", "create-delivery",
    "--delivery-source-name", SRC,
    "--delivery-destination-arn", dstArn]);
  log("delivery created");
}

config.deploy.logBucket = LOG_BUCKET;
config.deploy.logRetentionDays = RETAIN_DAYS;
await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");

console.log(`\nconfig.json updated`);
console.log(`Logs begin arriving in s3://${LOG_BUCKET}/ within ~10-15 minutes.`);
console.log(`The admin Stats tab processes them incrementally on demand.`);
