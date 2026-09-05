#!/usr/bin/env node
// Creates the IAM user everything else in infra/ runs as.
//
//   node infra/create-deploy-user.mjs --admin-profile <profile>
//   node infra/create-deploy-user.mjs --admin-profile <profile> --status
//   node infra/create-deploy-user.mjs --admin-profile <profile> --rotate
//
// WHY THIS EXISTS
//
// The obvious way to stand up a stack like this is to run it with whatever
// credentials you already have, which for most people is an account root key or
// a full-admin key. Both are the wrong thing to hand to a deploy script: they
// cannot be scoped, so "the script had a bug" and "the key leaked" both mean
// total account compromise, including billing and account closure.
//
// So: one user, one policy (infra/iam/deploy-user-policy.json), scoped to
// buckets named quickieweb-*, Lambda functions named qw-*, and roles named
// qw-*. Run this once with admin credentials, then never use those credentials
// again.
//
// The new secret is written straight into ~/.aws/credentials under a named
// profile and is never printed. AWS returns a secret access key exactly once;
// echoing it into a terminal puts it in scrollback, shell history and any
// session transcript.
//
// RESIDUAL RISK, STATED PLAINLY
//
// The policy allows iam:PutRolePolicy on roles named qw-*, because
// deploy-lambda.mjs writes the function's execution policy. Inline policy
// documents cannot be constrained by a condition, so a holder of this key could
// write an over-broad policy onto a qw-* role and pass it to a Lambda. Closing
// that needs a permissions boundary on every created role. This is a large
// improvement over a root key, not a sandbox.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const STATUS_ONLY = argv.includes("--status");
const ROTATE = argv.includes("--rotate");

const ADMIN_PROFILE = flag("--admin-profile");
const USER = flag("--user") ?? "quickieweb-deploy";
const POLICY = "quickieweb-deploy";
const TARGET_PROFILE = flag("--profile") ?? "quickieweb";
const REGION = flag("--region") ?? "us-west-2";

if (!ADMIN_PROFILE) {
  console.error("FATAL: --admin-profile <name> is required.\n" +
    "  An existing profile with IAM rights, used once to create the scoped user.");
  process.exit(1);
}

async function aws(args, { allowFail = false, profile = ADMIN_PROFILE } = {}) {
  try {
    const { stdout } = await execFileAsync("aws",
      [...args, "--profile", profile, "--output", "json"], { maxBuffer: 16e6 });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`aws ${args.slice(0, 2).join(" ")} failed:\n  ${String(err.stderr || err.message).trim()}`);
  }
}

const log = (s) => console.log(`    ${s}`);
const step = (n, s) => console.log(`\n[${n}] ${s}`);

const who = await aws(["sts", "get-caller-identity"]);
console.log(`admin profile "${ADMIN_PROFILE}" -> account ${who.Account} as ${who.Arn}`);
if (who.Arn.endsWith(":root")) {
  console.log("    (this is a root key -- which is exactly why this script exists)");
}

// --------------------------------------------------------------------- user
step(1, `User ${USER}`);
const existing = await aws(["iam", "get-user", "--user-name", USER], { allowFail: true });
if (existing) {
  log("exists");
} else if (STATUS_ONLY) {
  log("MISSING (status only, not creating)");
} else {
  await aws(["iam", "create-user", "--user-name", USER,
    "--tags", "Key=purpose,Value=quickieweb-deploy"]);
  log("created");
}

// ------------------------------------------------------------------- policy
//
// A customer-managed policy rather than an inline one. Inline user policies cap
// at 2048 bytes and this is well past that; managed policies allow 6144, and
// they version, so a bad edit can be rolled back in the console.
step(2, `Policy ${POLICY}`);
const raw = await readFile(path.join(ROOT, "infra", "iam", "deploy-user-policy.json"), "utf8");
const parsed = JSON.parse(raw);
// IAM counts the document's own bytes, so send it minified. Pretty-printing is
// for the file in the repo, which is where anyone reads it.
const policyDoc = JSON.stringify(parsed);
if (policyDoc.length > 6144) {
  console.error(`FATAL: policy is ${policyDoc.length} bytes minified, over IAM's 6144 limit.`);
  process.exit(1);
}

const policyArn = `arn:aws:iam::${who.Account}:policy/${POLICY}`;
const havePolicy = await aws(["iam", "get-policy", "--policy-arn", policyArn], { allowFail: true });

