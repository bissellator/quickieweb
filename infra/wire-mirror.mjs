#!/usr/bin/env node
// Serve one hosted site from a distribution of its own -- a custom domain.
//
//   node infra/wire-mirror.mjs --site acme --distribution E123ABC --dry-run
//   node infra/wire-mirror.mjs --site acme --distribution E123ABC \
//        [--base-url https://www.acme.com] [--function path/to/viewer-request.js]
//   node infra/wire-mirror.mjs --rollback .mirror-backups/E123ABC-<time>.json
//
// The distribution keeps its aliases and certificate (the domain's DNS keeps
// pointing at it). What changes:
//
//   origin   the shared live bucket over OAC, with origin path /sites/<site>
//   function a viewer-request function: infra/edge/mirror-router.js, or --function
//   errors   403/404 -> /404.html (the site's own, since the origin path is its prefix)
//   root     index.html
//
// And around it:
//
//   config.json      hosted.mirrors gets { distributionId, prefix, siteId }
//   live bucket      the mirror may read sites/<site>/* and nothing else
//                    (infra/lib/mirror-policy.mjs, also applied by provision-hosted)
//   site record      storage.mirrorDistributionIds, so publish invalidates it;
//                    site.baseUrl/domain when --base-url is given
//
// Then re-run infra/deploy-lambda.mjs: the Lambda role may only invalidate the
// distributions it lists, and this adds one.
//
// Before anything is changed the distribution's current config is written to
// .mirror-backups/<id>-<time>.json; --rollback puts it back exactly (the bucket
// grant and record entry are left in place -- harmless without the origin).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";
import { checkSiteId, normalizeSite, siteKeyFor } from "../shared/site.mjs";
import { hostedSettings, readJsonOrNull } from "./lib/seed-site.mjs";
import { withMirrors } from "./lib/mirror-policy.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "config.json");
const BACKUPS = path.join(ROOT, ".mirror-backups");

const argv = process.argv.slice(2);
const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const DRY = argv.includes("--dry-run");

const config = await loadConfig(ROOT).catch(reportConfigError);
const settings = hostedSettings(config);
const aws = async (args, region = settings.region) =>
  (await execFileAsync("aws", [...args, "--region", region, "--output", "json"], { maxBuffer: 64e6 })).stdout;
const cf = async (args) => JSON.parse((await aws(["cloudfront", ...args], "us-east-1")) || "{}");
const log = (s) => console.log(`    ${s}`);
const step = (n, s) => console.log(`\n[${n}] ${s}`);
const tmp = await mkdtemp(path.join(os.tmpdir(), "qw-mirror-"));

