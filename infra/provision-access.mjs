#!/usr/bin/env node
// Reader access for hosted sites: the edge store, its signing secret, and the
// tenant router that enforces them.
//
//   node infra/provision-access.mjs              store + secret, router to DEVELOPMENT
//   node infra/provision-access.mjs --test       ...then run the DEVELOPMENT router against sample requests
//   node infra/provision-access.mjs --publish    ...then promote DEVELOPMENT to LIVE
//   node infra/provision-access.mjs --status     report only, change nothing
//
// WHAT THIS BUILDS
//
//   <apex>-access      a CloudFront KeyValueStore. Per protected site it holds the
//                      default reading level and any per-page level; plus
//                      `_secret`, the HMAC key for access tokens. Written by the
//                      admin Lambda (admin/lib/access-edge.mjs) on publish.
//   <apex>-tenant-router   updated to the access-aware version and associated
//                      with the store.
//
// WHY THE ROUTER GOES TO DEVELOPMENT FIRST
//
// It serves every site on the platform. CloudFront keeps a DEVELOPMENT and a LIVE
// stage per function, and only LIVE is attached to the distribution, so a
// DEVELOPMENT upload changes nothing for readers. --test exercises that stage
// against real requests with the real store; --publish is the separate, explicit
// step that changes what readers get.
//
// The secret is generated here, once, and never printed or written to disk or
// config.json. The Lambda reads it from the store at run time.
//
// Order on a fresh install: provision-hosted-dns, THIS, then provision-hosted
// (which refuses to upload the router without a store). On an existing install
// this updates the router in place. Every step checks first; re-running is safe.

import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";
import { buildRouterSource, routerConfig, routerName } from "./lib/edge-function.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "config.json");
const config = await loadConfig(ROOT).catch(reportConfigError);

const argv = process.argv.slice(2);
const STATUS_ONLY = argv.includes("--status");
const TEST = argv.includes("--test") || argv.includes("--publish");
const PUBLISH = argv.includes("--publish");

const DOMAIN = config.hosted?.domain;
if (!DOMAIN || DOMAIN.includes("REPLACE-ME")) {
  console.error("FATAL: config.hosted.domain is not set.");
  process.exit(1);
}
const STORE = `${DOMAIN.split(".")[0]}-access`;
const FUNCTION = routerName(DOMAIN);

const step = (n, s) => console.log(`\n[${n}] ${s}`);
const log = (s) => console.log(`    ${s}`);

const NOT_FOUND = /NoSuchResource|EntityNotFound|ResourceNotFound|NoSuchFunctionExists|does not exist|not found/i;

/** Run the AWS CLI. `missingOk` turns a genuine not-found into null; every other failure throws. */
async function aws(args, { missingOk = false } = {}) {
  try {
    const { stdout } = await execFileAsync("aws", [...args, "--region", "us-east-1", "--output", "json"], { maxBuffer: 16e6 });
    return stdout.trim() ? JSON.parse(stdout) : {};
  } catch (err) {
    const msg = String(err.stderr || err.message).trim();
    if (missingOk && NOT_FOUND.test(msg)) return null;
    throw new Error(`aws ${args.slice(0, 2).join(" ")} failed:\n  ${msg}`);
  }
}