if (STATUS_ONLY) {
  log(havePolicy ? "exists" : "MISSING");
} else if (!havePolicy) {
  await aws(["iam", "create-policy", "--policy-name", POLICY,
    "--policy-document", policyDoc,
    "--description", "Scoped deploy rights for Quickieweb: quickieweb-* buckets, qw-* functions and roles"]);
  log(`created (${parsed.Statement.length} statements, ${policyDoc.length} bytes)`);
} else {
  // IAM keeps at most five versions. Prune the oldest non-default before adding
  // one, otherwise a sixth edit fails rather than rotating.
  const versions = (await aws(["iam", "list-policy-versions", "--policy-arn", policyArn])).Versions;
  const stale = versions.filter((v) => !v.IsDefaultVersion)
    .sort((a, b) => new Date(a.CreateDate) - new Date(b.CreateDate));
  while (versions.length - stale.length + stale.length >= 5 && stale.length) {
    const oldest = stale.shift();
    await aws(["iam", "delete-policy-version", "--policy-arn", policyArn, "--version-id", oldest.VersionId]);
    log(`pruned old version ${oldest.VersionId}`);
    versions.splice(versions.findIndex((v) => v.VersionId === oldest.VersionId), 1);
  }
  await aws(["iam", "create-policy-version", "--policy-arn", policyArn,
    "--policy-document", policyDoc, "--set-as-default"]);
  log(`updated (${parsed.Statement.length} statements, ${policyDoc.length} bytes)`);
}

if (!STATUS_ONLY) {
  const attached = (await aws(["iam", "list-attached-user-policies", "--user-name", USER], { allowFail: true }))
    ?.AttachedPolicies ?? [];
  if (attached.some((p) => p.PolicyArn === policyArn)) {
    log("already attached to the user");
  } else {
    await aws(["iam", "attach-user-policy", "--user-name", USER, "--policy-arn", policyArn]);
    log("attached to the user");
  }
}

// --------------------------------------------------------------------- keys
step(3, "Access key");
const keys = (await aws(["iam", "list-access-keys", "--user-name", USER], { allowFail: true }))?.AccessKeyMetadata ?? [];
log(`${keys.length} existing key(s)`);

if (STATUS_ONLY) {
  console.log("\nstatus only -- nothing changed.");
  process.exit(0);
}

if (keys.length && !ROTATE) {
  log("leaving them alone (pass --rotate to replace)");
} else {
  // AWS allows two keys per user. Create the new one before deleting the old so
  // a failure here never leaves the user unable to authenticate at all.
  const created = await aws(["iam", "create-access-key", "--user-name", USER]);
  const { AccessKeyId, SecretAccessKey } = created.AccessKey;

  const dir = path.join(os.homedir(), ".aws");
  await mkdir(dir, { recursive: true });
  const credPath = path.join(dir, "credentials");
  const cfgPath = path.join(dir, "config");

  const readOr = async (p) => { try { return await readFile(p, "utf8"); } catch { return ""; } };
  let creds = await readOr(credPath);
  let cfg = await readOr(cfgPath);

  // Replace this profile's block if present, leaving every other profile byte
  // for byte as it was. Rewriting the whole file would be a good way to lose
  // somebody's unrelated credentials.
  const block = `[${TARGET_PROFILE}]\naws_access_key_id = ${AccessKeyId}\naws_secret_access_key = ${SecretAccessKey}\n`;
  const re = new RegExp(`^\\[${TARGET_PROFILE}\\][^\\[]*`, "m");
  creds = re.test(creds) ? creds.replace(re, block) : `${creds.replace(/\n*$/, "\n\n")}${block}`;
  await writeFile(credPath, creds, { mode: 0o600 });

  const cfgBlock = `[profile ${TARGET_PROFILE}]\nregion = ${REGION}\noutput = json\n`;
  const cfgRe = new RegExp(`^\\[profile ${TARGET_PROFILE}\\][^\\[]*`, "m");
  cfg = cfgRe.test(cfg) ? cfg.replace(cfgRe, cfgBlock) : `${cfg.replace(/\n*$/, "\n\n")}${cfgBlock}`;
  await writeFile(cfgPath, cfg, { mode: 0o600 });

  // The id is not a secret -- it appears in CloudTrail on every call. The
  // secret is never printed anywhere.
  log(`created ${AccessKeyId} and wrote profile "${TARGET_PROFILE}" (secret not printed)`);

  if (ROTATE) {
    for (const k of keys) {
      await aws(["iam", "delete-access-key", "--user-name", USER, "--access-key-id", k.AccessKeyId]);
      log(`deleted old key ${k.AccessKeyId}`);
    }
  }
}

// ------------------------------------------------------------------- verify
step(4, "Verify");
// IAM is eventually consistent: a key is routinely unusable for a few seconds
// after creation, and treating that as failure would be wrong.
let verified = null;
for (let i = 0; i < 10 && !verified; i++) {
  verified = await aws(["sts", "get-caller-identity"], { allowFail: true, profile: TARGET_PROFILE });
  if (!verified) await new Promise((r) => setTimeout(r, 2000));
}
if (!verified) {
  console.error("\nFATAL: the new key did not authenticate after 20s. Check the console.");
  process.exit(1);
}
log(`profile "${TARGET_PROFILE}" -> ${verified.Arn}`);

console.log(`\nUse it with:  AWS_PROFILE=${TARGET_PROFILE} node infra/provision-platform.mjs`);
console.log("The admin credentials are not needed again. Deleting the root access key in the\n" +
  "IAM console is now a safe thing to do.");
