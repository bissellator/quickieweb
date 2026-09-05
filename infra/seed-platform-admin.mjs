#!/usr/bin/env node
// Makes somebody platform staff.
//
//   node infra/seed-platform-admin.mjs --email you@example.com
//   node infra/seed-platform-admin.mjs --email them@example.com --revoke
//   node infra/seed-platform-admin.mjs --list
//
// THE BOOTSTRAP PROBLEM
//
// Only staff can create sites, and `platformRole` is never settable through the
// API -- deliberately, because an API that can promote its own caller is not an
// authorization system. So the first staff member is placed here, out of band,
// by somebody holding AWS credentials.
//
// It stays out of band afterwards too. There is no "make staff" button in the
// console, and adding one would mean a compromised staff session could mint
// more staff. Promoting somebody is a deliberate act at a terminal, by a person
// who already has the keys to the account.
//
// Staff see and can open every site. That is a real power and the reason this is
// a separate script rather than a flag on seeding a site: it should feel like
// what it is.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import path from "node:path";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";

import { userKeyFor } from "../shared/site.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadConfig(ROOT).catch(reportConfigError);

const PLATFORM = config.deploy.platformBucket;
const REGION = config.deploy.region;

const argv = process.argv.slice(2);
const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const LIST = argv.includes("--list");
const REVOKE = argv.includes("--revoke");
const email = (flag("--email") ?? "").trim().toLowerCase();

if (!PLATFORM || PLATFORM.includes("REPLACE-ME")) {
  console.error("FATAL: no deploy.platformBucket in config.json. Run: node infra/provision-platform.mjs");
  process.exit(1);
}
if (!LIST && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error("FATAL: --email <address> is required, and must be the Google account they sign in with.");
  process.exit(1);
}

// Imported, not re-derived: this must produce byte-for-byte the key the Lambda
// reads, and a second copy of the formula is a second thing to get wrong.
const userKey = (addr) => userKeyFor(addr, (v) => createHash("sha256").update(v).digest("hex"));

async function s3Json(key) {
  try {
    const { stdout } = await execFileAsync("aws",
      ["s3", "cp", `s3://${PLATFORM}/${key}`, "-", "--region", REGION], { maxBuffer: 8e6 });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

async function putJson(key, obj) {
  const { writeFile, rm, mkdtemp } = await import("node:fs/promises");
  const os = await import("node:os");
  const dir = await mkdtemp(path.join(os.tmpdir(), "qw-seed-"));
  const tmp = path.join(dir, "obj.json");
  await writeFile(tmp, JSON.stringify(obj, null, 2));
  try {
    await execFileAsync("aws", ["s3", "cp", tmp, `s3://${PLATFORM}/${key}`,
      "--region", REGION, "--content-type", "application/json", "--cache-control", "no-store"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------------- list
if (LIST) {
  const { stdout } = await execFileAsync("aws",
    ["s3", "ls", `s3://${PLATFORM}/accounts/users/`, "--region", REGION], { maxBuffer: 8e6 })
    .catch(() => ({ stdout: "" }));

  const keys = stdout.trim().split("\n").filter(Boolean)
    .map((l) => l.trim().split(/\s+/).pop())
    .filter((k) => k && k.endsWith(".json"));

  console.log(`users in s3://${PLATFORM}/accounts/users/\n`);
  let staff = 0;
  for (const k of keys) {
    const u = await s3Json(`accounts/users/${k}`);
    if (!u) continue;
    if (u.platformRole === "staff") staff++;
    console.log(`  ${(u.platformRole ?? "user").padEnd(6)} ${u.email.padEnd(34)} ${(u.siteIds ?? []).join(", ") || "(no sites)"}`);
  }
  if (!keys.length) console.log("  (none yet -- nobody has signed in)");
  console.log(`\n${keys.length} user(s), ${staff} staff.`);
  process.exit(0);
}

// ------------------------------------------------------------------ change
const key = userKey(email);
const existing = await s3Json(key);

const record = existing ?? {
  email,
  name: "",
  platformRole: "user",
  siteIds: [],
  createdAt: new Date().toISOString(),
  lastSeenAt: "",
};

// A record can exist with a different casing than the caller typed. The hash is
// computed from the lowercased address, so this cannot silently create a second
// record for the same person -- but it is worth being explicit about which
// address is being changed.
record.email = email;

if (REVOKE) {
  if (record.platformRole !== "staff") {
    console.log(`${email} is not staff. Nothing to do.`);
    process.exit(0);
  }
  record.platformRole = "user";
} else {
  if (record.platformRole === "staff") {
    console.log(`${email} is already staff.`);
    process.exit(0);
  }
  record.platformRole = "staff";
}
record.updatedAt = new Date().toISOString();

await putJson(key, record);

console.log(`${email} is now ${record.platformRole}.`);
if (!existing) {
  console.log("\n  (no prior record -- created one. They have not signed in yet, which is fine:\n" +
    "   the console reads this on their first request.)");
}
if (record.platformRole === "staff") {
  console.log("\nStaff can list, open and create every site in this installation.");
  console.log(`Revoke with: node infra/seed-platform-admin.mjs --email ${email} --revoke`);
}
