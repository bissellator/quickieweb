#!/usr/bin/env node
// Routes the OAuth surface to the admin Lambda at the ROOT of the console host.
//
//   node infra/wire-oauth.mjs            attach
//   node infra/wire-oauth.mjs --status   report only, change nothing
//
// WHY THESE PATHS CANNOT LIVE UNDER /api
//
// RFC 8414 builds an authorization server's metadata URL by inserting
// /.well-known/ between the host and the issuer's path component. An issuer of
// https://app.example/api therefore advertises its own discovery document at
// https://app.example/.well-known/oauth-authorization-server/api -- a URL no
// generic client would think to request, because clients construct it from the
// origin they were handed.
//
// So the issuer has to be the bare origin, and /authorize, /register,
// /oauth/token and /.well-known/* have to answer there. Each gets a cache
// behavior pointing at the same Lambda origin the /api/* behavior already uses,
// cloned from it so there is one description of how to reach the function.
//
// Additive and idempotent. It reads the /api/* behavior, copies it per path,
// and leaves every other behavior -- above all the default one, where the
// tenant router lives -- exactly as found.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadConfig(ROOT).catch(reportConfigError);

const STATUS_ONLY = process.argv.includes("--status");
const DIST = config.hosted?.distributionId;

// Must match OAUTH_ROOT_PATHS in admin/server.mjs. A path routed here that the
// server does not answer is a 404; a path the server answers that is not routed
// here never reaches it.
const PATHS = ["/.well-known/*", "/authorize", "/register", "/oauth/*", "/consent"];

if (!DIST || DIST.includes("REPLACE-ME")) {
  console.error("FATAL: no hosted.distributionId in config.json."
    + " Run: node infra/provision-hosted.mjs");
  process.exit(1);
}

async function aws(args, { allowFail = false } = {}) {
  try {
    const { stdout } = await execFileAsync("aws", [...args, "--output", "json"],
      { maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`aws ${args.slice(0, 3).join(" ")} failed:\n  ${String(err.stderr || err.message).trim()}`);
  }
}

const log = (s) => console.log(`    ${s}`);

console.log(`distribution ${DIST}${STATUS_ONLY ? "  (status only)" : ""}`);

const dist = await aws(["cloudfront", "get-distribution-config", "--id", DIST]);
const cfg = dist.DistributionConfig;
const etag = dist.ETag;

const items = cfg.CacheBehaviors?.Items ?? [];
const api = items.find((b) => b.PathPattern === "/api/*");
if (!api) {
  console.error("FATAL: no /api/* behavior to copy. Run: node infra/wire-cloudfront.mjs");
  process.exit(1);
}
log(`copying /api/* -> origin ${api.TargetOriginId}`);

let added = 0;
for (const pattern of PATHS) {
  if (items.some((b) => b.PathPattern === pattern)) {
    log(`${pattern}: already routed`);
    continue;
  }
  log(`${pattern}: adding`);
  // Everything about reaching the function -- origin, cache policy, origin
  // request policy, allowed methods -- is whatever /api/* already uses, so
  // there is one description of it rather than two that can drift.
  if (!STATUS_ONLY) items.push({ ...api, PathPattern: pattern });
  added += 1;
}

if (STATUS_ONLY) {
  console.log(`\nstatus only. ${added} behavior(s) would be added.`);
  process.exit(0);
}
if (!added) {
  console.log("\nalready wired, nothing to do.");
  process.exit(0);
}

// CloudFront matches the MOST SPECIFIC pattern, not the first, so ordering here
// is not load-bearing -- but keeping the list stable makes a diff of the
// distribution readable.
cfg.CacheBehaviors = { Quantity: items.length, Items: items };

await aws(["cloudfront", "update-distribution", "--id", DIST, "--if-match", etag,
  "--distribution-config", JSON.stringify(cfg)]);

console.log(`\nadded ${added} behavior(s). CloudFront takes a few minutes to deploy.`);
console.log("Then: curl https://app.<domain>/.well-known/oauth-authorization-server");
