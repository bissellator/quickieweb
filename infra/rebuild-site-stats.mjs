#!/usr/bin/env node
// Rebuilds one HOSTED site's stats from its access logs, from this machine.
//
//   node infra/rebuild-site-stats.mjs --site stuckinawoman --dry-run
//   node infra/rebuild-site-stats.mjs --site stuckinawoman
//
// The Stats tab's Rebuild button does the same inside the Lambda, which has 60
// seconds; a busy site's month of logs does not fit. infra/rebuild-stats.mjs is
// the self-hosted equivalent (one bucket, config.json's one site) and does not
// know about tenants, shared log folders or mirrors.
//
// This runs the Lambda's own code path -- processLogs with force -- so the
// result is exactly what the button would write. The log folders are copied
// down with `aws s3 sync` first (thousands of small objects; one CLI call per
// object would take an hour), and processLogs reads them from disk through a
// stand-in S3 client. Stats are written back to the site's prefix in staging.
//
// A forced rebuild keeps only days whose logs are still in the bucket (raw logs
// expire after 30 days). It refuses to run when that would drop stored days
// rather than rebuild them; --allow-drop overrides.
//
// Uses the AWS CLI, not the SDK, so it runs in a repo with no node_modules.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, readdir, stat, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";
import { checkSiteId, normalizeSite, siteKeyFor, logSourcesFor, siteOwnHosts } from "../shared/site.mjs";
import { hostedSettings, readJsonOrNull } from "./lib/seed-site.mjs";
import { processLogs } from "../admin/lib/stats.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const DRY = argv.includes("--dry-run");
const ALLOW_DROP = argv.includes("--allow-drop");
const SITE = flag("--site");

if (!SITE || checkSiteId(SITE) && SITE !== "www") {
  console.error("usage: node infra/rebuild-site-stats.mjs --site <id> [--dry-run] [--allow-drop]");
  process.exit(1);
}

const config = await loadConfig(ROOT).catch(reportConfigError);
const settings = hostedSettings(config);
const aws = async (args) =>
  (await execFileAsync("aws", [...args, "--region", settings.region], { maxBuffer: 1 << 28 })).stdout;

const PLATFORM_GEO_KEY = "geo/dbip-city-lite.mmdb.gz"; // admin/server.mjs, same key
const tmp = await mkdtemp(path.join(os.tmpdir(), "qw-rebuild-"));

