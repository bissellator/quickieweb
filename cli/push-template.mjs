#!/usr/bin/env node
// Push a template from a folder into ONE site's own storage, as a private
// (site-scoped) template. The CLI half of the console's template upload.
//
//   node cli/push-template.mjs --site acme --dir ../acme/template --dry-run
//   node cli/push-template.mjs --site acme --dir ../acme/template
//   node cli/push-template.mjs --site acme --dir ../acme/template --activate
//
// --activate also points the site at the new version (tracking the latest of
// that id). Then publish the site -- from the console, or infra/seed-site's
// seedSite() -- to render with it.
//
// Same rules as the console upload (shared/template/library.mjs putSiteTemplate):
// the validator runs first and nothing is written unless it passes, and every
// push is a new immutable version under _internal/templates/<id>/<version>/,
// numbered by the platform rather than taken from the manifest.
//
// A site template is TEXT ONLY -- the console upload is a { path: text } map and
// the loader reads text. Fonts and images go in as static files
// (cli/push-static.mjs) and the stylesheet refers to them by site path.
//
// Runs as the deploy user (AWS_PROFILE=quickieweb), through the AWS CLI, so the
// repository keeps zero npm dependencies.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { loadConfig, reportConfigError } from "./lib/config.mjs";
import { readTemplateSources } from "./lib/template-fs.mjs";
import { checkSiteId, normalizeSite, keyFor, siteKeyFor } from "../shared/site.mjs";
import { validateTemplate } from "../shared/template/validate.mjs";
import { SITE_TEMPLATE_PREFIX, sitePrefixFor, VERSION_RE, byVersionDesc } from "../shared/template/library.mjs";
import { contentType } from "../shared/render.mjs";
import { hostedSettings, readJsonOrNull } from "../infra/lib/seed-site.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const DRY = argv.includes("--dry-run");
const ACTIVATE = argv.includes("--activate");
const SITE = flag("--site");
const DIR = flag("--dir");

if (!SITE || !DIR) {
  console.error("usage: node cli/push-template.mjs --site <id> --dir <template folder> [--activate] [--dry-run]");
  process.exit(1);
}
const badId = checkSiteId(SITE);
if (badId) {
  console.error(`FATAL: site id "${SITE}" ${badId}.`);
  process.exit(1);
}

const config = await loadConfig(ROOT).catch(reportConfigError);
const settings = hostedSettings(config);
const aws = async (args) =>
  (await execFileAsync("aws", [...args, "--region", settings.region], { maxBuffer: 64e6 })).stdout;
const log = (s) => console.log(`    ${s}`);
const step = (n, s) => console.log(`\n[${n}] ${s}`);

// ------------------------------------------------------------------ the site
step(1, `Site "${SITE}"`);
const raw = await readJsonOrNull(aws, `s3://${settings.platformBucket}/${siteKeyFor(SITE)}`);
if (!raw) {
  console.error(`FATAL: no site "${SITE}" in the registry.`);
  process.exit(1);
}
const site = normalizeSite(raw);
const st = site.storage;
log(`staging s3://${st.stagingBucket}/${keyFor(st, SITE_TEMPLATE_PREFIX)}`);

// ------------------------------------------------------------------ the package
step(2, `Template ${DIR}`);
const { sources, binary } = await readTemplateSources(path.resolve(DIR));
if (binary.length) {
  console.error(`FATAL: a site template is text only; push these as static files instead:\n  ${binary.join("\n  ")}`);
  process.exit(1);
}
const { ok, manifest, findings } = validateTemplate(sources);
for (const f of findings) log(`${f.level.padEnd(7)} ${f.file}:${f.line}  ${f.message}`);
if (!ok) {
  console.error("FATAL: the template did not pass validation; nothing was pushed.");
  process.exit(1);
}
log(`${manifest.id} -- ${Object.keys(sources).length} file(s), valid`);

// ------------------------------------------------------------------ version
step(3, "Version");
const idPrefix = keyFor(st, `${SITE_TEMPLATE_PREFIX}${manifest.id}/`);
const versions = new Set();
let token;
do {
  const page = JSON.parse(await aws([
    "s3api", "list-objects-v2", "--bucket", st.stagingBucket, "--prefix", idPrefix,
    ...(token ? ["--continuation-token", token] : []), "--output", "json",
  ]) || "{}");
  for (const o of page.Contents ?? []) {
    const v = o.Key.slice(idPrefix.length).split("/")[0];
    if (VERSION_RE.test(v)) versions.add(v);
  }
  token = page.IsTruncated ? page.NextContinuationToken : undefined;
} while (token);
// Mirrors nextVersionFor(): the platform numbers site templates, so every push
// is new and the previous one stays in place to roll back to.
const latest = [...versions].sort(byVersionDesc)[0];
const version = latest
  ? latest.split(".").map(Number).map((n, i) => (i === 2 ? n + 1 : n)).join(".")
  : "1.0.0";
log(latest ? `${latest} exists; this is ${version}` : `first push: ${version}`);

if (DRY) {
  for (const rel of Object.keys(sources)) log(`would put ${sitePrefixFor(manifest.id, version)}${rel}`);
  if (ACTIVATE) log(`would point ${SITE} at ${manifest.id} (site, latest)`);
  console.log("\nDry run: nothing written.");
  process.exit(0);
}

// ------------------------------------------------------------------ write
step(4, "Upload");
const tmp = await mkdtemp(path.join(os.tmpdir(), "qw-template-"));
try {
  const prefix = sitePrefixFor(manifest.id, version);
  const files = { ...sources, "template.json": JSON.stringify({ ...JSON.parse(sources["template.json"]), version }, null, 2) };
  // template.json LAST: the loader finds a version by its manifest, so a push
  // that dies part way leaves no version that resolves to missing files.
  const order = [...Object.keys(files).filter((r) => r !== "template.json"), "template.json"];
  for (const rel of order) {
    const local = path.join(tmp, rel.replace(/[/\\]/g, "_"));
    await writeFile(local, files[rel]);
    await aws(["s3", "cp", local, `s3://${st.stagingBucket}/${keyFor(st, `${prefix}${rel}`)}`,
      "--content-type", contentType(rel), "--cache-control", "no-store"]);
  }
  log(`${order.length} file(s) at ${prefix}`);

  if (ACTIVATE) {
    step(5, "Activate");
    const record = { ...raw, template: { id: manifest.id, version: "", scope: "site" }, updatedAt: new Date().toISOString() };
    const recFile = path.join(tmp, "site.json");
    await writeFile(recFile, JSON.stringify(record, null, 2));
    await aws(["s3", "cp", recFile, `s3://${settings.platformBucket}/${siteKeyFor(SITE)}`,
      "--content-type", "application/json", "--cache-control", "no-store"]);
    log(`${SITE} now renders with ${manifest.id} (site scope, tracking the latest version)`);
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(`\nPushed ${manifest.id}@${version}. Publish "${SITE}" to render with it: https://app.${settings.domain}/`);
