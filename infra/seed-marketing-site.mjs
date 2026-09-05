#!/usr/bin/env node
// Creates and publishes the platform's own site: the one served at the apex.
//
//   node infra/seed-marketing-site.mjs --owner you@example.com
//   node infra/seed-marketing-site.mjs --owner you@example.com --template plain
//   node infra/seed-marketing-site.mjs --owner you@example.com --name "My Platform"
//   node infra/seed-marketing-site.mjs --owner you@example.com --content marketing
//   node infra/seed-marketing-site.mjs --owner you@example.com --dry-run
//
// WHY THIS IS NOT THE "+ New site" BUTTON
//
// The apex resolves to the site id `www`, and `www` is in RESERVED_SUBDOMAINS
// precisely so no customer can ever claim it. checkSiteId() therefore refuses
// it, and the create API refuses it with checkSiteId. That is correct for the
// API and wrong for us exactly once -- so the platform's own site is seeded out
// of band, by somebody with AWS credentials, the same way the first staff member
// is.
//
// The alternative was a staff override on the reserved list. That would have put
// a code path in the API whose only job is to hand out the names the API exists
// to protect, and it would be reachable by anything that ever compromises a
// staff session.
//
// NOTE ON THE NAME
//
// The site id is `www` but its baseUrl is the bare apex: www.quickieweb.com
// 301-redirects to quickieweb.com, which is then served from sites/www/. The id
// is a storage key, not a hostname.

import { readFile, readdir } from "node:fs/promises";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";

import { newSiteRecord, validateSite, keyFor, siteKeyFor, userKeyFor } from "../shared/site.mjs";
import { normalizeContent, validateContent } from "../shared/content.mjs";
import { renderSite, contentType } from "../shared/render.mjs";
import { tokenForm } from "../shared/template/tokens.mjs";
import { loadTemplateFromDir } from "../cli/lib/template-fs.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadConfig(ROOT).catch(reportConfigError);

const argv = process.argv.slice(2);
const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const DRY = argv.includes("--dry-run");
const owner = (flag("--owner") ?? "").trim().toLowerCase();
const templateId = flag("--template") ?? "journal";
const CONTENT_DIR = path.join(ROOT, flag("--content") ?? "marketing");

const hosted = config.hosted ?? {};
const PLATFORM = config.deploy.platformBucket;
const REGION = config.deploy.region;
const SITE_ID = "www";

for (const [k, v] of Object.entries({
  "deploy.platformBucket": PLATFORM,
  "hosted.domain": hosted.domain,
  "hosted.tenantStagingBucket": hosted.tenantStagingBucket,
  "hosted.tenantLiveBucket": hosted.tenantLiveBucket,
})) {
  if (!v || String(v).includes("REPLACE-ME")) {
    console.error(`FATAL: ${k} is not set. Run infra/provision-hosted.mjs first.`);
    process.exit(1);
  }
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(owner)) {
  console.error("FATAL: --owner <email> is required (the Google account that will edit it).");
  process.exit(1);
}

const log = (s) => console.log(`    ${s}`);
const step = (n, s) => console.log(`\n[${n}] ${s}`);

async function aws(args) {
  const { stdout } = await execFileAsync("aws", [...args, "--region", REGION], { maxBuffer: 32e6 });
  return stdout;
}

const tmpDir = await mkdtemp(path.join(os.tmpdir(), "qw-marketing-"));
const cleanup = () => rm(tmpDir, { recursive: true, force: true });

