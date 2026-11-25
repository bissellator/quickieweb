#!/usr/bin/env node
// Wires the hosted stack for game rooms (Vamp Town multiplayer): players find
// each other through small JSON files under _rooms/<site>/<room>/, written and
// listed through the edge. The game itself is browser to browser (WebRTC).
//
//   node infra/wire-rooms.mjs --status   report only, change nothing
//   node infra/wire-rooms.mjs
//
// Needs, first:
//   - the tenant router that knows /__qw/rooms/ (node infra/provision-access.mjs)
//   - comments wired (node infra/wire-comments.mjs): rooms use the comment
//     ticket and reuse the comment reads' response headers policy
//   - comments turned on for the site, since that is what issues the ticket
//
// FIVE THINGS, EACH CHECKED BEFORE IT IS CHANGED
//
//   1. Live bucket policy: RoomsListFromOurDistribution (ListBucket, prefix
//      _rooms/*) and RoomsWriteFromOurDistribution (PutObject under _rooms/,
//      If-None-Match required). Merged into the policy as it stands.
//   2. Live bucket lifecycle: _rooms/ expires after a day. Other rules kept.
//   3. The room writer, infra/edge/room-writer.js: uploaded to DEVELOPMENT,
//      tested there against a ticket signed with the real secret, then
//      published to LIVE.
//   4. Origin request policies: reads forward the four list parameters the
//      router builds; writes forward the headers the writer sets.
//   5. Behaviors /__qw/rooms/* (router, never cached) and /__qw/room-post/*
//      (writer, never cached).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";
import { buildRoomWriterSource, roomWriterConfig, roomWriterName, routerName } from "./lib/edge-function.mjs";
import { signCommentTicket } from "../shared/comment-ticket.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadConfig(ROOT).catch(reportConfigError);

const STATUS_ONLY = process.argv.includes("--status");
const DIST = config.hosted?.distributionId;
const LIVE = config.hosted?.tenantLiveBucket;
const DOMAIN = config.hosted?.domain;
// infra/wire-headers.mjs names these paths too, to leave the behaviors alone.
const READ_PATH = "/__qw/rooms/*";
const WRITE_PATH = "/__qw/room-post/*";
const HEADERS_POLICY = "quickieweb-comments-headers"; // made by infra/wire-comments.mjs
const READ_POLICY = "quickieweb-room-reads";
const WRITE_POLICY = "quickieweb-room-writes";
const LIFECYCLE_ID = "qw-rooms-expire";
const SIDS = ["RoomsListFromOurDistribution", "RoomsWriteFromOurDistribution"];
const WRITE_HEADERS = ["content-type", "cache-control", "if-none-match"];
const LIST_PARAMS = ["list-type", "prefix", "start-after", "continuation-token"];

for (const [k, v] of Object.entries({ "hosted.distributionId": DIST, "hosted.tenantLiveBucket": LIVE, "hosted.domain": DOMAIN })) {
  if (!v || String(v).includes("REPLACE-ME")) {
    console.error(`FATAL: no ${k} in config.json. Run: node infra/provision-hosted.mjs`);
    process.exit(1);
  }
}

