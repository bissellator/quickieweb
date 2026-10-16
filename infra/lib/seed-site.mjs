// Seeding a hosted site out of band: shared by infra/seed-site.mjs (any tenant)
// and infra/seed-marketing-site.mjs (the apex site, `www`).
//
// "Out of band" means by somebody holding AWS credentials, not through the
// console's create API. The order below is the whole point, and each step says
// what goes wrong if it moves:
//
//   1. the site record, reused if it already exists
//   2. the content, from a local folder of JSON records (or none: a blank shell)
//   3. render
//   4. source records into staging        -- before any rendered output
//   5. rendered files into staging AND live
//   6. the registry entry, LAST           -- no window where it is listed but blank
//   7. invalidate the tenant's prefix
//
// Re-running is safe: an existing record is reused, never replaced, and files
// are overwritten with the same bytes.

import { readFile, readdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

import { newSiteRecord, validateSite, keyFor, siteKeyFor, userKeyFor } from "../../shared/site.mjs";
import { normalizeContent, validateContent } from "../../shared/content.mjs";
import { renderSite, contentType } from "../../shared/render.mjs";
import { tokenForm } from "../../shared/template/tokens.mjs";
import { loadTemplateFromDir } from "../../cli/lib/template-fs.mjs";

const execFileAsync = promisify(execFile);

/** The platform settings a seed needs, or exit naming the first missing one. */
export function hostedSettings(config) {
  const hosted = config.hosted ?? {};
  const settings = {
    platformBucket: config.deploy?.platformBucket,
    region: config.deploy?.region,
    domain: hosted.domain,
    stagingBucket: hosted.tenantStagingBucket,
    liveBucket: hosted.tenantLiveBucket,
    distributionId: hosted.distributionId ?? "",
    distributionDomain: hosted.distributionDomain ?? "",
    logBucket: hosted.tenantLogBucket ?? "",
  };
  for (const [k, v] of Object.entries({
    "deploy.platformBucket": settings.platformBucket,
    "hosted.domain": settings.domain,
    "hosted.tenantStagingBucket": settings.stagingBucket,
    "hosted.tenantLiveBucket": settings.liveBucket,
  })) {
    if (!v || String(v).includes("REPLACE-ME")) {
      console.error(`FATAL: ${k} is not set. Run infra/provision-hosted.mjs first.`);
      process.exit(1);
    }
  }
  return settings;
}

/**
 * An S3 object as JSON, or null when it does not exist. ONLY "does not exist"
 * is null: an access-denied or network error read as "absent" would make the
 * caller build a fresh record and overwrite the real one with it.
 */
export async function readJsonOrNull(aws, uri) {
  try {
    return JSON.parse(await aws(["s3", "cp", uri, "-"]));
  } catch (err) {
    if (/\(404\)|Not Found|NoSuchKey|does not exist/i.test(String(err.stderr ?? err.message))) return null;
    throw new Error(`could not read ${uri}: ${String(err.stderr ?? err.message).trim()}`);
  }
}

export const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

/**
 * @param root       the repository root (templates/ and assets/ are read from it)
 * @param settings   from hostedSettings(config)
 * @param siteId     already checked by the caller (checkSiteId, or `www` on purpose)
 * @param owner      the Google account that will edit the site
 * @param name       display name for a NEW record; an existing record keeps its own
 * @param templateId template to render with
 * @param contentDir folder of content JSON; missing means a blank site
 * @param shapeNew   (record) => void, for a caller's defaults on a NEW record only
 * @param dry        report what would be written, write nothing
 */
export async function seedSite({ root, settings, siteId, owner, name, templateId, contentDir, shapeNew = () => {}, dry = false }) {
  const log = (s) => console.log(`    ${s}`);
  const step = (n, s) => console.log(`\n[${n}] ${s}`);
  const aws = async (args) => (await execFileAsync("aws", [...args, "--region", settings.region], { maxBuffer: 32e6 })).stdout;

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), `qw-seed-${siteId}-`));
  try {
    // ------------------------------------------------------------------ record
    step(1, `Site record "${siteId}"`);
    const existing = await readJsonOrNull(aws, `s3://${settings.platformBucket}/${siteKeyFor(siteId)}`);

    const record = existing ?? newSiteRecord({
      siteId,
      name,
      ownerEmail: owner,
      hosted: {
        domain: settings.domain,
        region: settings.region,
        stagingBucket: settings.stagingBucket,
        liveBucket: settings.liveBucket,
        distributionId: settings.distributionId,
        distributionDomain: settings.distributionDomain,
        logBucket: settings.logBucket,
      },
      template: templateId,
    });
    if (!existing) shapeNew(record);
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
    if (contentDir) {
      try {
        names = (await readdir(contentDir)).filter((f) => f.endsWith(".json"));
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
        log(`no ${path.relative(root, contentDir)}/ -- the site will be an empty shell`);
      }
    } else {
      log("no content folder given -- the site will be an empty shell");
    }

    const records = [];
    for (const f of names) {
      const rec = normalizeContent(JSON.parse(await readFile(path.join(contentDir, f), "utf8")));
      if (rec.status !== "published") { log(`skip (${rec.status}) ${f}`); continue; }
      const bad = validateContent(rec);
      if (bad.length) { console.error(`FATAL: ${f}: ${bad.join("; ")}`); process.exit(1); }
      records.push(rec);
    }
    log(`${records.length} published item(s)`);

    // ------------------------------------------------------------------- render
    step(3, "Render");
    const template = await loadTemplateFromDir(path.join(root, "templates", templateId));
    const { files, warnings } = renderSite({ template, site: record.site, theme: record.theme, records });
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
    const stagingKey = (k) => `s3://${record.storage.stagingBucket}/${keyFor(record.storage, k)}`;
    if (dry) {
      for (const s of slugs) log(`would write _internal/articles/${s}.json`);
      log(`would write _internal/articles/index.json (${slugs.length} slug(s))`);
    } else {
      for (const rec of records) {
        const local = path.join(tmpDir, `rec-${rec.slug}.json`);
        await writeFile(local, JSON.stringify(rec, null, 2));
        await aws(["s3", "cp", local, stagingKey(`_internal/articles/${rec.slug}.json`),
          "--content-type", "application/json", "--cache-control", "no-store"]);
      }
      const idxFile = path.join(tmpDir, "index.json");
      await writeFile(idxFile, JSON.stringify(slugs, null, 2));
      await aws(["s3", "cp", idxFile, stagingKey("_internal/articles/index.json"),
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
    const both = [record.storage.stagingBucket, record.storage.liveBucket];
    if (dry) {
      for (const n of Object.keys(files)) log(`would write ${keyFor(record.storage, n)}`);
    } else {
      for (const [n, body] of Object.entries(files)) {
        const local = path.join(tmpDir, n.replace(/[/\\]/g, "_"));
        await writeFile(local, body);
        const key = keyFor(record.storage, n);
        // Same cache split as admin/lib/store.mjs: long for the CDN, which we
        // invalidate, short for browsers, which we cannot reach.
        const cache = n.startsWith("media/") ? "public, max-age=31536000, immutable" : "public, max-age=300, s-maxage=31536000";
        for (const bucket of both) {
          await aws(["s3", "cp", local, `s3://${bucket}/${key}`, "--content-type", contentType(n), "--cache-control", cache]);
        }
      }
      log(`wrote ${Object.keys(files).length} file(s) to staging and live`);

      // Template assets (the stylesheet, any fonts) live alongside the rendered
      // pages, copied from the library rather than re-rendered.
      const assetCache = "public, max-age=300, s-maxage=31536000";
      for (const rel of template.assets) {
        const key = keyFor(record.storage, `assets/${path.basename(rel)}`);
        for (const bucket of both) {
          await aws(["s3", "cp", path.join(template.dir, rel), `s3://${bucket}/${key}`, "--content-type", contentType(rel), "--cache-control", assetCache]);
        }
      }
      // The favicon the templates link to. Without it every page load logs a 403.
      for (const bucket of both) {
        await aws(["s3", "cp", path.join(root, "assets", "favicon.svg"), `s3://${bucket}/${keyFor(record.storage, "assets/favicon.svg")}`,
          "--content-type", "image/svg+xml", "--cache-control", assetCache]);
      }
      log(`wrote ${template.assets.length + 1} asset(s)`);
    }

    // ------------------------------------------------------------------ registry
    //
    // The record goes in LAST. Until it exists the console cannot open the site,
    // so writing it only once the bytes are in place means there is no window
    // where the site is listed but blank.
    step(6, "Registry");
    if (dry) {
      log(`would write ${siteKeyFor(siteId)} and index ${owner}`);
    } else {
      const recFile = path.join(tmpDir, "site.json");
      await writeFile(recFile, JSON.stringify(record, null, 2));
      await aws(["s3", "cp", recFile, `s3://${settings.platformBucket}/${siteKeyFor(siteId)}`,
        "--content-type", "application/json", "--cache-control", "no-store"]);
      log(`wrote ${siteKeyFor(siteId)}`);

      // The owner's own index, so the site shows in their switcher without
      // waiting for a staff listing.
      const uKey = userKeyFor(owner, (v) => createHash("sha256").update(v).digest("hex"));
      let user = await readJsonOrNull(aws, `s3://${settings.platformBucket}/${uKey}`);
      user ??= { email: owner, name: "", platformRole: "user", siteIds: [], createdAt: new Date().toISOString() };
      if (!user.siteIds.includes(siteId)) user.siteIds.push(siteId);
      const uFile = path.join(tmpDir, "user.json");
      await writeFile(uFile, JSON.stringify(user, null, 2));
      await aws(["s3", "cp", uFile, `s3://${settings.platformBucket}/${uKey}`,
        "--content-type", "application/json", "--cache-control", "no-store"]);
      log(`indexed for ${owner} (platformRole: ${user.platformRole})`);
    }

    // ----------------------------------------------------------------- invalidate
    step(7, "Invalidate");
    if (!dry && record.storage.distributionId) {
      // The prefixed path, not the reader's URL: the Host->prefix rewrite happens
      // on viewer-request, before the cache lookup, so the cache key carries it.
      const res = JSON.parse((await execFileAsync("aws", ["cloudfront", "create-invalidation",
        "--distribution-id", record.storage.distributionId,
        "--paths", `/${record.storage.prefix}*`,
        "--region", "us-east-1", "--output", "json"], { maxBuffer: 8e6 })).stdout);
      log(`${res.Invalidation.Id} for /${record.storage.prefix}*`);
    } else {
      log(dry ? "skipped (dry run)" : "no distribution configured");
    }

    console.log(`\n${dry ? "dry run complete." : `live at ${record.site.baseUrl}`}`);
    if (!dry) console.log(`edit it at https://app.${settings.domain}/ as ${owner}`);
    return record;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
