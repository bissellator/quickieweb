#!/usr/bin/env node
// Build a deployable zip for the admin Lambda.
//
//   node infra/build-lambda.mjs
//   node infra/build-lambda.mjs --fresh    force a clean npm install
//
// Replaces infra/build-lambda.sh. Same output, but bash and its heredocs are
// unreliable on the Windows box this is built from, and the .sh version failed
// there in ways that looked like a code bug rather than a shell bug.
//
// Produces ./infra/<deploy.functionName>.zip with:
//   - server.mjs, package.json (handler = server.handler, native Function URL)
//   - shared/**, so the Lambda renders byte-identical HTML to the local build
//   - admin/lib/
//   - production node_modules including the LINUX x64 sharp binary
//
// NOT admin/ui/. The admin UI is static objects in S3 now and the Lambda does
// not serve it; bundling it would ship a 1.3 MB vendored CKEditor into a
// function that never reads it.
//
// No credentials go in the bundle. The Lambda reads S3 through its execution
// role and takes bucket names and secrets from environment variables.

import { rm, mkdir, cp, readFile, writeFile, readdir, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = path.join(ROOT, "infra", "lambda-build");
// The zip is named after the function so build and deploy cannot disagree about
// which artifact they mean when the function is renamed in config.json.
const config = await loadConfig(ROOT).catch(reportConfigError);
const ZIP = path.join(ROOT, "infra", `${config.deploy.functionName || "qw-admin"}.zip`);
const FRESH = process.argv.includes("--fresh");

const step = (n, s) => console.log(`\n[${n}] ${s}`);
const log = (s) => console.log(`    ${s}`);
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

// npm install of sharp is slow and the result is platform-pinned, so the
// installed node_modules is reused -- but only while admin/package.json says
// what it said when they were installed. Reusing them across a dependency change
// used to ship a bundle missing the new package, and the Lambda then failed on
// its first import, after the deploy had already reported success.
const DEPS_STAMP = path.join(BUILD, ".deps.json");
const deps = JSON.stringify(JSON.parse(await readFile(path.join(ROOT, "admin", "package.json"), "utf8")).dependencies ?? {});
const stamped = await readFile(DEPS_STAMP, "utf8").catch((err) => {
  if (err.code === "ENOENT") return null;
  throw err;
});
const haveModules = !FRESH && stamped === deps
  && await exists(path.join(BUILD, "node_modules", "@img", "sharp-linux-x64"));
if (!FRESH && stamped !== null && stamped !== deps) console.log("admin/package.json dependencies changed -- reinstalling");

step(1, "Clean build dir");
if (haveModules) {
  for (const entry of await readdir(BUILD)) {
    if (entry !== "node_modules" && entry !== ".deps.json") await rm(path.join(BUILD, entry), { recursive: true, force: true });
  }
  log("kept node_modules (pass --fresh to reinstall)");
} else {
  await rm(BUILD, { recursive: true, force: true });
  log("full clean");
}
await rm(ZIP, { force: true });
await mkdir(path.join(BUILD, "lib"), { recursive: true });
await mkdir(path.join(BUILD, "shared"), { recursive: true });

step(2, "Copy runtime files");
await cp(path.join(ROOT, "admin", "server.mjs"), path.join(BUILD, "server.mjs"));
await cp(path.join(ROOT, "admin", "package.json"), path.join(BUILD, "package.json"));
for (const f of (await readdir(path.join(ROOT, "admin", "lib"))).filter((f) => f.endsWith(".mjs"))) {
  await cp(path.join(ROOT, "admin", "lib", f), path.join(BUILD, "lib", f));
}
// The whole shared/ tree, not one file: the renderer, the template engine and
// the content model all live there and import each other relatively, so copying
// the directory keeps those imports intact.
await cp(path.join(ROOT, "shared"), path.join(BUILD, "shared"), { recursive: true });
log("server.mjs, package.json, lib/*.mjs, shared/** (no ui/)");

// server.mjs imports ../shared/*, which does not survive zipping: the zip root
// is BUILD and Lambda extracts to /var/task, so shared/ has to sit inside and
// every import of it has to be rewritten to match.
step(3, "Rewrite the shared imports");
const serverPath = path.join(BUILD, "server.mjs");
const before = await readFile(serverPath, "utf8");
const rewritten = before.replace(/from "\.\.\/shared\//g, 'from "./shared/');
await writeFile(serverPath, rewritten);
const expected = (before.match(/from "\.\.\/shared\//g) ?? []).length;
if (expected === 0 || rewritten.includes('from "../shared/')) {
  throw new Error("shared import rewrite failed -- the Lambda would crash on cold start.");
}

// lib/*.mjs reaches shared/ as ../../shared/ from admin/lib/. In the bundle
// lib/ sits one level below the zip root, so the same path would climb out of
// /var/task entirely.
let libRewrites = 0;
for (const f of (await readdir(path.join(BUILD, "lib"))).filter((f) => f.endsWith(".mjs"))) {
  const at = path.join(BUILD, "lib", f);
  const src = await readFile(at, "utf8");
  if (!src.includes('from "../../shared/')) continue;
  const out = src.replace(/from "\.\.\/\.\.\/shared\//g, 'from "../shared/');
  await writeFile(at, out);
  libRewrites++;
}
log(`rewrote ${expected} import(s) in server.mjs and ${libRewrites} lib file(s)`);

step(4, "Production install with the LINUX x64 sharp binary");
if (haveModules) {
  log("skipped, reusing the existing linux binary");
} else {
  // --os/--cpu/--libc force npm to fetch @img/sharp-linux-x64 even though this
  // build usually runs on Windows.
  await execFileAsync("npm", ["install", "--omit=dev", "--os=linux", "--cpu=x64",
    "--libc=glibc", "--no-audit", "--no-fund"],
    { cwd: BUILD, shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024 });
  await writeFile(DEPS_STAMP, deps);
  log("installed");
}

// Every declared dependency must actually be there, whichever path got here.
for (const name of Object.keys(JSON.parse(deps))) {
  if (!await exists(path.join(BUILD, "node_modules", ...name.split("/"), "package.json"))) {
    throw new Error(`${name} is declared in admin/package.json but missing from the bundle -- rerun with --fresh.`);
  }
}

if (!await exists(path.join(BUILD, "node_modules", "@img", "sharp-linux-x64"))) {
  throw new Error("@img/sharp-linux-x64 missing -- Lambda would crash on require('sharp').");
}
log("verified @img/sharp-linux-x64");

step(5, "Zip");
const { stdout } = await execFileAsync("python",
  [path.join(ROOT, "infra", "zip-lambda.py"), BUILD, ZIP],
  { shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024 });
log(stdout.trim());

console.log(`\nDeploy with: node infra/deploy-lambda.mjs`);