try {
  console.log(`marketing site for ${hosted.domain}${DRY ? "  (dry run)" : ""}`);

  // ------------------------------------------------------------------ record
  step(1, `Site record "${SITE_ID}"`);
  let existing = null;
  try {
    existing = JSON.parse(await aws(["s3", "cp", `s3://${PLATFORM}/${siteKeyFor(SITE_ID)}`, "-"]));
  } catch { /* absent is the normal first run */ }

  // Named from config, not baked in: a self-hoster running this gets their own
  // platform's name at their own apex.
  const APEX_NAME = flag("--name")
    ?? config.site?.name
    ?? hosted.domain.replace(/\.[a-z.]+$/, "").replace(/^./, (c) => c.toUpperCase());

  const record = existing ?? newSiteRecord({
    siteId: SITE_ID,
    name: APEX_NAME,
    ownerEmail: owner,
    hosted: {
      domain: hosted.domain,
      region: REGION,
      stagingBucket: hosted.tenantStagingBucket,
      liveBucket: hosted.tenantLiveBucket,
      distributionId: hosted.distributionId ?? "",
      distributionDomain: hosted.distributionDomain ?? "",
      logBucket: hosted.tenantLogBucket ?? "",
    },
    template: templateId,
  });

  if (!existing) {
    record.site.tagline = config.site?.tagline ?? "";
    record.site.description = config.site?.description ?? "";
    record.site.author = config.site?.author ?? "";
    record.site.nav = [{ label: "Home", href: "/" }];
    record.taxonomy = { categories: { NEWS: { label: "News" }, NOTES: { label: "Notes" } } };
  }
  record.template = { id: templateId, version: record.template?.version ?? "" };

  const problems = validateSite(record);
  if (problems.length) {
    console.error(`FATAL: the record is not valid:\n  - ${problems.join("\n  - ")}`);
    process.exit(1);
  }
  log(existing ? "exists, reusing it" : "created");
  log(`serves ${record.site.baseUrl}  (prefix ${record.storage.prefix})`);

  // ------------------------------------------------------------------ content
  step(2, "Content");
  let names = [];
  try {
    names = (await readdir(CONTENT_DIR)).filter((f) => f.endsWith(".json"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    log(`no ${path.relative(ROOT, CONTENT_DIR)}/ -- the site will be an empty shell`);
  }

  const records = [];
  for (const f of names) {
    const rec = normalizeContent(JSON.parse(await readFile(path.join(CONTENT_DIR, f), "utf8")));
    if (rec.status !== "published") { log(`skip (${rec.status}) ${f}`); continue; }
    const bad = validateContent(rec);
    if (bad.length) { console.error(`FATAL: ${f}: ${bad.join("; ")}`); process.exit(1); }
    records.push(rec);
  }
  log(`${records.length} published item(s)`);

  // ------------------------------------------------------------------- render
  step(3, "Render");
  const template = await loadTemplateFromDir(path.join(ROOT, "templates", templateId));
  const { files, warnings } = renderSite({
    template, site: record.site, theme: record.theme, records,
  });
  for (const w of warnings) console.warn(`    theme: ${w}`);

  // The console reads this for its category picker and its Design form. The
  // Lambda writes the same file on every rebuild; producing it here too means a
  // site seeded from the CLI is not missing one until its first save.
  files["taxonomy.json"] = JSON.stringify({
    categories: record.taxonomy.categories,
    template: { id: template.manifest.id, name: template.manifest.name, version: template.manifest.version },
    theme: tokenForm(template.manifest, record.theme),
  }, null, 2);

  log(`${Object.keys(files).length} file(s)`);

  // -------------------------------------------------------------- source of truth
  //
  // The console edits `_internal/articles/*.json` in staging and rebuilds the
  // rendered pages FROM them. Seeding the rendered output without these is not
  // merely "the list looks empty" -- it is destructive: the next rebuild reads an
  // empty index, renders a site with no content, and writes that over the pages
  // this script just published. So the source goes in first, and the rendered
  // output below is only ever a derivative of it.
  step(4, "Source records");
  const slugs = records.map((r) => r.slug);
  if (DRY) {
    for (const s of slugs) log(`would write _internal/articles/${s}.json`);
    log(`would write _internal/articles/index.json (${slugs.length} slug(s))`);
  } else {
    for (const rec of records) {
      const local = path.join(tmpDir, `rec-${rec.slug}.json`);
      await writeFile(local, JSON.stringify(rec, null, 2));
      await aws(["s3", "cp", local,
        `s3://${record.storage.stagingBucket}/${keyFor(record.storage, `_internal/articles/${rec.slug}.json`)}`,
        "--content-type", "application/json", "--cache-control", "no-store"]);
    }
    const idxFile = path.join(tmpDir, "index.json");
    await writeFile(idxFile, JSON.stringify(slugs, null, 2));
    await aws(["s3", "cp", idxFile,
      `s3://${record.storage.stagingBucket}/${keyFor(record.storage, "_internal/articles/index.json")}`,
      "--content-type", "application/json", "--cache-control", "no-store"]);
    log(`${slugs.length} record(s) + index, staging only`);
    // Staging only, deliberately: SKIP_PREFIXES in admin/lib/store.mjs excludes
    // _internal/ from both sides of a changeset, so a copy in live would be an
    // orphan nothing reads and nothing ever cleans up.
  }

  // ------------------------------------------------------------------ upload
  //
  // Written to BOTH buckets. Staging because that is what computeChangeset
  // compares against -- seeding only live would make the site's first publish
  // look like a deletion of everything.
  step(5, "Upload");
  if (DRY) {
    for (const name of Object.keys(files)) log(`would write ${keyFor(record.storage, name)}`);
  } else {
    for (const [name, body] of Object.entries(files)) {
      const local = path.join(tmpDir, name.replace(/[/\\]/g, "_"));
      await writeFile(local, body);
      const key = keyFor(record.storage, name);
      // Same cache split as admin/lib/store.mjs: long for the CDN, which we
      // invalidate, short for browsers, which we cannot reach.
      const cache = name.startsWith("media/")
        ? "public, max-age=31536000, immutable"
        : "public, max-age=300, s-maxage=31536000";
      for (const bucket of [record.storage.stagingBucket, record.storage.liveBucket]) {
        await aws(["s3", "cp", local, `s3://${bucket}/${key}`,
          "--content-type", contentType(name), "--cache-control", cache]);
      }
    }
    log(`wrote ${Object.keys(files).length} file(s) to staging and live`);

    // Template assets (the stylesheet, any fonts) live alongside the rendered
    // pages, copied from the library rather than re-rendered.
    for (const rel of template.assets) {
      const key = keyFor(record.storage, `assets/${path.basename(rel)}`);
      for (const bucket of [record.storage.stagingBucket, record.storage.liveBucket]) {
        await aws(["s3", "cp", path.join(template.dir, rel), `s3://${bucket}/${key}`,
          "--content-type", contentType(rel), "--cache-control", "public, max-age=300, s-maxage=31536000"]);
      }
    }
    // The favicon the templates link to. Without it every page load logs a 403.
    for (const bucket of [record.storage.stagingBucket, record.storage.liveBucket]) {
      await aws(["s3", "cp", path.join(ROOT, "assets", "favicon.svg"),
        `s3://${bucket}/${keyFor(record.storage, "assets/favicon.svg")}`,
        "--content-type", "image/svg+xml", "--cache-control", "public, max-age=300, s-maxage=31536000"]);
    }
    log(`wrote ${template.assets.length + 1} asset(s)`);
  }

  // ------------------------------------------------------------------ registry
  //
  // The record goes in LAST. Until it exists the console cannot open the site,
  // so writing it only once the bytes are in place means there is no window
  // where the site is listed but blank.
  step(6, "Registry");
  if (DRY) {
    log(`would write ${siteKeyFor(SITE_ID)} and index ${owner}`);
  } else {
    const recFile = path.join(tmpDir, "site.json");
    await writeFile(recFile, JSON.stringify(record, null, 2));
    await aws(["s3", "cp", recFile, `s3://${PLATFORM}/${siteKeyFor(SITE_ID)}`,
      "--content-type", "application/json", "--cache-control", "no-store"]);
    log(`wrote ${siteKeyFor(SITE_ID)}`);

    // The owner's own index, so the site shows in their switcher without
    // waiting for a staff listing.
    const { createHash } = await import("node:crypto");
    const uKey = userKeyFor(owner, (v) => createHash("sha256").update(v).digest("hex"));
    let user = null;
    try { user = JSON.parse(await aws(["s3", "cp", `s3://${PLATFORM}/${uKey}`, "-"])); } catch { /* new */ }
    user ??= { email: owner, name: "", platformRole: "user", siteIds: [], createdAt: new Date().toISOString() };
    if (!user.siteIds.includes(SITE_ID)) user.siteIds.push(SITE_ID);
    const uFile = path.join(tmpDir, "user.json");
    await writeFile(uFile, JSON.stringify(user, null, 2));
    await aws(["s3", "cp", uFile, `s3://${PLATFORM}/${uKey}`,
      "--content-type", "application/json", "--cache-control", "no-store"]);
    log(`indexed for ${owner} (platformRole: ${user.platformRole})`);
  }

  // ----------------------------------------------------------------- invalidate
  step(7, "Invalidate");
  if (!DRY && record.storage.distributionId) {
    // The prefixed path, not the reader's URL: the Host->prefix rewrite happens
    // on viewer-request, before the cache lookup, so the cache key carries it.
    const res = JSON.parse(await execFileAsync("aws", ["cloudfront", "create-invalidation",
      "--distribution-id", record.storage.distributionId,
      "--paths", `/${record.storage.prefix}*`,
      "--region", "us-east-1", "--output", "json"], { maxBuffer: 8e6 }).then((r) => r.stdout));
    log(`${res.Invalidation.Id} for /${record.storage.prefix}*`);
  } else {
    log(DRY ? "skipped (dry run)" : "no distribution configured");
  }

  console.log(`\n${DRY ? "dry run complete." : `live at ${record.site.baseUrl}`}`);
  if (!DRY) console.log(`edit it at https://app.${hosted.domain}/ as ${owner}`);
} finally {
  await cleanup();
}
