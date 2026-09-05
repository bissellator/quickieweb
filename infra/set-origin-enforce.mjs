#!/usr/bin/env node
// Turn the CloudFront-only lockdown on or off.
//
//   node infra/set-origin-enforce.mjs on
//   node infra/set-origin-enforce.mjs off
//   node infra/set-origin-enforce.mjs          (report current state)
//
// This is deliberately a configuration flip rather than a code deploy, because
// it is also the rollback. If enforcing turns out to break something, `off`
// restores the previous behaviour in seconds; a redeploy would take minutes and
// need a working build.
//
// The safety property is the ordering:
//   1. infra/wire-cloudfront.mjs   puts x-qw-origin on the origin
//   2. wait for the distribution to reach Deployed
//   3. infra/deploy-lambda.mjs     teaches the function the secret (inert)
//   4. this script                 makes it required
//
// Do 4 before 2 finishes and the admin 403s until CloudFront catches up. This
// script therefore refuses to turn enforcement on unless it can confirm the
// function already knows a secret AND the distribution is actually sending it.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadConfig(ROOT).catch(reportConfigError);

const FN = config.deploy.functionName ?? "qw-admin";
const REGION = config.deploy.lambdaRegion ?? "us-east-1";
const DIST = config.deploy.distributionId;
const ORIGIN_ID = "admin-lambda";
const HEADER = "x-qw-origin";

const arg = (process.argv[2] ?? "").toLowerCase();
if (arg && !["on", "off"].includes(arg)) {
  console.error("usage: node infra/set-origin-enforce.mjs [on|off]");
  process.exit(1);
}

async function aws(args, { region = REGION, allowFail = false } = {}) {
  try {
    const { stdout } = await execFileAsync("aws",
      [...args, "--region", region, "--output", "json"], { maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`aws ${args.slice(0, 3).join(" ")} failed:\n  ${String(err.stderr || err.message).trim()}`);
  }
}

const cfg = await aws(["lambda", "get-function-configuration", "--function-name", FN]);
const vars = { ...(cfg.Environment?.Variables ?? {}) };
const current = vars.ORIGIN_ENFORCE === "1";

console.log(`function      ${FN}`);
console.log(`origin secret ${vars.ORIGIN_SECRET ? "present" : "MISSING"}`);
console.log(`enforcing     ${current ? "ON" : "off"}`);

if (!arg) process.exit(0);

const want = arg === "on";
if (want === current) {
  console.log(`\nalready ${current ? "on" : "off"}, nothing to do.`);
  process.exit(0);
}

if (want) {
  if (!vars.ORIGIN_SECRET) {
    throw new Error("Refusing to enforce: the function has no ORIGIN_SECRET.\n" +
      "  Run: node infra/deploy-lambda.mjs");
  }
  // Confirm the distribution is actually sending the same value. Enforcing
  // against a secret CloudFront is not sending 403s every request, including
  // the admin's own.
  const dist = await aws(["cloudfront", "get-distribution-config", "--id", DIST],
    { region: "us-east-1" });
  const sending = (dist.DistributionConfig.Origins.Items ?? [])
    .find((o) => o.Id === ORIGIN_ID)
    ?.CustomHeaders?.Items
    ?.find((h) => h.HeaderName.toLowerCase() === HEADER)?.HeaderValue;

  if (!sending) {
    throw new Error(`Refusing to enforce: the ${ORIGIN_ID} origin sends no ${HEADER}.\n` +
      "  Run: node infra/wire-cloudfront.mjs");
  }
  if (sending !== vars.ORIGIN_SECRET) {
    throw new Error(`Refusing to enforce: the distribution's ${HEADER} does not match the\n` +
      "  function's ORIGIN_SECRET. Redeploy the function to pick up the current value:\n" +
      "    node infra/deploy-lambda.mjs");
  }

  const status = await aws(["cloudfront", "get-distribution", "--id", DIST], { region: "us-east-1" });
  if (status.Distribution.Status !== "Deployed") {
    throw new Error(`Refusing to enforce: the distribution is ${status.Distribution.Status}, not Deployed.\n` +
      "  Edge locations may still be sending requests without the header. Wait:\n" +
      `    aws cloudfront wait distribution-deployed --id ${DIST}`);
  }
  console.log("\nchecked: secret matches, distribution Deployed");
}

vars.ORIGIN_ENFORCE = want ? "1" : "";
await aws(["lambda", "update-function-configuration", "--function-name", FN,
  "--environment", JSON.stringify({ Variables: vars })]);
await execFileAsync("aws", ["lambda", "wait", "function-updated",
  "--function-name", FN, "--region", REGION]);

console.log(`\nenforcing is now ${want ? "ON" : "off"}.`);
console.log(want
  ? "  The function URL now refuses anything that did not come through CloudFront."
  : "  The function URL is reachable directly again.");
