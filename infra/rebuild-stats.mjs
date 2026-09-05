#!/usr/bin/env node
// Rebuilds the whole stats report from the log bucket, from this machine.
//
//   node infra/rebuild-stats.mjs             rebuild everything
//   node infra/rebuild-stats.mjs --dry-run   parse and report, write nothing
//
// The admin's "Rebuild" button does the same work inside the Lambda. This
// exists for two cases the button cannot cover: a backlog too large for a 60s
// invocation, and verifying a change to the accumulator against real logs
// before deploying it anywhere.
//
// Uses the AWS CLI rather than the SDK so it runs in a repo with no
// node_modules. The Lambda has the SDK; a laptop does not.

import { readFile, writeFile, mkdtemp, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import os from "node:os";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";

import { parseLogBuffer } from "../admin/lib/cfparser.mjs";
import { buildDay, mergeDetail, mergeCounts } from "../admin/lib/stats.mjs";
import { MMDBReader, GeoLookup } from "../admin/lib/mmdb.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadConfig(ROOT).catch(reportConfigError);

const STAGING = config.deploy.stagingBucket;
const LOGS = config.deploy.logBucket;
const REGION = config.deploy.region;
const OWN_HOST = new URL(config.site.baseUrl).hostname;
const DRY = process.argv.includes("--dry-run");

const GEO_KEY = "_internal/geo/dbip-city-lite.mmdb.gz";
const PREFIX = "_internal/stats";

if (!LOGS) {
  console.error("FATAL: no logBucket in config.json. Run: node infra/enable-logging.mjs");
  process.exit(1);
}

const tmp = await mkdtemp(path.join(os.tmpdir(), "qw-stats-"));
const aws = (args) => execFileAsync("aws", [...args, "--region", REGION], { maxBuffer: 1 << 28 });

async function getObject(bucket, key) {
  const local = path.join(tmp, key.replace(/[\\/]/g, "_"));
  try {
    await aws(["s3", "cp", `s3://${bucket}/${key}`, local, "--quiet"]);
  } catch {
    return null;
  }
  return readFile(local);
}

async function putJson(key, obj) {
  if (DRY) return;
  const local = path.join(tmp, key.replace(/[\\/]/g, "_"));
  await writeFile(local, JSON.stringify(obj));
  await aws(["s3", "cp", local, `s3://${STAGING}/${key}`, "--content-type", "application/json", "--quiet"]);
}

// --- geo ---------------------------------------------------------------
process.stdout.write("geo database ... ");
let geo = GeoLookup.none();
const geoBuf = await getObject(STAGING, GEO_KEY);
if (geoBuf) {
  const raw = geoBuf[0] === 0x1f && geoBuf[1] === 0x8b ? gunzipSync(geoBuf) : geoBuf;
  geo = new GeoLookup(new MMDBReader(raw));
  console.log(`${new MMDBReader(raw).metadata.database_type} loaded`);
} else {
  console.log("none in staging -- countries only. Run: node infra/fetch-geodb.mjs");
}

// --- log objects -------------------------------------------------------
process.stdout.write("listing logs ... ");
const keys = [];
let token = null;
do {
  const args = ["s3api", "list-objects-v2", "--bucket", LOGS, "--max-items", "1000"];
  if (token) args.push("--starting-token", token);
  const { stdout } = await aws(args);
  const page = JSON.parse(stdout || "{}");
  for (const o of page.Contents ?? []) if (o.Size > 0) keys.push(o.Key);
  token = page.NextToken ?? null;
} while (token);
keys.sort();
console.log(`${keys.length} object(s)`);

if (!keys.length) {
  console.log("\nNothing to process. CloudFront delivers access logs every few minutes.");
  process.exit(0);
}

// --- fold --------------------------------------------------------------
const working = {};
let entryCount = 0;
for (const [i, key] of keys.entries()) {
  process.stdout.write(`\r  reading ${i + 1}/${keys.length}`);
  const buf = await getObject(LOGS, key);
  if (!buf) continue;
  for (const e of await parseLogBuffer(buf)) {
    if (!e.date) continue;
    (working[e.date] ??= []).push(e);
    entryCount++;
  }
}
console.log(`\r  read ${keys.length} object(s), ${entryCount} log lines      `);

const days = {};
const details = {};
for (const [date, entries] of Object.entries(working)) {
  const { summary, detail } = buildDay(date, entries, OWN_HOST, geo);
  days[date] = summary;
  details[date] = mergeDetail(details[date] ?? null, detail);
}

// --- report ------------------------------------------------------------
console.log("");
for (const date of Object.keys(days).sort()) {
  const d = days[date];
  const g = details[date].geo;
  console.log(`${date}  ${String(d.requests).padStart(6)} req  ${
    String(d.sessions).padStart(4)} visits  ${String(d.pageViews).padStart(4)} views  ${
    String(d.bots).padStart(4)} bots  ${String(d.probes).padStart(5)} probes  ${
    String(d.internal).padStart(4)} admin`);
  console.log(`            reader cities: ${g.cities.slice(0, 3).map((c) => `${c.city} ${c.count}`).join(", ") || "none"}`);
  console.log(`            scanner cities: ${g.scannerCities.slice(0, 3).map((c) => `${c.city} ${c.count}`).join(", ") || "none"}`);
  const bots = details[date].bots;
  console.log(`            bots: ${bots.known.slice(0, 4).map((b) => `${b.name} ${b.count}`).join(", ") || "none"}${
    bots.unknown.length ? ` (+${bots.unknown.length} unidentified)` : ""}`);
  const probes = details[date].security.probePatterns.slice(0, 6);
  console.log(`            probe patterns: ${probes.map((p) => `${p.key} ${p.count}`).join(", ") || "none"}`);
  const qk = details[date].acquisition.queryKeys.slice(0, 6);
  console.log(`            query params: ${qk.map((p) => `${p.key} ${p.count}`).join(", ") || "none"}`);
}

const totalProbes = Object.values(days).reduce((n, d) => n + d.probes, 0);
const allPatterns = mergeCounts(Object.values(details).map((d) => d.security.probePatterns), 20);
console.log(`\ntotals: ${Object.values(days).reduce((n, d) => n + d.requests, 0)} requests, ${totalProbes} probes`);
console.log(`probe patterns overall: ${allPatterns.map((p) => `${p.key}=${p.count}`).join(" ")}`);

// --- write -------------------------------------------------------------
if (DRY) {
  console.log("\n(dry run: nothing written)");
  process.exit(0);
}

console.log("\nwriting...");
await putJson(`${PREFIX}/daily.json`, { days, updatedAt: new Date().toISOString() });
for (const [date, detail] of Object.entries(details)) {
  await putJson(`${PREFIX}/days/${date}.json`, detail);
  console.log(`  ${PREFIX}/days/${date}.json`);
}
await putJson(`${PREFIX}/metadata.json`, {
  processed: keys.slice(-5000),
  lastRun: new Date().toISOString(),
  rebuiltBy: "infra/rebuild-stats.mjs",
});
console.log(`  ${PREFIX}/daily.json`);
console.log(`  ${PREFIX}/metadata.json`);
console.log("\ndone. Open /admin -> Stats.");
