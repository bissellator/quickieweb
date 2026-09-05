#!/usr/bin/env node
// Renders content/*.json into site/ through the site's template.
//
//   node cli/build.mjs
//   node cli/build.mjs --template plain     override the configured template
//   node cli/build.mjs --content marketing  build from another content directory
//
// site/ is the deployable artifact: no runtime, no database, no framework, no
// build-time network calls. Every post is real HTML (readable with JS off,
// indexable, shareable).
//
// The rendering itself lives in shared/, which the admin Lambda also uses. Same
// content, same template, same bytes -- whichever path published it.

import { readFile, writeFile, mkdir, readdir, copyFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";

import { renderSite } from "../shared/render.mjs";
import { normalizeContent, validateContent } from "../shared/content.mjs";
import { normalizeSite } from "../shared/site.mjs";
import { tokenForm } from "../shared/template/tokens.mjs";
import { loadTemplateFromDir, listLocalTemplates } from "./lib/template-fs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "site");
const TEMPLATES = path.join(ROOT, "templates");

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);

const CONTENT = path.join(ROOT, flag("--content") ?? "content");

const config = await loadConfig(ROOT).catch(reportConfigError);
// Everything a reader sees is normalized through the same shape the platform
// stores, so a locally built site and a hosted one cannot diverge in what a
// template is handed.
const record = normalizeSite(config);
const site = record.site;

// ------------------------------------------------------------------ template
const templateId = flag("--template") ?? record.template.id;
const templateDir = path.join(TEMPLATES, templateId);

let template;
try {
  template = await loadTemplateFromDir(templateDir);
} catch (err) {
  console.error(`FATAL: template "${templateId}" did not load.\n${err.message}\n`);
  const available = await listLocalTemplates(TEMPLATES);
  console.error(available.length
    ? `Available locally: ${available.map((t) => t.id).join(", ")}`
    : "No templates in templates/. Run: node cli/templates.mjs sync");
  console.error("Check one with: node cli/validate-template.mjs " + templateDir);
  process.exit(1);
}
console.log(`template ${template.manifest.id}@${template.manifest.version}`);

// ------------------------------------------------------------------- content
let names = [];
try {
  names = (await readdir(CONTENT)).filter((f) => f.endsWith(".json"));
} catch (err) {
  if (err.code !== "ENOENT") throw err;
  console.log(`  no ${path.relative(ROOT, CONTENT)}/ directory -- building an empty site`);
}

const records = [];
for (const f of names) {
  const raw = JSON.parse(await readFile(path.join(CONTENT, f), "utf8"));
  const rec = normalizeContent(raw);
  if (rec.status !== "published") { console.log(`  skip (${rec.status}) ${f}`); continue; }
  const problems = validateContent(rec);
  if (problems.length) throw new Error(`${f}: ${problems.join("; ")}`);
  records.push(rec);
}

const dupes = records.map((r) => r.slug).filter((s, i, a) => a.indexOf(s) !== i);
if (dupes.length) throw new Error(`Duplicate slugs would overwrite each other: ${[...new Set(dupes)].join(", ")}`);

// -------------------------------------------------------------------- render
const { files, posts, pages, warnings } = renderSite({
  template, site, theme: record.theme, records,
});
for (const w of warnings) console.warn(`  theme: ${w}`);

await mkdir(path.join(SITE, "assets"), { recursive: true });
for (const [name, body] of Object.entries(files)) {
  await mkdir(path.dirname(path.join(SITE, name)), { recursive: true });
  await writeFile(path.join(SITE, name), body);
  if (name.endsWith(".html")) console.log(`  ${name}`);
}

// Only the assets renderSite could not emit. Stylesheets, scripts and the
// favicon are already in `files`; copying them again here would be a second
// source for the same bytes, and the two would eventually disagree.
const emitted = new Set(Object.keys(files));
for (const rel of template.assets) {
  const target = `assets/${path.basename(rel)}`;
  if (emitted.has(target)) continue;
  await copyFile(path.join(templateDir, rel), path.join(SITE, target));
}

// Remove rendered pages that no longer correspond to published content. Without
// this, un-publishing leaves the HTML behind in site/ and the next deploy syncs
// it straight back to the live bucket -- the post disappears from the index and
// the feed but stays reachable at its URL.
const keep = new Set(Object.keys(files));
for (const f of await readdir(SITE)) {
  if (!f.endsWith(".html") || keep.has(f)) continue;
  await rm(path.join(SITE, f));
  console.log(`  pruned ${f}`);
}

// The admin's category picker and its customization form both read this, so the
// editor can only offer what the site and the active template actually declare.
await writeFile(path.join(SITE, "taxonomy.json"), JSON.stringify({
  categories: record.taxonomy.categories,
  template: { id: template.manifest.id, name: template.manifest.name, version: template.manifest.version },
  theme: tokenForm(template.manifest, record.theme),
}, null, 2));



console.log(`\nbuilt ${posts.length} post(s) and ${pages.length} page(s) + index, feeds, 404`);
console.log("deploy with: node cli/deploy.mjs");
