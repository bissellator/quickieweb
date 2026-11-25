#!/usr/bin/env node
// Turns on CloudFront access logging so the admin has something to report on.
//
//   node infra/enable-logging.mjs                 this installation's own site
//   node infra/enable-logging.mjs --hosted        the hosted platform: the shared
//                                                 distribution and every mirror
//   node infra/enable-logging.mjs [--hosted] --status
//
// Uses CloudFront standard logging v2 (the CloudWatch Logs delivery API) with
// JSON output to S3 -- the shape admin/lib/cfparser.mjs reads. v2 is worth the
// slightly fiddlier setup: it emits one JSON object per line instead of the
// legacy tab-separated W3C format, so a field added by AWS later cannot silently
// shift every column.
//
// Self-hosted: one distribution, its own log bucket, logs at the bucket root.
//
// Hosted: one log bucket (hosted.tenantLogBucket) for the whole platform, one
// folder per distribution -- cf/<distributionId>/ (shared/site.mjs
// logPrefixFor). The shared *.quickieweb.com distribution logs every tenant
// into one folder; the Stats tab keeps only the requests whose Host header is
// the site's own (logSourcesFor). A custom-domain mirror serves one site, so
// its folder belongs to that site whole.
//
// There is no tracking script anywhere on the public site. No cookies, no
// beacon, no third party. The CDN already writes down every request it serves;
// reading that costs nothing extra and follows people around the internet
// exactly zero times.
//
// Raw logs expire after 30 days by lifecycle rule. The aggregated daily reports
// the admin keeps are small.

import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";
import { logPrefixFor } from "../shared/site.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "config.json");
const config = await loadConfig(ROOT).catch(reportConfigError);

const HOSTED = process.argv.includes("--hosted");
const STATUS_ONLY = process.argv.includes("--status");
const REGION = config.deploy.region;
const RETAIN_DAYS = 30;

// The fields each log line carries, named rather than left to AWS's default.
// The default includes cs(Cookie), and the cookies quickieweb sets are
// credentials: qw_access is a signed pass to a members-only page and the
// commenter cookie is a session. Raw logs must never hold either. Named fields
// also add c-country (CloudFront's own geolocation) and timestamp(ms), both of
// which admin/lib/cfparser.mjs uses when present and the default leaves out.
const RECORD_FIELDS = [
  "date", "time", "timestamp(ms)", "x-edge-location", "sc-bytes", "c-ip", "c-country",
  "cs-method", "cs(Host)", "x-host-header", "cs-uri-stem", "cs-uri-query", "sc-status",
  "cs(Referer)", "cs(User-Agent)", "x-edge-result-type", "x-edge-response-result-type",
  "x-edge-detailed-result-type", "x-edge-request-id", "cs-protocol", "cs-protocol-version",
  "cs-bytes", "time-taken", "time-to-first-byte", "x-forwarded-for", "ssl-protocol",
  "ssl-cipher", "c-port", "sc-content-type", "sc-content-len", "sc-range-start", "sc-range-end",
];

if (HOSTED && !config.hosted?.distributionId) {
  console.error("FATAL: --hosted needs hosted.distributionId in config.json.");
  process.exit(1);
}

const LOG_BUCKET = HOSTED
  ? (config.hosted.tenantLogBucket || "quickieweb-sites-logs")
  : (config.deploy.logBucket ?? `${config.deploy.bucket}-logs`);

// { dist, prefix } -- where each distribution's logs go inside LOG_BUCKET.
const TARGETS = HOSTED
  ? [...new Set([config.hosted.distributionId,
      ...(config.hosted.mirrors ?? []).map((m) => m.distributionId),
      ...(config.hosted.mirrorDistributionIds ?? [])].filter(Boolean))]
    .map((dist) => ({ dist, prefix: logPrefixFor(dist) }))
  : [{ dist: config.deploy.distributionId, prefix: "" }];

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
console.log(`enable logging -> s3://${LOG_BUCKET}${STATUS_ONLY ? " (status only)" : ""}`);
for (const t of TARGETS) log(`${t.dist} -> /${t.prefix}`);

