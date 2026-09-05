// Reading a template package off disk.
//
// The I/O half of template loading. shared/template/* stays pure so the Lambda
// can feed it bytes from the platform bucket instead; this is the local side.

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { checkManifest, compileTemplate, ManifestError } from "../../shared/template/manifest.mjs";

// Text files are read as UTF-8 and handed to the validator. Everything else is a
// binary asset the build copies through without looking at it.
const TEXT_EXT = new Set([".html", ".css", ".js", ".json", ".txt", ".svg", ".md"]);
// A template is untrusted input. Cap what a package may contain so a hostile or
// broken one cannot exhaust memory in a Lambda that renders many sites.
const MAX_FILES = 200;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

async function walk(root, rel = "") {
  const out = [];
  for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(root, child)));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

/** Every text file in a template directory, keyed by package-relative path. */
export async function readTemplateSources(dir) {
  const rels = await walk(dir);
  if (rels.length > MAX_FILES) {
    throw new Error(`${dir}: ${rels.length} files, more than the ${MAX_FILES} a template may contain`);
  }

  const sources = {};
  const binary = [];
  for (const rel of rels) {
    if (!TEXT_EXT.has(path.extname(rel).toLowerCase())) { binary.push(rel); continue; }
    const full = path.join(dir, rel);
    const { size } = await stat(full);
    if (size > MAX_TEXT_BYTES) throw new Error(`${rel} is ${size} bytes, over the ${MAX_TEXT_BYTES} limit`);
    sources[rel] = await readFile(full, "utf8");
  }
  return { sources, binary };
}

/**
 * Read, validate and compile a template directory.
 * Throws ManifestError when the manifest is unusable -- a site cannot render
 * against a template whose layouts do not compile, and failing here is far
 * cheaper than publishing a broken page.
 */
export async function loadTemplateFromDir(dir) {
  const { sources, binary } = await readTemplateSources(dir);
  if (!sources["template.json"]) throw new Error(`${dir}: no template.json`);

  const { manifest, problems } = checkManifest(JSON.parse(sources["template.json"]));
  if (problems.length) throw new ManifestError(problems);

  const pkg = compileTemplate(manifest, sources);
  if (pkg.missing.length || pkg.errors.length) {
    throw new ManifestError([...pkg.missing.map((m) => `missing file for ${m}`), ...pkg.errors]);
  }

  // Assets the build copies into site/assets/, flattened to their basenames --
  // which is how template.stylesheets and template.scripts address them.
  const assets = [...(manifest.styles ?? []), ...(manifest.scripts ?? []),
    ...(manifest.webfonts ?? []).map((f) => f.src), ...binary];

  return { ...pkg, dir, sources, assets: [...new Set(assets)] };
}

/** The template directories available locally. */
export async function listLocalTemplates(root) {
  let names = [];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return [];
  }

  const out = [];
  for (const name of names) {
    try {
      const raw = JSON.parse(await readFile(path.join(root, name, "template.json"), "utf8"));
      out.push({ dir: path.join(root, name), id: raw.id, name: raw.name, version: raw.version, description: raw.description ?? "" });
    } catch {
      out.push({ dir: path.join(root, name), id: name, name, version: null, description: "(no readable template.json)" });
    }
  }
  return out;
}