try {
  // ---------------------------------------------------------------- rollback
  const ROLLBACK = flag("--rollback");
  if (ROLLBACK) {
    const saved = JSON.parse(await readFile(ROLLBACK, "utf8"));
    const { ETag } = await cf(["get-distribution-config", "--id", saved.id]);
    const f = path.join(tmp, "cfg.json");
    await writeFile(f, JSON.stringify(saved.config));
    if (DRY) { console.log(`would restore ${saved.id} from ${ROLLBACK}`); process.exit(0); }
    await cf(["update-distribution", "--id", saved.id, "--if-match", ETag, "--distribution-config", `file://${f}`]);
    console.log(`restored ${saved.id} from ${ROLLBACK}; it takes a few minutes to deploy.`);
    process.exit(0);
  }

  const SITE = flag("--site");
  const DIST = flag("--distribution");
  const BASE_URL = flag("--base-url");
  const FUNCTION = flag("--function");
  if (!SITE || !DIST || checkSiteId(SITE)) {
    console.error("usage: node infra/wire-mirror.mjs --site <id> --distribution <id> [--base-url https://...] [--function file.js] [--dry-run]");
    process.exit(1);
  }
  if (BASE_URL && !/^https:\/\/[a-z0-9.-]+$/.test(BASE_URL)) {
    console.error(`FATAL: --base-url must be https://<host> with no path, got "${BASE_URL}"`);
    process.exit(1);
  }
  if (DIST === config.hosted?.distributionId) {
    console.error("FATAL: that is the shared distribution; a mirror must be a distribution of the site's own.");
    process.exit(1);
  }

  // ------------------------------------------------------------------ the site
  step(1, `Site "${SITE}"`);
  const raw = await readJsonOrNull((a) => aws(a), `s3://${settings.platformBucket}/${siteKeyFor(SITE)}`);
  if (!raw) { console.error(`FATAL: no site "${SITE}" in the registry.`); process.exit(1); }
  const site = normalizeSite(raw);
  if (site.storage.driver !== "prefix") { console.error("FATAL: only prefix-driver sites are mirrored."); process.exit(1); }
  const prefix = site.storage.prefix;
  log(`prefix ${prefix} in ${site.storage.liveBucket}`);

  // ---------------------------------------------------------------- the distribution
  step(2, `Distribution ${DIST}`);
  const { ETag, DistributionConfig: current } = await cf(["get-distribution-config", "--id", DIST]);
  log(`aliases ${(current.Aliases?.Items ?? []).join(", ") || "(none)"}`);
  log(`origin now ${current.Origins.Items.map((o) => `${o.DomainName}${o.OriginPath}`).join(", ")}`);
  if (!DRY) {
    await mkdir(BACKUPS, { recursive: true });
    const backup = path.join(BACKUPS, `${DIST}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    await writeFile(backup, JSON.stringify({ id: DIST, config: current }, null, 2));
    log(`backed up to ${path.relative(ROOT, backup)}  (--rollback <that file> restores it)`);
  }

  const account = JSON.parse(await aws(["sts", "get-caller-identity"])).Account;

  // ---------------------------------------------------------------- bucket policy
  // Before the origin moves: a mirror that cannot read yet would serve 403s.
  step(3, "Live bucket policy");
  const mirrors = (config.hosted.mirrors ?? []).filter((m) => m.distributionId !== DIST);
  mirrors.push({ distributionId: DIST, prefix, siteId: SITE });
  const tpl = await readFile(path.join(ROOT, "infra", "iam", "tenant-live-bucket-policy.json"), "utf8");
  let doc = JSON.parse(tpl.replaceAll("__BUCKET__", site.storage.liveBucket).replaceAll("__ACCOUNT__", account)
    .replaceAll("__DISTRIBUTION__", config.hosted.distributionId));
  delete doc["//"];
  for (const st of doc.Statement) delete st["//"];
  doc = withMirrors(doc, { bucket: site.storage.liveBucket, account, mirrors });
  log(`${doc.Statement.length} statements; ${DIST} may read ${prefix}* only`);
  if (!DRY) {
    await aws(["s3api", "put-bucket-policy", "--bucket", site.storage.liveBucket, "--policy", JSON.stringify(doc)]);
    config.hosted.mirrors = mirrors;
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
    log("applied; config.json hosted.mirrors updated");
  }

  // ---------------------------------------------------------------- OAC
  step(4, "Origin access control");
  const OAC_NAME = "qw-mirror-oac";
  const oacs = await cf(["list-origin-access-controls"]);
  let oac = (oacs.OriginAccessControlList?.Items ?? []).find((o) => o.Name === OAC_NAME);
  if (oac) log(`exists ${oac.Id}`);
  else if (DRY) log(`would create ${OAC_NAME}`);
  else {
    oac = (await cf(["create-origin-access-control", "--origin-access-control-config",
      JSON.stringify({ Name: OAC_NAME, Description: "Custom-domain mirrors of hosted sites", SigningProtocol: "sigv4",
        SigningBehavior: "always", OriginAccessControlOriginType: "s3" })])).OriginAccessControl;
    oac = { Id: oac.Id };
    log(`created ${oac.Id}`);
  }

  // ---------------------------------------------------------------- function
  step(5, "Viewer-request function");
  const fnName = `qw-mirror-${SITE}`.slice(0, 64);
  const fnFile = FUNCTION ? path.resolve(FUNCTION) : path.join(ROOT, "infra", "edge", "mirror-router.js");
  const code = await readFile(fnFile, "utf8");
  if (Buffer.byteLength(code) > 10240) { console.error(`FATAL: ${fnFile} is over CloudFront's 10 KB function limit.`); process.exit(1); }
  let fnArn = null;
  if (DRY) log(`would publish ${fnName} from ${fnFile}`);
  else {
    const codeFile = path.join(tmp, "fn.js");
    await writeFile(codeFile, code);
    const fnConfig = `Comment=Mirror of ${SITE},Runtime=cloudfront-js-2.0`;
    let etag;
    try {
      etag = (await cf(["describe-function", "--name", fnName, "--stage", "DEVELOPMENT"])).ETag;
    } catch (err) {
      if (!/NoSuchFunctionExists/.test(String(err.stderr ?? err.message))) throw err;
    }
    etag = etag
      ? (await cf(["update-function", "--name", fnName, "--if-match", etag, "--function-config", fnConfig, "--function-code", `fileb://${codeFile}`])).ETag
      : (await cf(["create-function", "--name", fnName, "--function-config", fnConfig, "--function-code", `fileb://${codeFile}`])).ETag;
    const pub = await cf(["publish-function", "--name", fnName, "--if-match", etag]);
    fnArn = pub.FunctionSummary.FunctionMetadata.FunctionARN;
    log(`published ${fnName}`);
  }

  // ---------------------------------------------------------------- site record
  step(6, "Site record");
  const record = structuredClone(raw);
  record.storage.mirrorDistributionIds = [...new Set([...(record.storage.mirrorDistributionIds ?? []), DIST])];
  if (BASE_URL) {
    record.site.baseUrl = BASE_URL;
    record.site.domain = BASE_URL.replace(/^https:\/\//, "");
  }
  record.updatedAt = new Date().toISOString();
  log(`mirrors ${record.storage.mirrorDistributionIds.join(", ")}${BASE_URL ? `; baseUrl ${BASE_URL}` : ""}`);
  if (!DRY) {
    const f = path.join(tmp, "site.json");
    await writeFile(f, JSON.stringify(record, null, 2));
    await aws(["s3", "cp", f, `s3://${settings.platformBucket}/${siteKeyFor(SITE)}`, "--content-type", "application/json", "--cache-control", "no-store"]);
    log("written");
  }

  // ---------------------------------------------------------------- repoint
  step(7, "Repoint the distribution");
  const ORIGIN_ID = "qw-live";
  const next = structuredClone(current);
  next.Origins = { Quantity: 1, Items: [{
    Id: ORIGIN_ID,
    DomainName: `${site.storage.liveBucket}.s3.${site.storage.region}.amazonaws.com`,
    OriginPath: `/${prefix.replace(/\/$/, "")}`,
    CustomHeaders: { Quantity: 0 },
    S3OriginConfig: { OriginAccessIdentity: "" },
    ConnectionAttempts: 3,
    ConnectionTimeout: 10,
    OriginShield: { Enabled: false },
    OriginAccessControlId: oac?.Id ?? "(created on the real run)",
  }] };
  const dcb = next.DefaultCacheBehavior;
  dcb.TargetOriginId = ORIGIN_ID;
  dcb.ViewerProtocolPolicy = "redirect-to-https";
  dcb.CachePolicyId = "658327ea-f89d-4fab-a63d-7e88639e58f6"; // CachingOptimized
  delete dcb.ForwardedValues; delete dcb.MinTTL; delete dcb.DefaultTTL; delete dcb.MaxTTL;
  dcb.FunctionAssociations = { Quantity: 1, Items: [{ FunctionARN: fnArn ?? "(published on the real run)", EventType: "viewer-request" }] };
  dcb.LambdaFunctionAssociations = { Quantity: 0 };
  next.CacheBehaviors = { Quantity: 0 };
  next.DefaultRootObject = "index.html";
  next.CustomErrorResponses = { Quantity: 2, Items: [
    // S3 answers a missing key with 403 (GetObject, no ListBucket). Both are the site's 404.
    { ErrorCode: 403, ResponsePagePath: "/404.html", ResponseCode: "404", ErrorCachingMinTTL: 60 },
    { ErrorCode: 404, ResponsePagePath: "/404.html", ResponseCode: "404", ErrorCachingMinTTL: 60 },
  ] };
  log(`origin -> ${next.Origins.Items[0].DomainName}${next.Origins.Items[0].OriginPath}`);
  if (DRY) {
    console.log("\nDry run: nothing written.");
  } else {
    const f = path.join(tmp, "cfg.json");
    await writeFile(f, JSON.stringify(next));
    await cf(["update-distribution", "--id", DIST, "--if-match", ETag, "--distribution-config", `file://${f}`]);
    log("updated; waiting for CloudFront to deploy it (usually 5-10 minutes)");
    // The edge still holds whatever the OLD origin served at these same URLs
    // (/index.html above all). Flush once the new origin is live everywhere.
    await aws(["cloudfront", "wait", "distribution-deployed", "--id", DIST], "us-east-1");
    const inv = await cf(["create-invalidation", "--distribution-id", DIST, "--paths", "/*"]);
    log(`deployed; invalidated /* (${inv.Invalidation.Id})`);
    console.log(`\nNext: node infra/deploy-lambda.mjs  (lets publish invalidate ${DIST}), then publish ${SITE}.`);
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}
