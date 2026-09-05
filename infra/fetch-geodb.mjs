#!/usr/bin/env node
// Puts an IP-to-city database in the staging bucket, where the stats processor
// looks for it.
//
//   node infra/fetch-geodb.mjs              download this month's DB-IP City Lite and upload
//   node infra/fetch-geodb.mjs --file x.mmdb.gz    upload a file you already have
//   node infra/fetch-geodb.mjs --check      report what is currently in the bucket
//
// Why DB-IP rather than MaxMind: GeoLite2 needs an account and a license key,
// which makes "run this one command" impossible. DB-IP publishes City Lite in
// the same MMDB container format under CC BY 4.0 with no account at all. If you
// would rather ship GeoLite2, download it yourself and pass --file; the reader
// in admin/lib/mmdb.mjs does not care which one it is handed.
//
// CC BY 4.0 requires attribution. The Stats tab credits db-ip.com whenever the
// loaded database reports itself as a DB-IP build -- do not remove that.
//
// The file is ~60MB gzipped, ~127MB unpacked. It stays in object storage rather
// than the Lambda package because it changes monthly, the code does not, and a
// 127MB deployment artifact for a management plane that is supposed to scale to
// zero would be an embarrassing thing to have to explain in an article.

import { readFile, writeFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import os from "node:os";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";

import { MMDBReader } from "../admin/lib/mmdb.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadConfig(ROOT).catch(reportConfigError);

const STAGING = config.deploy.stagingBucket;
const REGION = config.deploy.region;
const KEY = "_internal/geo/dbip-city-lite.mmdb.gz";

if (!STAGING || STAGING.includes("REPLACE-ME")) {
  console.error("FATAL: no staging bucket in config.json. Run: node infra/provision.mjs");
  process.exit(1);
}

const argv = process.argv.slice(2);
const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);

if (argv.includes("--check")) {
  const { stdout } = await execFileAsync("aws", [
    "s3api", "head-object", "--bucket", STAGING, "--key", KEY, "--region", REGION,
  ]).catch((e) => {
    console.error(`No geo database in s3://${STAGING}/${KEY}`);
    console.error("Stats will fall back to CloudFront country codes. Run without --check to install one.");
    process.exit(1);
  });
  const meta = JSON.parse(stdout);
  console.log(`s3://${STAGING}/${KEY}`);
  console.log(`  ${(meta.ContentLength / 1e6).toFixed(1)}MB, modified ${meta.LastModified}`);
  process.exit(0);
}

// DB-IP publishes a new build on the first of each month and keeps a short
// tail of previous ones. The current month can 404 early in the day it rolls,
// so walk back rather than fail.
async function download() {
  const now = new Date();
  for (let back = 0; back < 4; back++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const tag = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const url = `https://download.db-ip.com/free/dbip-city-lite-${tag}.mmdb.gz`;
    const out = path.join(os.tmpdir(), `dbip-city-lite-${tag}.mmdb.gz`);
    process.stdout.write(`  trying ${tag} ... `);
    try {
      await execFileAsync("curl", ["-sSfL", "--max-time", "600", url, "-o", out], { maxBuffer: 8e6 });
    } catch {
      console.log("not published");
      continue;
    }
    const { size } = await stat(out);
    console.log(`${(size / 1e6).toFixed(1)}MB`);
    return out;
  }
  throw new Error("No DB-IP City Lite build found in the last four months. Pass --file instead.");
}

const local = arg("--file") ?? (await download());

// Verify before uploading. A truncated download is a 60MB file that looks fine
// in S3 and returns nothing for every address, which is the sort of failure you
// discover three weeks later while wondering why the map is empty.
console.log("verifying...");
const gz = await readFile(local);
const raw = gz[0] === 0x1f && gz[1] === 0x8b ? gunzipSync(gz) : gz;
const reader = new MMDBReader(raw);
const probe = reader.get("8.8.8.8");
if (!probe?.country?.iso_code) {
  throw new Error("Database loaded but 8.8.8.8 did not resolve. Refusing to upload a broken file.");
}
console.log(`  ${reader.metadata.database_type}, built ${
  new Date(reader.metadata.build_epoch * 1000).toISOString().slice(0, 10)}, ${
  reader.metadata.node_count.toLocaleString()} nodes`);
console.log(`  8.8.8.8 -> ${probe.city?.names?.en ?? "?"}, ${probe.country.iso_code}`);

console.log(`uploading to s3://${STAGING}/${KEY}`);
await execFileAsync("aws", [
  "s3", "cp", local, `s3://${STAGING}/${KEY}`,
  "--region", REGION, "--content-type", "application/gzip",
], { maxBuffer: 8e6 });

console.log("\ndone. The next 'Process new logs' run will resolve cities.");
console.log("Data: DB-IP (https://db-ip.com), CC BY 4.0.");