try {
  // ------------------------------------------------------------------ the site
  const raw = await readJsonOrNull(aws, `s3://${settings.platformBucket}/${siteKeyFor(SITE)}`);
  if (!raw) throw new Error(`no site "${SITE}" in the registry`);
  const site = normalizeSite(raw);
  if (site.storage.driver !== "prefix") throw new Error("only hosted (prefix-driver) sites; use infra/rebuild-stats.mjs");
  const logBucket = site.storage.logBucket || settings.logBucket;
  if (!logBucket) throw new Error("no log bucket for this site (hosted.tenantLogBucket in config.json)");
  const sources = logSourcesFor(site, { hostedDomain: settings.domain });
  const ownHost = siteOwnHosts(site, { hostedDomain: settings.domain });
  const staging = site.storage.stagingBucket;
  const prefix = site.storage.prefix;
  console.log(`site ${SITE}: stats at s3://${staging}/${prefix}_internal/stats/`);
  console.log(`own hosts: ${ownHost.join(", ")}`);

  // ------------------------------------------------------------- copy the logs
  const logDir = path.join(tmp, "logs");
  for (const s of sources) {
    process.stdout.write(`sync s3://${logBucket}/${s.prefix} ${s.hosts ? `(hosts ${s.hosts.join(", ")})` : "(whole folder)"} ... `);
    await aws(["s3", "sync", `s3://${logBucket}/${s.prefix}`, path.join(logDir, s.prefix), "--only-show-errors"]);
    console.log("done");
  }

  async function walk(dir, rel = "") {
    const out = [];
    let names;
    try { names = await readdir(dir); } catch (err) { if (err.code === "ENOENT") return out; throw err; }
    for (const n of names) {
      const full = path.join(dir, n);
      const key = rel + n;
      if ((await stat(full)).isDirectory()) out.push(...await walk(full, `${key}/`));
      else out.push({ Key: key, Size: (await stat(full)).size });
    }
    return out;
  }
  const allLogs = await walk(logDir);

  // A stand-in S3 client over the local copy: the two calls processLogs makes.
  class ListObjectsV2Command { constructor(input) { this.input = input; } }
  class GetObjectCommand { constructor(input) { this.input = input; } }
  const s3 = {
    async send(cmd) {
      if (cmd instanceof ListObjectsV2Command) {
        const p = cmd.input.Prefix ?? "";
        return { Contents: allLogs.filter((o) => o.Key.startsWith(p)), IsTruncated: false };
      }
      if (cmd instanceof GetObjectCommand) {
        return { Body: [await readFile(path.join(logDir, ...cmd.input.Key.split("/")))] };
      }
      throw new Error(`unexpected S3 call ${cmd.constructor.name}`);
    },
  };

  // ------------------------------------------------------- the site's store
  const writes = new Map();
  const getBuffer = async (key) => {
    const f = path.join(tmp, "get.bin");
    try {
      await aws(["s3", "cp", `s3://${staging}/${prefix}${key}`, f, "--only-show-errors"]);
    } catch (err) {
      if (/\(404\)|Not Found|NoSuchKey|does not exist/i.test(String(err.stderr ?? err.message))) return null;
      throw new Error(`could not read ${prefix}${key}: ${String(err.stderr ?? err.message).trim()}`);
    }
    return readFile(f);
  };
  const store = {
    getBuffer,
    async getJson(key, fallback) {
      const buf = await getBuffer(key);
      return buf ? JSON.parse(buf.toString("utf8")) : fallback;
    },
    async putJson(key, obj) { writes.set(key, obj); },
  };

  const before = await store.getJson("_internal/stats/daily.json", { days: {} });

  const geoFallback = async () => {
    const f = path.join(tmp, "geo.gz");
    await aws(["s3", "cp", `s3://${settings.platformBucket}/${PLATFORM_GEO_KEY}`, f, "--only-show-errors"]);
    return readFile(f);
  };

  // ------------------------------------------------------------------ rebuild
  process.stdout.write(`processing ${allLogs.length} log file(s) ... `);
  const result = await processLogs({
    s3, logBucket, store, ownHost, sources, force: true, maxFiles: Infinity,
    sdk: { ListObjectsV2Command, GetObjectCommand }, geoFallback,
  });
  console.log(`${result.processed} read, ${result.days} day(s), ${result.foreign} other-site lines skipped, geo ${result.geo ? "on" : "off"}`);

  const after = writes.get("_internal/stats/daily.json");
  const lost = Object.keys(before.days).filter((d) => !after.days[d]).sort();
  for (const date of Object.keys(after.days).sort()) {
    const b = before.days[date];
    const a = after.days[date];
    const top = (a.referrers ?? []).slice(0, 4).map((r) => `${r.key} ${r.count}`).join(", ");
    console.log(`  ${date}  ${String(a.sessions ?? 0).padStart(5)} visits (was ${b ? b.sessions ?? 0 : "-"})   ${top}`);
  }
  if (lost.length) {
    console.log(`\nstored days with no logs left, which a rebuild would DROP: ${lost.join(", ")}`);
    if (!ALLOW_DROP) throw new Error("refusing to drop stored days; pass --allow-drop to accept");
  }

  if (DRY) {
    console.log(`\ndry run: ${writes.size} object(s) not written`);
  } else {
    for (const [key, obj] of writes) {
      const f = path.join(tmp, "put.json");
      await writeFile(f, JSON.stringify(obj));
      await aws(["s3", "cp", f, `s3://${staging}/${prefix}${key}`, "--content-type", "application/json", "--only-show-errors"]);
    }
    console.log(`\nwrote ${writes.size} object(s). Open the Stats tab.`);
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}
