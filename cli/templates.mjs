#!/usr/bin/env node
// The template library.
//
//   node cli/templates.mjs list                     what is here, and what is live
//   node cli/templates.mjs publish templates/plain  push a version to the library
//   node cli/templates.mjs sync                     pull the library into templates/
//   node cli/templates.mjs sync --from s3://bucket  pull from somewhere else
//
// WHY A SEPARATE BUCKET
//
// The library is shared by every site in an installation and is never published
// to any of them. Keeping it out of the content buckets means a site's publish
// -- which compares its own staging against its own live -- cannot touch a
// template, however wrong its changeset is. It also means the admin Lambda can
// hold read-only credentials for it, so a compromised editor session on one site
// cannot alter a template that other sites render against.
//
// VERSIONS ARE IMMUTABLE
//
// templates/<id>/<version>/ is written once. A site pinned to journal@1.2.0
// renders the same bytes next year. Publishing over an existing version is
// refused rather than silently changing every site that pinned it; bump the
// version in template.json instead.
//
// Uses the AWS CLI rather than the SDK so the repo keeps zero npm dependencies.

import { writeFile, mkdir, rm } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";

import { listLocalTemplates, readTemplateSources } from "./lib/template-fs.mjs";
import { validateTemplate } from "../shared/template/validate.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = path.join(ROOT, "templates");

const config = await loadConfig(ROOT).catch(reportConfigError);
const REGION = config.deploy.region;

const argv = process.argv.slice(2);
const command = argv[0];
const DRY = argv.includes("--dry-run");
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);

// The library defaults to this installation's own platform bucket. `--from`
// points sync at somebody else's -- the public Quickieweb library, or a mirror.
const bucketOf = (uri) => String(uri).replace(/^s3:\/\//, "").replace(/\/+$/, "");
const PLATFORM = bucketOf(flag("--from") ?? config.deploy.platformBucket ?? "");

function requirePlatform() {
  if (!PLATFORM || PLATFORM.includes("REPLACE-ME")) {
    console.error("FATAL: no platform bucket. Set deploy.platformBucket in config.json,\n" +
      "  run node infra/provision-platform.mjs, or pass --from s3://<bucket>.");
    process.exit(1);
  }
}

function run(cmd, args) {
  console.log(`  ${cmd} ${args.join(" ")}`);
  if (DRY) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))));
  });
}

async function readCatalog() {
  try {
    const { stdout } = await execFileAsync("aws",
      ["s3", "cp", `s3://${PLATFORM}/templates/index.json`, "-", "--region", REGION],
      { maxBuffer: 8e6 });
    return JSON.parse(stdout);
  } catch {
    // No catalog yet is a normal state for a fresh library, not an error.
    return { templates: [], updatedAt: null };
  }
}

// ------------------------------------------------------------------ list
if (command === "list") {
  const local = await listLocalTemplates(TEMPLATES);
  console.log(`local  (${TEMPLATES})`);
  for (const t of local) console.log(`  ${t.id}@${t.version ?? "?"}  ${t.description}`);
  if (!local.length) console.log("  (none)");

  if (PLATFORM && !PLATFORM.includes("REPLACE-ME")) {
    const catalog = await readCatalog();
    console.log(`\nlibrary  (s3://${PLATFORM}/templates/)`);
    for (const t of catalog.templates ?? []) {
      console.log(`  ${t.id}@${t.versions?.join(", ") ?? t.version}  ${t.description ?? ""}`);
    }
    if (!(catalog.templates ?? []).length) console.log("  (empty)");
  } else {
    console.log("\nlibrary  (not configured -- set deploy.platformBucket)");
  }
  process.exit(0);
}

