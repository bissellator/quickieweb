#!/usr/bin/env node
// Builds and deploys the MCP server: its own function, on its own host.
//
//   node infra/deploy-mcp.mjs
//
// WHY IT IS A SEPARATE FUNCTION
//
// It holds nothing. No S3 client, no AWS SDK, no storage, no secret, no
// session -- it attaches the caller's bearer to a request against the admin API
// and returns the answer. So its execution role grants exactly one thing:
// writing its own logs.
//
// That is the entire argument for the separation. Folding these routes into the
// admin Lambda would have been less infrastructure, but it would have put the
// endpoint that accepts arbitrary agent traffic inside the process that holds
// read-write credentials for every tenant bucket and the account registry.
// Here, a total compromise of this function yields a log group.
//
// Idempotent: every step checks first.

import { readFile, mkdir, cp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadConfig(ROOT).catch(reportConfigError);

const FN = "qw-mcp";
const ROLE = "qw-mcp-role";
const REGION = "us-east-1";
const BUILD = path.join(ROOT, "infra", "mcp-build");
const ZIP = path.join(ROOT, "infra", `${FN}.zip`);

const DOMAIN = config.hosted?.domain;
if (!DOMAIN || DOMAIN.includes("REPLACE-ME")) {
  console.error("FATAL: no hosted.domain in config.json. Run: node infra/provision-hosted.mjs");
  process.exit(1);
}
const API_ORIGIN = `https://app.${DOMAIN}`;
const MCP_ORIGIN = `https://mcp.${DOMAIN}`;

async function aws(args, { allowFail = false, region = REGION } = {}) {
  try {
    const { stdout } = await execFileAsync("aws", [...args, "--region", region, "--output", "json"],
      { maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`aws ${args.slice(0, 3).join(" ")} failed:\n  ${String(err.stderr || err.message).trim()}`);
  }
}

const log = (s) => console.log(`    ${s}`);
const step = (n, s) => console.log(`\n[${n}] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`deploy ${FN}  region=${REGION}  api=${API_ORIGIN}`);

// -------------------------------------------------------------------- build
step(1, "Bundle");
await rm(BUILD, { recursive: true, force: true });
await mkdir(path.join(BUILD, "shared"), { recursive: true });

// Only what it imports. The MCP server pulls in shared/mcp.mjs and nothing
// else -- no renderer, no template engine, no store -- which is why this bundle
// is kilobytes rather than megabytes and has no dependencies at all.
await cp(path.join(ROOT, "mcp", "server.mjs"), path.join(BUILD, "server.mjs"));
await cp(path.join(ROOT, "shared", "mcp.mjs"), path.join(BUILD, "shared", "mcp.mjs"));
await writeFile(path.join(BUILD, "package.json"), JSON.stringify({ type: "module" }, null, 2));

// server.mjs imports ../shared/mcp.mjs, which climbs out of the zip root.
const src = await readFile(path.join(BUILD, "server.mjs"), "utf8");
await writeFile(path.join(BUILD, "server.mjs"),
  src.replace('from "../shared/mcp.mjs"', 'from "./shared/mcp.mjs"'));

await execFileAsync("python", [path.join(ROOT, "infra", "zip-lambda.py"), BUILD, ZIP]);
const { size } = await import("node:fs").then((fs) => fs.promises.stat(ZIP));
log(`${ZIP.split(path.sep).pop()} (${Math.round(size / 1024)}KB, zero dependencies)`);

// --------------------------------------------------------------------- role
step(2, "Execution role");
let roleArn = (await aws(["iam", "get-role", "--role-name", ROLE], { allowFail: true, region: "us-east-1" }))
  ?.Role?.Arn ?? null;

if (!roleArn) {
  const trust = {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
  };
  const created = await aws(["iam", "create-role", "--role-name", ROLE,
    "--assume-role-policy-document", JSON.stringify(trust),
    "--description", "Quickieweb MCP server: logs only, no data access"]);
  roleArn = created.Role.Arn;
  log(`created ${roleArn}`);
  // IAM is eventually consistent; creating a function too soon fails with an
  // unhelpful "cannot be assumed" error.
  await sleep(12000);
} else {
  log(`exists ${roleArn}`);
}

// Logs and nothing else. There is deliberately no inline policy: no bucket, no
// registry, no secret. If this list ever grows, the argument for a separate
// function has weakened and it is worth asking why.
await aws(["iam", "attach-role-policy", "--role-name", ROLE,
  "--policy-arn", "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"]);
log("policy: AWSLambdaBasicExecutionRole (logs only)");

// ----------------------------------------------------------------- function
step(3, "Function");
const env = {
  Variables: {
    QW_API_ORIGIN: API_ORIGIN,
    OAUTH_ISSUER: API_ORIGIN,
    MCP_ORIGIN: MCP_ORIGIN,
  },
};

const existing = await aws(["lambda", "get-function-configuration", "--function-name", FN],
  { allowFail: true });

if (!existing) {
  await aws(["lambda", "create-function", "--function-name", FN,
    "--runtime", "nodejs22.x", "--role", roleArn, "--handler", "server.lambdaHandler",
    "--timeout", "30", "--memory-size", "256",
    "--environment", JSON.stringify(env),
    "--zip-file", `fileb://${ZIP}`]);
  log(`created ${FN}`);
  await sleep(4000);
} else {
  await aws(["lambda", "update-function-code", "--function-name", FN, "--zip-file", `fileb://${ZIP}`]);
  await aws(["lambda", "wait", "function-updated", "--function-name", FN], { allowFail: true });
  await aws(["lambda", "update-function-configuration", "--function-name", FN,
    "--environment", JSON.stringify(env), "--handler", "server.lambdaHandler"]);
  log(`updated ${FN}`);
}

// -------------------------------------------------------------- function URL
step(4, "Function URL");
let url = (await aws(["lambda", "get-function-url-config", "--function-name", FN],
  { allowFail: true }))?.FunctionUrl ?? null;

if (!url) {
  const created = await aws(["lambda", "create-function-url-config", "--function-name", FN,
    "--auth-type", "NONE"]);
  url = created.FunctionUrl;
  log(`created ${url}`);
} else {
  log(`exists ${url}`);
}

// A PUBLIC function URL needs BOTH statements. lambda:InvokeFunctionUrl carries
// the FunctionUrlAuthType condition; lambda:InvokeFunction cannot take it and
// AddPermission rejects it if you try. With only the first you get a bare 403
// naming no missing permission, which costs an afternoon to diagnose.
for (const [sid, action, extra] of [
  ["qw-mcp-url-public", "lambda:InvokeFunctionUrl", ["--function-url-auth-type", "NONE"]],
  ["qw-mcp-invoke-public", "lambda:InvokeFunction", []],
]) {
  await aws(["lambda", "add-permission", "--function-name", FN,
    "--statement-id", sid, "--action", action,
    "--principal", "*", ...extra], { allowFail: true });
}
log("invoke permission in place (both InvokeFunctionUrl and InvokeFunction)");

console.log(`\n  function url  ${url}`);
console.log(`  api origin    ${API_ORIGIN}`);
console.log(`\nNext: node infra/provision-mcp.mjs   (${MCP_ORIGIN} in front of it)`);
