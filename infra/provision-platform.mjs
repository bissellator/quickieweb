#!/usr/bin/env node
// Provisions the platform bucket: the template library and the account registry.
//
//   node infra/provision-platform.mjs            create/verify, then seed templates
//   node infra/provision-platform.mjs --status   report only, change nothing
//   node infra/provision-platform.mjs --no-seed  create the bucket, publish nothing
//
// This bucket is the thing that makes one Lambda able to serve many sites:
//
//   templates/<id>/<version>/…   the library. Immutable per version.
//   templates/index.json         the catalog the admin browses.
//   accounts/sites/<id>.json     a site: identity, template, storage binding, members.
//   accounts/users/<hash>.json   a person, and the sites they belong to.
//
// It is deliberately NOT one of a site's content buckets. Publishing compares a
// site's staging against its own live, so a bucket that is neither cannot be
// reached by a publish however wrong the changeset is -- and the admin Lambda
// holds read-only credentials for it, so a compromised editor session on one
// site cannot alter a template that every other site renders against.
//
// Versioning is on. The registry is small, mutable JSON that everything depends
// on; being able to recover the previous copy of a site record is worth cents.
//
// Every step checks first, so re-running is safe. Nothing here deletes anything.

import { writeFile, rm } from "node:fs/promises";
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
const NO_SEED = process.argv.includes("--no-seed");

const REGION = config.deploy.region;
const BUCKET = config.deploy.platformBucket;

if (!BUCKET || BUCKET.includes("REPLACE-ME")) {
  console.error("FATAL: set deploy.platformBucket in config.json first.\n" +
    "  Something like \"<yourname>-quickieweb-platform\" -- it is global, so it must be unique.");
  process.exit(1);
}

async function aws(args, { region = REGION, allowFail = false } = {}) {
  const full = [...args, "--region", region, "--output", "json"];
  try {
    const { stdout } = await execFileAsync("aws", full, { maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`aws ${args.slice(0, 3).join(" ")} failed:\n  ${String(err.stderr || err.message).trim()}`);
  }
}

const log = (s) => console.log(`    ${s}`);
const step = (n, s) => console.log(`\n[${n}] ${s}`);

console.log(`platform bucket ${BUCKET}${STATUS_ONLY ? " (status only)" : ""}  region=${REGION}`);

// ------------------------------------------------------------------- bucket
step(1, "Bucket");
const head = await aws(["s3api", "head-bucket", "--bucket", BUCKET], { allowFail: true });
const exists = head !== null || (await aws(["s3api", "list-objects-v2", "--bucket", BUCKET, "--max-keys", "1"], { allowFail: true })) !== null;

if (exists) {
  log("exists");
} else if (STATUS_ONLY) {
  log("MISSING (status only, not creating)");
} else {
  // us-east-1 is the one region where CreateBucket must NOT carry a location
  // constraint; passing one there fails with InvalidLocationConstraint.
  const create = ["s3api", "create-bucket", "--bucket", BUCKET];
  if (REGION !== "us-east-1") create.push("--create-bucket-configuration", `LocationConstraint=${REGION}`);
  await aws(create);
  log("created");
}

if (!STATUS_ONLY) {
  step(2, "Lock it down");
  // Nothing in this bucket is ever public. The library is read by the Lambda
  // through its execution role and by operators through the CLI; a template is
  // not a CDN asset, it is source that gets rendered.
  await aws(["s3api", "put-public-access-block", "--bucket", BUCKET,
    "--public-access-block-configuration",
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"]);
  log("public access blocked");

  await aws(["s3api", "put-bucket-encryption", "--bucket", BUCKET,
    "--server-side-encryption-configuration",
    JSON.stringify({ Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] })]);
  log("SSE-S3 encryption on");

  await aws(["s3api", "put-bucket-versioning", "--bucket", BUCKET,
    "--versioning-configuration", "Status=Enabled"]);
  log("versioning on (the registry is recoverable)");
}

// ------------------------------------------------------------------ registry
if (!STATUS_ONLY) {
  step(3, "Registry");
  const marker = await aws(["s3api", "head-object", "--bucket", BUCKET, "--key", "accounts/README.txt"], { allowFail: true });
  if (marker) {
    log("accounts/ already initialized");
  } else {
    const tmp = path.join(ROOT, ".platform-readme.txt");
    await writeFile(tmp,
      "Quickieweb account registry.\n\n" +
      "accounts/sites/<siteId>.json   one site: identity, template, storage binding, members\n" +
      "accounts/users/<hash>.json     one person, and the siteIds they belong to\n\n" +
      "Written by the admin Lambda and by infra/. Never served to a reader, never\n" +
      "published to any site's bucket. See shared/site.mjs for the shapes.\n");
    try {
      await execFileAsync("aws", ["s3", "cp", tmp, `s3://${BUCKET}/accounts/README.txt`,
        "--region", REGION, "--content-type", "text/plain"]);
    } finally {
      await rm(tmp, { force: true });
    }
    log("accounts/ initialized");
  }
}

// ----------------------------------------------------------------- templates
step(4, "Template library");
const catalog = await aws(["s3api", "head-object", "--bucket", BUCKET, "--key", "templates/index.json"], { allowFail: true });
log(catalog ? "catalog present" : "no catalog yet");

if (!STATUS_ONLY && !NO_SEED) {
  const { listLocalTemplates } = await import("../cli/lib/template-fs.mjs");
  const local = await listLocalTemplates(path.join(ROOT, "templates"));
  if (!local.length) {
    log("nothing in templates/ to seed");
  } else {
    for (const t of local) {
      console.log(`\n  publishing ${t.id}@${t.version}`);
      try {
        const { stdout } = await execFileAsync("node",
          [path.join(ROOT, "cli", "templates.mjs"), "publish", t.dir], { maxBuffer: 16e6 });
        for (const line of stdout.trim().split("\n")) log(line);
      } catch (err) {
        // Already-published is the expected outcome on a re-run. Anything else
        // is a real failure and must stop the run rather than be logged past.
        const msg = `${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}`;
        if (!msg.includes("already published")) {
          throw new Error(`publishing ${t.id}@${t.version} failed:\n${msg.trim()}`);
        }
        log(`${t.id}@${t.version} is already in the library`);
      }
    }
  }
}

console.log(`\nplatform bucket ready: s3://${BUCKET}`);
console.log("Next: node infra/deploy-lambda.mjs   (grants the function read-only access and sets PLATFORM_BUCKET)");