/** An AWS CLI call. `absent` names the error that means "there is none yet"; that returns null. */
async function aws(args, { absent } = {}) {
  try {
    const { stdout } = await execFileAsync("aws", [...args, "--output", "json"], { maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch (err) {
    const detail = String(err.stderr || err.message).trim();
    if (absent && absent.test(detail)) return null;
    throw new Error(`aws ${args.slice(0, 2).join(" ")} failed:\n  ${detail}`);
  }
}

const log = (s) => console.log(`    ${s}`);
const step = (n, s) => console.log(`\n[${n}] ${s}`);
const canon = (v) => Array.isArray(v)
  ? v.map(canon).sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1))
  : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
    : v;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

console.log(`distribution ${DIST}, bucket ${LIVE}${STATUS_ONLY ? "  (status only)" : ""}`);
const { Account: ACCOUNT } = await aws(["sts", "get-caller-identity"]);

// ------------------------------------------------------------ bucket policy
step(1, "Live bucket policy: list and write room files");
{
  const tpl = JSON.parse(await readFile(path.join(ROOT, "infra", "iam", "tenant-live-bucket-policy.json"), "utf8"));
  const current = await aws(["s3api", "get-bucket-policy", "--bucket", LIVE]);
  const doc = JSON.parse(current.Policy);
  let changed = 0;
  for (const sid of SIDS) {
    const want = structuredClone(tpl.Statement.find((s) => s.Sid === sid));
    if (!want) throw new Error(`the policy template has no ${sid} statement`);
    delete want["//"];
    const filled = JSON.parse(JSON.stringify(want)
      .replaceAll("__BUCKET__", LIVE).replaceAll("__ACCOUNT__", ACCOUNT).replaceAll("__DISTRIBUTION__", DIST));
    const at = doc.Statement.findIndex((s) => s.Sid === sid);
    if (at !== -1 && same(doc.Statement[at], filled)) {
      log(`${sid}: already in place`);
    } else if (STATUS_ONLY) {
      log(`${sid}: ${at === -1 ? "MISSING" : "DIFFERS from the template"}`);
    } else {
      if (at === -1) doc.Statement.push(filled); else doc.Statement[at] = filled;
      log(`${sid}: ${at === -1 ? "adding" : "updating"}`);
      changed++;
    }
  }
  if (changed) {
    await aws(["s3api", "put-bucket-policy", "--bucket", LIVE, "--policy", JSON.stringify(doc)]);
    log(`written; ${doc.Statement.length} statements`);
  }
}

// ---------------------------------------------------------------- lifecycle
step(2, "Live bucket lifecycle: room files expire after a day");
{
  const current = await aws(["s3api", "get-bucket-lifecycle-configuration", "--bucket", LIVE], { absent: /NoSuchLifecycleConfiguration/ });
  const rules = current?.Rules ?? [];
  const want = { ID: LIFECYCLE_ID, Status: "Enabled", Filter: { Prefix: "_rooms/" }, Expiration: { Days: 1 } };
  const at = rules.findIndex((r) => r.ID === LIFECYCLE_ID);
  if (at !== -1 && same(rules[at], want)) {
    log(`${LIFECYCLE_ID}: already in place`);
  } else if (STATUS_ONLY) {
    log(`${LIFECYCLE_ID}: ${at === -1 ? "MISSING" : "DIFFERS"}`);
  } else {
    const next = at === -1 ? [...rules, want] : rules.map((r, i) => (i === at ? want : r));
    await aws(["s3api", "put-bucket-lifecycle-configuration", "--bucket", LIVE, "--lifecycle-configuration", JSON.stringify({ Rules: next })]);
    log(`${LIFECYCLE_ID}: ${at === -1 ? "added" : "updated"}; ${next.length} rule(s)`);
  }
}

// ------------------------------------------------------------------- writer
step(3, "Room writer function");
const WRITER = roomWriterName(DOMAIN);
let writerArn = null;
{
  const router = await aws(["cloudfront", "describe-function", "--name", routerName(DOMAIN), "--stage", "LIVE"]);
  const kvsArn = router.FunctionSummary?.FunctionConfig?.KeyValueStoreAssociations?.Items?.[0]?.KeyValueStoreARN;
  if (!kvsArn) throw new Error(`${routerName(DOMAIN)} has no edge store. Run: node infra/provision-access.mjs`);

  const src = await buildRoomWriterSource(ROOT, DOMAIN);
  const live = await aws(["cloudfront", "describe-function", "--name", WRITER, "--stage", "LIVE"], { absent: /NoSuchFunctionExists/ });
  const liveCode = live ? await functionCode(WRITER, "LIVE") : null;
  const upToDate = liveCode === src && live?.FunctionSummary?.FunctionConfig?.KeyValueStoreAssociations?.Items?.[0]?.KeyValueStoreARN === kvsArn;

  if (upToDate) {
    log(`LIVE is current (${Buffer.byteLength(src)} bytes)`);
    writerArn = live.FunctionSummary.FunctionMetadata.FunctionARN;
  } else if (STATUS_ONLY) {
    log(live ? "LIVE DIFFERS from infra/edge/room-writer.js" : "MISSING");
    writerArn = live?.FunctionSummary?.FunctionMetadata?.FunctionARN ?? null;
  } else {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "qw-room-writer-"));
    try {
      const file = path.join(tmp, "writer.js");
      await writeFile(file, src);
      const dev = await aws(["cloudfront", "describe-function", "--name", WRITER, "--stage", "DEVELOPMENT"], { absent: /NoSuchFunctionExists/ });
      const args = ["--function-config", JSON.stringify(roomWriterConfig(DOMAIN, kvsArn)), "--function-code", `fileb://${file}`];
      const res = dev
        ? await aws(["cloudfront", "update-function", "--name", WRITER, "--if-match", dev.ETag, ...args])
        : await aws(["cloudfront", "create-function", "--name", WRITER, ...args]);
      log(`DEVELOPMENT ${dev ? "updated" : "created"} (${Buffer.byteLength(src)} bytes)`);
      await testWriter(tmp, res.ETag, kvsArn);
      const pub = await aws(["cloudfront", "publish-function", "--name", WRITER, "--if-match", res.ETag]);
      writerArn = pub.FunctionSummary.FunctionMetadata.FunctionARN;
      log("published to LIVE");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}

async function functionCode(name, stage) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "qw-fn-"));
  try {
    const out = path.join(tmp, "code.js");
    await execFileAsync("aws", ["cloudfront", "get-function", "--name", name, "--stage", stage, out]);
    return await readFile(out, "utf8");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Run DEVELOPMENT against real requests, with a ticket signed by the store's own secret. */
async function testWriter(tmp, etag, kvsArn) {
  const secret = (await aws(["cloudfront-keyvaluestore", "get-key", "--kvs-arn", kvsArn, "--key", "_secret"])).Value;
  const now = Date.now();
  const t = signCommentTicket({ siteId: "www", pending: false, uid: "0000000000000000", name: "Edge test", secret, now, ttlSec: 300 });
  const other = signCommentTicket({ siteId: "www", pending: false, uid: "1111111111111111", name: "Other", secret, now, ttlSec: 300 });
  const stampOf = (ms) => new Date(ms).toISOString().replace(/[-:.]/g, "");
  const name = `${stampOf(now)}-0000000000000000-edgetest.json`;
  const req = (method, uri, ticket, length = "50") => ({
    method, uri, querystring: {}, cookies: {},
    headers: {
      host: { value: DOMAIN },
      "content-length": { value: length },
      ...(ticket ? { "x-qw-ticket": { value: ticket } } : {}),
      "x-amz-acl": { value: "public-read" },
    },
  });
  const cases = [
    { why: "a presence write", request: req("PUT", `/__qw/room-post/edge-test/here/${name}`, t.token),
      want: { uri: `/_rooms/www/edge-test/here/${name}`, ifNoneMatch: "*", uid: "0000000000000000", acl: undefined } },
    { why: "a signal write", request: req("PUT", `/__qw/room-post/edge-test/sig/1111111111111111/${name}`, t.token),
      want: { uri: `/_rooms/www/edge-test/sig/1111111111111111/${name}`, ifNoneMatch: "*" } },
    { why: "someone else's uid", request: req("PUT", `/__qw/room-post/edge-test/here/${name}`, other.token), want: { status: 403 } },
    { why: "no ticket", request: req("PUT", `/__qw/room-post/edge-test/here/${name}`, null), want: { status: 403 } },
    { why: "too big", request: req("PUT", `/__qw/room-post/edge-test/here/${name}`, t.token, "20000"), want: { status: 413 } },
    { why: "not a PUT", request: req("GET", `/__qw/room-post/edge-test/here/${name}`, t.token), want: { status: 405 } },
    { why: "outside a room", request: req("PUT", `/__qw/room-post/../here/${name}`, t.token), want: { status: 404 } },
  ];
  let failed = 0;
  for (const c of cases) {
    const ev = path.join(tmp, "event.json");
    await writeFile(ev, JSON.stringify({ version: "1.0", context: { eventType: "viewer-request" }, viewer: { ip: "198.51.100.1" }, request: c.request }));
    const out = await aws(["cloudfront", "test-function", "--name", WRITER, "--if-match", etag, "--stage", "DEVELOPMENT", "--event-object", `fileb://${ev}`]);
    const r = out.TestResult ?? {};
    if (r.FunctionErrorMessage) { failed++; log(`FAIL ${c.why}: ${r.FunctionErrorMessage}`); continue; }
    const o = JSON.parse(r.FunctionOutput ?? "{}");
    const got = o.response
      ? { status: o.response.statusCode }
      : {
          uri: o.request?.uri, ifNoneMatch: o.request?.headers?.["if-none-match"]?.value,
          uid: o.request?.headers?.["x-amz-meta-uid"]?.value, acl: o.request?.headers?.["x-amz-acl"]?.value,
        };
    const ok = Object.entries(c.want).every(([k, v]) => got[k] === v);
    if (!ok) failed++;
    log(`${ok ? "ok  " : "FAIL"} ${c.why} -> ${JSON.stringify(got)}  (${r.ComputeUtilization}% compute)`);
  }
  if (failed) throw new Error(`${failed} room writer test(s) failed on DEVELOPMENT; LIVE is untouched`);
}

// ----------------------------------------------------------------- policies
async function findPolicy(kind, name) {
  const listCmd = { headers: "list-response-headers-policies", origin: "list-origin-request-policies" }[kind];
  const listed = await aws(["cloudfront", listCmd, "--type", "custom"]);
  const items = kind === "headers"
    ? (listed.ResponseHeadersPolicyList?.Items ?? []).map((i) => ({ id: i.ResponseHeadersPolicy.Id, name: i.ResponseHeadersPolicy.ResponseHeadersPolicyConfig.Name }))
    : (listed.OriginRequestPolicyList?.Items ?? []).map((i) => ({ id: i.OriginRequestPolicy.Id, name: i.OriginRequestPolicy.OriginRequestPolicyConfig.Name }));
  return items.find((i) => i.name === name) ?? null;
}

/** Create or update an origin request policy; returns its id (null if missing in --status). */
async function upsertOriginPolicy(want) {
  const found = await findPolicy("origin", want.Name);
  if (STATUS_ONLY) {
    log(found ? `${want.Name}: exists ${found.id}` : `${want.Name}: MISSING`);
    return found?.id ?? null;
  }
  if (!found) {
    const res = await aws(["cloudfront", "create-origin-request-policy", "--origin-request-policy-config", JSON.stringify(want)]);
    log(`${want.Name}: created ${res.OriginRequestPolicy.Id}`);
    return res.OriginRequestPolicy.Id;
  }
  const current = await aws(["cloudfront", "get-origin-request-policy", "--id", found.id]);
  await aws(["cloudfront", "update-origin-request-policy", "--id", found.id, "--if-match", current.ETag, "--origin-request-policy-config", JSON.stringify(want)]);
  log(`${want.Name}: updated ${found.id}`);
  return found.id;
}

step(4, "Origin request policies");
const headers = await findPolicy("headers", HEADERS_POLICY);
if (!headers) throw new Error(`no ${HEADERS_POLICY} response headers policy. Run: node infra/wire-comments.mjs`);
const readPolicyId = await upsertOriginPolicy({
  Name: READ_POLICY,
  Comment: "Room reads: the four list parameters the tenant router builds, nothing else",
  HeadersConfig: { HeaderBehavior: "none" },
  CookiesConfig: { CookieBehavior: "none" },
  QueryStringsConfig: { QueryStringBehavior: "whitelist", QueryStrings: { Quantity: LIST_PARAMS.length, Items: LIST_PARAMS } },
});
const writePolicyId = await upsertOriginPolicy({
  Name: WRITE_POLICY,
  Comment: "Room writes: only the headers the room writer sets reach S3",
  HeadersConfig: { HeaderBehavior: "whitelist", Headers: { Quantity: WRITE_HEADERS.length, Items: WRITE_HEADERS } },
  CookiesConfig: { CookieBehavior: "none" },
  QueryStringsConfig: { QueryStringBehavior: "none" },
});

// ---------------------------------------------------------------- behaviors
step(5, `Behaviors ${READ_PATH} and ${WRITE_PATH}`);
{
  const dist = await aws(["cloudfront", "get-distribution-config", "--id", DIST]);
  const cfg = dist.DistributionConfig;
  const def = cfg.DefaultCacheBehavior;
  const router = (def.FunctionAssociations?.Items ?? []).find((f) => f.EventType === "viewer-request");
  if (!router) throw new Error("the default behavior has no viewer-request function -- is this the hosted distribution?");

  const managed = await aws(["cloudfront", "list-cache-policies", "--type", "managed"]);
  const noCache = (managed.CachePolicyList?.Items ?? []).find((i) => i.CachePolicy.CachePolicyConfig.Name === "Managed-CachingDisabled");
  if (!noCache) throw new Error("CloudFront's managed CachingDisabled policy was not found");

  const base = {
    TargetOriginId: def.TargetOriginId,
    TrustedSigners: { Enabled: false, Quantity: 0 },
    TrustedKeyGroups: { Enabled: false, Quantity: 0 },
    ViewerProtocolPolicy: "redirect-to-https",
    SmoothStreaming: false,
    LambdaFunctionAssociations: { Quantity: 0 },
    FieldLevelEncryptionId: "",
    ResponseHeadersPolicyId: headers.id,
    // Signals are found by polling: a cached list would hide a new one.
    CachePolicyId: noCache.CachePolicy.Id,
  };
  const wants = [
    {
      ...base,
      PathPattern: READ_PATH,
      AllowedMethods: { Quantity: 2, Items: ["GET", "HEAD"], CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] } },
      Compress: true,
      FunctionAssociations: { Quantity: 1, Items: [router] },
      OriginRequestPolicyId: readPolicyId ?? "(created on the real run)",
    },
    {
      ...base,
      PathPattern: WRITE_PATH,
      AllowedMethods: {
        Quantity: 7, Items: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
        CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
      },
      Compress: false,
      FunctionAssociations: { Quantity: 1, Items: [{ EventType: "viewer-request", FunctionARN: writerArn ?? "(created on the real run)" }] },
      OriginRequestPolicyId: writePolicyId ?? "(created on the real run)",
    },
  ];

  const pick = (b) => ({
    origin: b.TargetOriginId, fn: b.FunctionAssociations?.Items?.[0]?.FunctionARN,
    cache: b.CachePolicyId, request: b.OriginRequestPolicyId ?? null, headers: b.ResponseHeadersPolicyId,
    methods: b.AllowedMethods?.Items,
  });
  let items = cfg.CacheBehaviors?.Items ?? [];
  let changed = 0;
  for (const want of wants) {
    const at = items.findIndex((b) => b.PathPattern === want.PathPattern);
    if (at !== -1 && same(pick(items[at]), pick(want))) {
      log(`${want.PathPattern}: already in place`);
    } else if (STATUS_ONLY) {
      log(`${want.PathPattern}: ${at === -1 ? "MISSING" : "DIFFERS"}`);
    } else {
      items = at === -1 ? [...items, want] : items.map((b, i) => (i === at ? { ...b, ...want } : b));
      log(`${want.PathPattern}: ${at === -1 ? "adding" : "updating"}`);
      changed++;
    }
  }
  if (changed) {
    cfg.CacheBehaviors = { Quantity: items.length, Items: items };
    await aws(["cloudfront", "update-distribution", "--id", DIST, "--if-match", dist.ETag, "--distribution-config", JSON.stringify(cfg)]);
    log("distribution updated; CloudFront takes a few minutes to deploy");
  }
}

console.log(STATUS_ONLY ? "\nstatus only, nothing changed." : "\ndone.");