// ------------------------------------------------------------- 1. log bucket
step(1, "Log bucket");
// allowFail here is the existence check itself: a missing bucket is an answer.
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

// ---------------------------------------------------------- 2. delivery v2
step(2, "Standard logging v2 (JSON to S3)");
const sources = (await aws(["logs", "describe-delivery-sources"])).deliverySources ?? [];
const deliveries = (await aws(["logs", "describe-deliveries"])).deliveries ?? [];

for (const { dist, prefix } of TARGETS) {
  console.log(`\n  ${dist}`);
  const SRC = `qw-${dist}-src`;
  const DST = `qw-${dist}-dst`;
  const DIST_ARN = `arn:aws:cloudfront::${ACCOUNT}:distribution/${dist}`;
  // A destination ARN may carry a path; that is how each distribution gets a
  // folder of its own in a shared bucket.
  const DEST_ARN = `arn:aws:s3:::${LOG_BUCKET}${prefix ? `/${prefix.replace(/\/$/, "")}` : ""}`;

  if (STATUS_ONLY) {
    const src = sources.filter((s) => (s.resourceArns ?? []).includes(DIST_ARN));
    log(src.length ? `source: ${src.map((s) => s.name).join(", ")}` : "MISSING delivery source");
    const d = deliveries.filter((x) => src.some((s) => s.name === x.deliverySourceName));
    log(d.length ? `delivery -> ${d.map((x) => x.deliveryDestinationArn).join(", ")}` : "MISSING delivery");
    continue;
  }

  // A distribution may hold only one ACCESS_LOGS source. One CloudFront made
  // itself (console logging) would make put-delivery-source fail with a name we
  // never chose; say so instead of letting it look like a permissions problem.
  const foreign = sources.find((s) => (s.resourceArns ?? []).includes(DIST_ARN) && s.name !== SRC);
  if (foreign) {
    throw new Error(`${dist} already has delivery source "${foreign.name}". ` +
      "Remove it (or its delivery) first, or log this distribution where that one already writes.");
  }

  await aws(["logs", "put-delivery-source", "--name", SRC,
    "--resource-arn", DIST_ARN, "--log-type", "ACCESS_LOGS"]);
  log(`source ${SRC}`);

  const dst = await aws(["logs", "put-delivery-destination", "--name", DST,
    "--output-format", "json",
    "--delivery-destination-configuration",
    JSON.stringify({ destinationResourceArn: DEST_ARN })]);
  const dstArn = dst.deliveryDestination.arn;
  log(`destination ${DST} -> ${DEST_ARN} (json)`);

  const wired = deliveries.find((d) => d.deliverySourceName === SRC && d.deliveryDestinationArn === dstArn);
  if (wired) {
    await aws(["logs", "update-delivery-configuration", "--id", wired.id,
      "--record-fields", ...RECORD_FIELDS]);
    log(`delivery already wired; fields set (${RECORD_FIELDS.length}, no cookies)`);
  } else {
    await aws(["logs", "create-delivery",
      "--delivery-source-name", SRC,
      "--delivery-destination-arn", dstArn,
      "--record-fields", ...RECORD_FIELDS]);
    log(`delivery created (${RECORD_FIELDS.length} fields, no cookies)`);
  }
}

if (STATUS_ONLY) process.exit(0);

// Written to the raw file, not the loaded config: loadConfig fills in
// defaults, and writing those back would bake them into config.json.
const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
if (HOSTED) {
  raw.hosted.tenantLogBucket = LOG_BUCKET;
} else {
  raw.deploy.logBucket = LOG_BUCKET;
}
raw.deploy.logRetentionDays = RETAIN_DAYS;
await writeFile(CONFIG_PATH, JSON.stringify(raw, null, 2) + "\n");

console.log(`\nconfig.json updated`);
console.log(`Logs begin arriving in s3://${LOG_BUCKET}/ within ~10-15 minutes.`);
if (HOSTED) {
  console.log("Run infra/deploy-lambda.mjs next: it passes the bucket to the function and lets it read it.");
} else {
  console.log("The admin Stats tab processes them incrementally on demand.");
}
