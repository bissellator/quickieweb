#!/usr/bin/env node
// Seeds the staging bucket with everything the admin Lambda needs to start:
//
//   admins.json                 the first owner  <- bootstrap, chicken-and-egg
//   _internal/config.json       site identity, taxonomy, template + theme
//   _internal/articles/*.json   posts already in content/
//   _internal/articles/index.json
//
//   node infra/seed-staging.mjs --owner you@example.com
//   node infra/seed-staging.mjs --owner you@example.com --force   overwrite admins.json
//
// The bootstrap problem is real: the Lambda refuses every request when the admin
// list is missing, and only an owner can write the list through the API. So the
// very first owner has to be placed here, with AWS credentials, out of band.
// After that the list is managed in the admin UI.
//
// admins.json goes ONLY in the staging bucket. Publishing skips it, and staging
// is never fronted by CloudFront, so the address list is not world-readable.

import { readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { writeFile, mkdtemp } from "node:fs/promises";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (p) => JSON.parse(await readFile(path.join(ROOT, p), "utf8"));

const config = await readJson("config.json");
const STAGING = config.deploy.stagingBucket;
const REGION = config.deploy.region;

const argv = process.argv.slice(2);
const owner = argv.includes("--owner") ? argv[argv.indexOf("--owner") + 1] : null;
const force = argv.includes("--force");

if (!STAGING || STAGING.includes("REPLACE-ME")) {
  console.error("FATAL: no staging bucket in config.json. Run: node infra/provision.mjs");
  process.exit(1);
}
if (!owner || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(owner)) {
  console.error("FATAL: --owner <email> is required and must be a real address.\n" +
    "  It must be the Google account you will sign in with.");
  process.exit(1);
}

const tmp = await mkdtemp(path.join(os.tmpdir(), "qw-seed-"));

async function put(key, obj) {
  const local = path.join(tmp, key.replace(/\//g, "_"));
  await writeFile(local, JSON.stringify(obj, null, 2));
  await execFileAsync("aws", ["s3", "cp", local, `s3://${STAGING}/${key}`,
    "--region", REGION, "--content-type", "application/json"], { maxBuffer: 8e6 });
  console.log(`  put ${key}`);
}

async function exists(key) {
  try {
    await execFileAsync("aws", ["s3api", "head-object", "--bucket", STAGING, "--key", key, "--region", REGION]);
    return true;
  } catch {
    return false;
  }
}

console.log(`seeding s3://${STAGING}\n`);

// --- admins.json (never clobbered without --force: overwriting it silently
// --- would demote every admin added through the UI back to this one address)
if (await exists("admins.json") && !force) {
  console.log("  skip admins.json (already exists -- pass --force to replace)");
} else {
  await put("admins.json", {
    admins: [{ email: owner.toLowerCase(), role: "owner", name: config.site.author || owner.split("@")[0], added: new Date().toISOString() }],
    seededAt: new Date().toISOString(),
  });
}

// --- config the renderer needs. One object, not three: the Lambda reads site
// --- identity and taxonomy from here, so re-running this script is how a
// --- config.json edit reaches production without redeploying the function.
await put("_internal/config.json", {
  site: config.site,
  taxonomy: config.taxonomy ?? { categories: {} },
  // Which template renders this site, and the customer's token overrides. The
  // Lambda reads both from here, so switching template or recolouring a site is
  // a bucket write plus a rebuild rather than a redeploy.
  template: config.template ?? { id: "journal", version: "" },
  theme: config.theme ?? {},
});

// --- posts already in content/. Optional: a site authored entirely in the
// --- admin has none, and seeding an empty index is the correct starting state.
let files = [];
try {
  files = (await readdir(path.join(ROOT, "content"))).filter((f) => f.endsWith(".json"));
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}
const slugs = [];
for (const f of files) {
  const a = await readJson(path.join("content", f));
  await put(`_internal/articles/${a.slug}.json`, a);
  slugs.push(a.slug);
}
// Never clobber an index the admin has been writing to. Seeding an empty list
// over a live one would orphan every post already in the bucket.
if (slugs.length || !(await exists("_internal/articles/index.json"))) {
  await put("_internal/articles/index.json", slugs);
} else {
  console.log("  skip _internal/articles/index.json (exists, nothing local to seed)");
}

console.log(`\nseeded ${slugs.length} post(s). First owner: ${owner}`);
console.log("Sign in at https://" + config.site.domain + "/admin/");