// --------------------------------------------------------------- publish
if (command === "publish") {
  requirePlatform();
  const dir = argv[1];
  if (!dir) { console.error("usage: node cli/templates.mjs publish <template-dir>"); process.exit(2); }

  // Never publish a template that does not pass. The library is the one place a
  // broken template would break every site that adopts it.
  const { sources } = await readTemplateSources(dir);
  const { ok, manifest, findings } = validateTemplate(sources);
  for (const f of findings) console.log(`  ${f.level.padEnd(7)} ${f.file}:${f.line}  ${f.message}`);
  if (!ok) { console.error("\nFAIL: fix the errors above before publishing."); process.exit(1); }

  const prefix = `templates/${manifest.id}/${manifest.version}/`;
  const { stdout } = await execFileAsync("aws",
    ["s3", "ls", `s3://${PLATFORM}/${prefix}`, "--region", REGION], { maxBuffer: 8e6 })
    .catch(() => ({ stdout: "" }));
  if (stdout.trim()) {
    console.error(`\nFATAL: ${manifest.id}@${manifest.version} is already published.\n` +
      "  Versions are immutable -- sites pin them. Bump \"version\" in template.json.");
    process.exit(1);
  }

  console.log(`\npublish ${manifest.id}@${manifest.version} -> s3://${PLATFORM}/${prefix}\n`);
  await run("aws", ["s3", "sync", dir, `s3://${PLATFORM}/${prefix}`,
    "--region", REGION, "--exclude", ".*", "--cache-control", "public,max-age=300"]);

  // Refresh the catalog. Derived from what is actually in the bucket rather than
  // appended to, so a hand-deleted version cannot linger in the listing.
  const catalog = await readCatalog();
  const others = (catalog.templates ?? []).filter((t) => t.id !== manifest.id);
  const mine = (catalog.templates ?? []).find((t) => t.id === manifest.id);
  const next = {
    updatedAt: new Date().toISOString(),
    templates: [...others, {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description ?? "",
      author: manifest.author ?? "",
      license: manifest.license ?? "",
      supports: manifest.supports,
      versions: [...new Set([...(mine?.versions ?? []), manifest.version])].sort(),
      latest: manifest.version,
    }].sort((a, b) => a.id.localeCompare(b.id)),
  };

  const tmp = path.join(ROOT, ".templates-index.json");
  await writeFile(tmp, JSON.stringify(next, null, 2));
  await run("aws", ["s3", "cp", tmp, `s3://${PLATFORM}/templates/index.json`,
    "--region", REGION, "--content-type", "application/json", "--cache-control", "no-cache"]);
  await rm(tmp, { force: true });

  console.log(DRY ? "\ndry run complete." : `\npublished ${manifest.id}@${manifest.version}`);
  process.exit(0);
}

// ------------------------------------------------------------------ sync
if (command === "sync") {
  requirePlatform();
  const only = argv[1] && !argv[1].startsWith("--") ? argv[1] : null;
  const catalog = await readCatalog();
  const wanted = (catalog.templates ?? []).filter((t) => !only || t.id === only);

  if (!wanted.length) {
    console.error(only
      ? `No template "${only}" in s3://${PLATFORM}/templates/index.json`
      : `s3://${PLATFORM}/templates/index.json lists no templates.`);
    process.exit(1);
  }

  console.log(`sync from s3://${PLATFORM}/templates/ -> ${TEMPLATES}/\n`);
  for (const t of wanted) {
    const version = t.latest ?? t.versions?.at(-1);
    const dest = path.join(TEMPLATES, t.id);
    await mkdir(dest, { recursive: true });
    // --delete so a local copy is a mirror of the version, not an accumulation
    // of files from two different ones.
    await run("aws", ["s3", "sync", `s3://${PLATFORM}/templates/${t.id}/${version}/`, dest,
      "--region", REGION, "--delete"]);
    console.log(`  ${t.id}@${version}`);
  }
  console.log(DRY ? "\ndry run complete." : `\nsynced ${wanted.length} template(s).`);
  console.log("Check them with: node cli/validate-template.mjs templates/*");
  process.exit(0);
}

console.error(`usage:
  node cli/templates.mjs list
  node cli/templates.mjs publish <template-dir> [--dry-run]
  node cli/templates.mjs sync [id] [--from s3://bucket] [--dry-run]`);
process.exit(2);
