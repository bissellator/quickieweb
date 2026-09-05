#!/usr/bin/env node
// Ships site/ through the two-bucket model: local -> staging -> live.
//
//   node cli/deploy.mjs --dry-run      show what would happen
//   node cli/deploy.mjs                do it
//   node cli/deploy.mjs --stage-only   push to staging, do not publish
//   node cli/deploy.mjs --prune        ALSO delete what the local build lacks
//
// Staging is the same bucket the admin Lambda edits, so a locally-built post and
// an admin-edited one go live by exactly the same path. Publishing is a
// server-side copy: bytes never round-trip through this machine twice.
//
// WHY --prune IS OPT-IN
//
// There are two authors here and only one of them is this repo. The admin writes
// `_internal/articles/*.json` in staging and renders straight to staging; nothing
// writes those back to `content/`. So a post created in the admin does not exist
// locally, and a sync with `--delete` would read that as "removed" and take a
// live post down -- along with rewriting index.html, feed.xml and articles.json
// to no longer mention it.
//
// So the default is additive: this uploads and overwrites, and never deletes.
// Pruning is a deliberate act with a flag on it, for the case where this repo
// really is the only author. --dry-run --prune lists exactly what would go.
//
// Uses the AWS CLI rather than the SDK so the repo keeps zero npm dependencies.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadConfig(ROOT).catch(reportConfigError);
const { bucket: LIVE, stagingBucket: STAGING, distributionId, region } = config.deploy;

const DRY = process.argv.includes("--dry-run");
const STAGE_ONLY = process.argv.includes("--stage-only");
const PRUNE = process.argv.includes("--prune");

const missing = Object.entries({ LIVE, STAGING, distributionId })
  .filter(([, v]) => !v || String(v).includes("REPLACE-ME"));
if (missing.length) {
  console.error("FATAL: deploy target is not configured. Run: node infra/provision.mjs");
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

// Everything the admin owns. These prefixes must be excluded from every sync in
// both directions: `_internal/` is the article store the admin edits from, and
// deleting it once cost the entire source of truth behind the rendered site.
const ADMIN_OWNED = ["admin/*", "admins.json", "_internal/*", "media/*"];
const excludes = (list) => list.flatMap((p) => ["--exclude", p]);

// A prune is a mirror, and a mirror is exactly what deletes an admin-authored
// post. Say so before doing it rather than after.
const prune = PRUNE ? ["--delete"] : [];
if (PRUNE) {
  console.warn(
    "\n!! --prune: anything in the bucket that the local build did not produce will be\n" +
    "!! DELETED, including posts written in the admin. Confirm with --dry-run first.\n");
}

const site = path.join(ROOT, "site");
console.log(`deploy${DRY ? " (dry run)" : ""}${PRUNE ? " (pruning)" : ""}` +
  `\n  local -> s3://${STAGING} -> s3://${LIVE}\n`);

// 1. Local build into staging.
//
//    Both syncs use the same split: `s-maxage` long so CloudFront holds the
//    object roughly forever (step 3 invalidates it on every deploy), `max-age`
//    short because a browser cache is beyond our reach -- no invalidation, no
//    recall, nothing. The two directives are not redundant; they address two
//    caches with very different escape hatches.
//
//    assets/ is NOT `immutable`: style.css and favicon.svg are not
//    fingerprinted, so the bytes at those URLs do change, and `immutable` would
//    tell every returning reader to ignore that fact for a year. Add a content
//    hash to the filenames and it can come back.
const CACHE_CONTROL = "public,max-age=300,s-maxage=31536000";

await run("aws", ["s3", "sync", path.join(site, "assets"), `s3://${STAGING}/assets`,
  "--region", region, "--cache-control", CACHE_CONTROL]);

await run("aws", ["s3", "sync", site, `s3://${STAGING}`,
  "--region", region, ...prune,
  "--exclude", "assets/*", ...excludes(ADMIN_OWNED),
  "--cache-control", CACHE_CONTROL]);

if (STAGE_ONLY) {
  console.log("\nstaged. Publish from the admin, or re-run without --stage-only.");
  process.exit(0);
}

// 2. Staging -> live. Server-side copy inside S3.
//
//    media/ is deliberately NOT excluded here: uploads land in staging and this
//    is what promotes them, otherwise an <img> in a published post 404s.
await run("aws", ["s3", "sync", `s3://${STAGING}`, `s3://${LIVE}`,
  "--region", region, ...prune,
  ...excludes(["admin/*", "admins.json", "_internal/*"])]);

// 3. Invalidate. Wildcard is one path against the monthly free allowance,
//    where naming every changed file could be dozens.
await run("aws", ["cloudfront", "create-invalidation",
  "--distribution-id", distributionId, "--paths", "/*"]);

console.log(DRY ? "\ndry run complete, nothing changed." : `\nlive at ${config.site.baseUrl}`);