const tmp = await mkdtemp(path.join(os.tmpdir(), "qw-access-"));
try {
  console.log(`reader access for ${DOMAIN}${STATUS_ONLY ? "  (status only)" : ""}`);

  // ---------------------------------------------------------------- store
  step(1, `Edge store "${STORE}"`);
  let store = (await aws(["cloudfront", "describe-key-value-store", "--name", STORE], { missingOk: true }))?.KeyValueStore;
  if (!store && STATUS_ONLY) {
    log("MISSING");
  } else if (!store) {
    store = (await aws(["cloudfront", "create-key-value-store", "--name", STORE,
      "--comment", `${DOMAIN}: who may read which page`])).KeyValueStore;
    log("created, waiting for it to be ready");
    for (let i = 0; store.Status !== "READY"; i++) {
      if (i > 60) throw new Error(`the store is still ${store.Status} after 5 minutes`);
      await new Promise((r) => setTimeout(r, 5000));
      store = (await aws(["cloudfront", "describe-key-value-store", "--name", STORE])).KeyValueStore;
    }
  }
  if (store) {
    log(`${store.Status}  ${store.ARN}`);
    if (!STATUS_ONLY && config.hosted.accessKvsArn !== store.ARN) {
      config.hosted.accessKvsArn = store.ARN;
      await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
      log("recorded in config.json (hosted.accessKvsArn)");
    }
  }

  // ---------------------------------------------------------------- secret
  step(2, "Signing secret");
  if (!store) {
    log("skipped: no store");
  } else {
    const have = await aws(["cloudfront-keyvaluestore", "get-key", "--kvs-arn", store.ARN, "--key", "_secret"], { missingOk: true });
    if (have) {
      log("exists (kept: replacing it would sign every reader out)");
    } else if (STATUS_ONLY) {
      log("MISSING");
    } else {
      const { ETag } = await aws(["cloudfront-keyvaluestore", "describe-key-value-store", "--kvs-arn", store.ARN]);
      await aws(["cloudfront-keyvaluestore", "put-key", "--kvs-arn", store.ARN,
        "--key", "_secret", "--value", randomBytes(32).toString("hex"), "--if-match", ETag]);
      log("generated and stored (not shown, not written anywhere else)");
    }
  }

  // -------------------------------------------------------------- function
  step(3, `Router "${FUNCTION}"`);
  const fn = await aws(["cloudfront", "describe-function", "--name", FUNCTION, "--stage", "DEVELOPMENT"], { missingOk: true });
  let etag = fn?.ETag ?? null;
  if (!fn) {
    log("MISSING -- run infra/provision-hosted.mjs to create it (it will associate this store)");
  } else if (STATUS_ONLY) {
    const assoc = fn.FunctionSummary?.FunctionConfig?.KeyValueStoreAssociations?.Items ?? [];
    log(assoc.some((a) => a.KeyValueStoreARN === store?.ARN) ? "DEVELOPMENT is associated with the store" : "DEVELOPMENT is NOT associated with the store");
  } else {
    const src = await buildRouterSource(ROOT, DOMAIN);
    const file = path.join(tmp, "router.js");
    await writeFile(file, src);
    const res = await aws(["cloudfront", "update-function", "--name", FUNCTION, "--if-match", etag,
      "--function-config", JSON.stringify(routerConfig(DOMAIN, store.ARN)),
      "--function-code", `fileb://${file}`]);
    etag = res.ETag;
    log(`DEVELOPMENT updated (${Buffer.byteLength(src)} bytes), associated with the store; LIVE untouched`);
  }

  // ------------------------------------------------------------------ test
  if (TEST && fn && !STATUS_ONLY) {
    step(4, "Test the DEVELOPMENT stage");
    // Hosts and paths whose answer does not depend on any site being protected,
    // so this is safe to run on a platform with no protected sites yet -- and it
    // proves the function can reach the store, which is the risky part.
    const cases = [
      { host: DOMAIN, uri: "/", want: { uri: "/sites/www/index.html" } },
      { host: `www.${DOMAIN}`, uri: "/x", want: { status: 301 } },
      { host: `app.${DOMAIN}`, uri: "/", want: { uri: "/admin/index.html" } },
      { host: "example.com", uri: "/", want: { status: 404 } },
      ...(argv.includes("--site") ? [{ host: `${argv[argv.indexOf("--site") + 1]}.${DOMAIN}`, uri: "/", want: null }] : []),
    ];
    let failed = 0;
    for (const c of cases) {
      const ev = path.join(tmp, "event.json");
      await writeFile(ev, JSON.stringify({
        version: "1.0", context: { eventType: "viewer-request" },
        viewer: { ip: "198.51.100.1" },
        request: { method: "GET", uri: c.uri, querystring: {}, headers: { host: { value: c.host } }, cookies: {} },
      }));
      const out = await aws(["cloudfront", "test-function", "--name", FUNCTION, "--if-match", etag,
        "--stage", "DEVELOPMENT", "--event-object", `fileb://${ev}`]);
      const r = out.TestResult ?? {};
      if (r.FunctionErrorMessage) {
        failed++;
        log(`FAIL ${c.host}${c.uri}: ${r.FunctionErrorMessage}`);
        continue;
      }
      const o = JSON.parse(r.FunctionOutput ?? "{}");
      const got = o.response ? { status: o.response.statusCode, location: o.response.headers?.location?.value } : { uri: o.request?.uri };
      const ok = !c.want || Object.entries(c.want).every(([k, v]) => got[k] === v);
      if (!ok) failed++;
      log(`${ok ? "ok  " : "FAIL"} ${c.host}${c.uri} -> ${JSON.stringify(got)}  (${r.ComputeUtilization}% compute)`);
    }
    if (failed) {
      console.error(`\n${failed} case(s) failed. LIVE is untouched; fix and re-run.`);
      process.exit(1);
    }
  }

  // --------------------------------------------------------------- publish
  if (PUBLISH && fn && !STATUS_ONLY) {
    step(5, "Publish DEVELOPMENT to LIVE");
    const res = await aws(["cloudfront", "publish-function", "--name", FUNCTION, "--if-match", etag]);
    log(`LIVE now runs the access-aware router (${res.FunctionSummary?.FunctionMetadata?.Stage})`);
  } else if (fn && !STATUS_ONLY) {
    console.log(`\nLIVE is unchanged. When the tests pass: node infra/provision-access.mjs --publish`);
  }

  if (!STATUS_ONLY && store) {
    console.log("Then redeploy the admin Lambda so it can write to the store: node infra/deploy-lambda.mjs");
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}
