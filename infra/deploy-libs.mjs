#!/usr/bin/env node
// Ships the platform's browser libraries to lib/ in the live bucket.
//
//   node infra/deploy-libs.mjs --dry-run
//   node infra/deploy-libs.mjs
//
// Served at /__qw/lib/<file> on every hosted host -- the tenant router maps that
// path to lib/ at the bucket ROOT -- so one upload updates every site that
// includes one, with nothing republished:
//
//   <script src="https://quickieweb.com/__qw/lib/comments.js"></script>
//
// Like admin/, lib/ sits outside sites/, so no changeset can write or delete it,
// and nothing but this script does. Written straight to LIVE for the same reason
// the console is: it is platform code, never site content, and staging has no CDN.
//
// Needs the router that knows /__qw/lib/ (infra/provision-access.mjs) to be
// deployed first, or the files upload fine and every request for them 404s.

import { writeFile, mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";
import { clientSource as commentsSource } from "../shared/comments.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadConfig(ROOT).catch(reportConfigError);

const LIVE = config.hosted?.tenantLiveBucket;
const distributionId = config.hosted?.distributionId;
const APEX = config.hosted?.domain;
const { region } = config.deploy;
const DRY = process.argv.includes("--dry-run");

const missing = Object.entries({ "hosted.tenantLiveBucket": LIVE, "hosted.distributionId": distributionId, "hosted.domain": APEX })
  .filter(([, v]) => !v || String(v).includes("REPLACE-ME"));
if (missing.length) {
  console.error("FATAL: the hosted stack is not configured. Platform libraries are served by it alone.");
  for (const [k, v] of missing) console.error(`  ${k} = ${JSON.stringify(v)}`);
  process.exit(1);
}

function run(cmd, args) {
  console.log(`  ${cmd} ${args.join(" ")}`);
  if (DRY) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))));
  });
}

const LIBS = { "comments.js": commentsSource({ apex: APEX }) };

console.log(`deploy platform libraries${DRY ? " (dry run)" : ""}\n  -> s3://${LIVE}/lib/\n`);
const tmp = await mkdtemp(path.join(os.tmpdir(), "qw-libs-"));

for (const [name, source] of Object.entries(LIBS)) {
  const file = path.join(tmp, name);
  await writeFile(file, source);
  console.log(`  built ${name} (${Buffer.byteLength(source)} bytes)`);
  // A stable URL that sites hard-code, so NOT immutable: the CDN keeps it until
  // the invalidation below, and browsers revalidate within five minutes.
  await run("aws", ["s3", "cp", file, `s3://${LIVE}/lib/${name}`, "--region", region,
    // No space after the semicolon: run() goes through a shell on Windows,
    // which would split the value into two arguments.
    "--content-type", "text/javascript;charset=utf-8",
    "--cache-control", "public,max-age=300,s-maxage=31536000"]);
}

// Both spellings: the viewer's path, and the one the router rewrites it to,
// which is what the cache key is built from.
await run("aws", ["cloudfront", "create-invalidation", "--distribution-id", distributionId,
  "--paths", "/__qw/lib/*", "/lib/*"]);

console.log(DRY
  ? "\ndry run complete, nothing changed."
  : `\nlive at https://${APEX}/__qw/lib/${Object.keys(LIBS).join(", ")}`);
