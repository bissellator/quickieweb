#!/usr/bin/env node
// Push a folder of hand-made files into a hosted site as static files.
//
//   node cli/push-static.mjs --site jeffseats --dir ../jeffseats/site --dry-run
//   node cli/push-static.mjs --site jeffseats --dir ../jeffseats/site
//   node cli/push-static.mjs --site jeffseats --dir ../jeffseats/site --prune
//
// Then press Publish in the console (or publish through the API). This stages;
// it does not publish, because a publish is where the edge's access levels are
// kept in step with the bytes, and that belongs to the Lambda alone.
//
// Each file lands exactly where the console's static-file upload would put it
// (shared/static-pages.mjs): a source under _internal/static/<path> and a staged
// copy at <path>. Same path rules, same body checks, same Content-Type and
// Cache-Control (shared/object-policy.mjs), so a file pushed from here and one
// uploaded in the console are indistinguishable. A static file at a path the
// template also writes -- index.html, assets/style.css -- replaces it.
//
// WHY NOT `aws s3 sync`
//
// sync guesses Content-Type from this machine's MIME table (on Windows, the
// registry), and gets .js, .woff2 and .svg wrong often enough to break a page.
// It also cannot write two copies. So every changed file is a put-object with
// the type and cache policy spelled out, and "changed" is the local MD5 against
// the source's ETag (single-part puts, so the ETag is the MD5).
//
// --prune removes static files the folder no longer has. A removed file that
// was replacing a generated one gets the template's version back at the next
// publish, which always rebuilds first.
//
// Runs as the deploy user (AWS_PROFILE=quickieweb), through the AWS CLI, so the
// repository keeps zero npm dependencies.

import { readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig, reportConfigError } from "./lib/config.mjs";
import { checkSiteId, normalizeSite, keyFor, siteKeyFor } from "../shared/site.mjs";
import {
  STATIC_PREFIX, GENERATED_LIST_KEY, GENERATED_PATHS,
  checkStaticPath, checkStaticBody, contentTypeOf, replacesGenerated, StaticPageRejected,
} from "../shared/static-pages.mjs";
import { cacheControlFor } from "../shared/object-policy.mjs";
import { hostedSettings, readJsonOrNull } from "../infra/lib/seed-site.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DRY = argv.includes("--dry-run");
const PRUNE = argv.includes("--prune");
const SITE = flag("--site");
const DIR = flag("--dir");

if (!SITE || !DIR) {
  console.error("usage: node cli/push-static.mjs --site <id> --dir <folder> [--dry-run] [--prune]");
  process.exit(1);
}
// "www" is reserved so no TENANT can claim the apex; it is the platform's own
// marketing site, which infra/seed-marketing-site.mjs writes the same way. The
// registry lookup below still has to find it.
const badId = SITE === "www" ? null : checkSiteId(SITE);
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
if (!st?.stagingBucket) {
  console.error(`FATAL: site "${SITE}" has no staging bucket in its record.`);
  process.exit(1);
}
log(`staging s3://${st.stagingBucket}/${keyFor(st, "")}`);

// ------------------------------------------------------------------ the folder
step(2, `Folder ${DIR}`);
const base = path.resolve(DIR);

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    // Dotfiles (.DS_Store, .gitignore) are never part of a site.
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// A record that renders to <slug>.html cannot be shadowed by a static file --
// the same rule the console applies.
const index = await readJsonOrNull(aws, `s3://${st.stagingBucket}/${keyFor(st, "_internal/articles/index.json")}`) ?? [];
const slugs = index.filter((s) => typeof s === "string");

const local = new Map();
const problems = [];
for (const full of await walk(base)) {
  const rel = path.relative(base, full).split(path.sep).join("/");
  try {
    const p = checkStaticPath(rel, { slugs });
    const body = checkStaticBody(p, await readFile(full));
    local.set(p, { full, body, md5: createHash("md5").update(body).digest("hex") });
  } catch (err) {
    if (!(err instanceof StaticPageRejected)) throw err;
    problems.push(`${rel}: ${err.message}`);
  }
}
if (problems.length) {
  console.error(`FATAL: ${problems.length} file(s) cannot be static files, so nothing was pushed:`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
const bytes = [...local.values()].reduce((n, f) => n + f.body.length, 0);
log(`${local.size} file(s), ${(bytes / 1048576).toFixed(1)} MB`);

// ------------------------------------------------------------------ the diff
step(3, "Compare with what the site holds");
const srcPrefix = keyFor(st, STATIC_PREFIX);
const remote = new Map();
let token;
do {
  const page = JSON.parse(await aws([
    "s3api", "list-objects-v2", "--bucket", st.stagingBucket, "--prefix", srcPrefix,
    ...(token ? ["--continuation-token", token] : []), "--output", "json",
  ]) || "{}");
  for (const o of page.Contents ?? []) remote.set(o.Key.slice(srcPrefix.length), o.ETag.replace(/"/g, ""));
  token = page.IsTruncated ? page.NextContinuationToken : undefined;
} while (token);

const put = [...local.entries()].filter(([p, f]) => remote.get(p) !== f.md5).map(([p]) => p);
const gone = [...remote.keys()].filter((p) => !local.has(p));
log(`${put.length} new or changed, ${local.size - put.length} unchanged, ${gone.length} on the site but not in the folder`);
const recorded = await readJsonOrNull(aws, `s3://${st.stagingBucket}/${keyFor(st, GENERATED_LIST_KEY)}`);
const generated = Array.isArray(recorded) ? new Set(recorded) : GENERATED_PATHS;
const replacing = [...local.keys()].filter((p) => replacesGenerated(p, generated));
if (replacing.length) {
  log(`${replacing.length} replace the template's own file: ${replacing.slice(0, 6).join(", ")}${replacing.length > 6 ? ", ..." : ""}`);
}
if (gone.length && !PRUNE) log(`kept (pass --prune to remove): ${gone.slice(0, 6).join(", ")}${gone.length > 6 ? ", ..." : ""}`);

if (DRY) {
  for (const p of put) log(`would put  ${p}`);
  if (PRUNE) for (const p of gone) log(`would remove ${p}`);
  console.log("\nDry run: nothing written.");
  process.exit(0);
}

// ------------------------------------------------------------------ write
step(4, "Stage");
for (const p of put) {
  const f = local.get(p);
  // Two objects: the held source (no-store, never published) and the staged
  // copy a publish promotes. The staged one is written second, so a failure
  // between them leaves a source that the next publish's rebuild re-stages.
  for (const key of [`${STATIC_PREFIX}${p}`, p]) {
    await aws([
      "s3api", "put-object", "--bucket", st.stagingBucket, "--key", keyFor(st, key),
      "--body", f.full, "--content-type", contentTypeOf(p), "--cache-control", cacheControlFor(key),
      "--content-md5", Buffer.from(f.md5, "hex").toString("base64"),
    ]);
  }
  log(`put ${p}`);
}
if (PRUNE) {
  for (const p of gone) {
    await aws(["s3api", "delete-object", "--bucket", st.stagingBucket, "--key", keyFor(st, `${STATIC_PREFIX}${p}`)]);
    await aws(["s3api", "delete-object", "--bucket", st.stagingBucket, "--key", keyFor(st, p)]);
    log(`removed ${p}`);
  }
}

console.log(`\nStaged. Publish "${SITE}" in the console to put it live: https://app.${settings.domain}/`);
