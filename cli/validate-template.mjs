#!/usr/bin/env node
// Check a template package against the contract in docs/TEMPLATE-SPEC.md.
//
//   node cli/validate-template.mjs templates/journal
//   node cli/validate-template.mjs templates/*            check several
//   node cli/validate-template.mjs templates/journal --json
//
// Exit code 0 means the template is publishable. Anything else means it is not,
// which is what makes this usable from CI, from the upload path, and from an
// agent iterating on a template it just wrote.

import path from "node:path";
import { access } from "node:fs/promises";
import { readTemplateSources, listLocalTemplates } from "./lib/template-fs.mjs";
import { validateTemplate } from "../shared/template/validate.mjs";

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const given = args.filter((a) => !a.startsWith("--"));

if (!given.length) {
  console.error("usage: node cli/validate-template.mjs <template-dir | templates-root> [more…] [--json]");
  process.exit(2);
}

// A path with no template.json is treated as a directory OF templates, so
// `validate-template.mjs templates` checks all of them. npm scripts do not glob
// on Windows, and `templates/*` reaching the script as a literal asterisk is a
// confusing way to find that out.
const dirs = [];
for (const arg of given) {
  const isTemplate = await access(path.join(arg, "template.json")).then(() => true, () => false);
  if (isTemplate) { dirs.push(arg); continue; }
  const children = await listLocalTemplates(arg);
  if (children.length) dirs.push(...children.map((c) => c.dir));
  else dirs.push(arg);   // let it fail below with a real error
}

const results = [];

for (const dir of dirs) {
  let sources;
  try {
    ({ sources } = await readTemplateSources(dir));
  } catch (err) {
    results.push({ dir, ok: false, findings: [{ level: "error", file: dir, line: 1, message: err.message }] });
    continue;
  }
  const { ok, manifest, findings } = validateTemplate(sources);
  results.push({ dir, ok, id: manifest?.id ?? null, version: manifest?.version ?? null, findings });
}

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2));
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

for (const r of results) {
  const errors = r.findings.filter((f) => f.level === "error");
  const warnings = r.findings.filter((f) => f.level === "warning");
  const label = r.id ? `${r.id}@${r.version}` : path.basename(r.dir);

  console.log(`\n${r.ok ? "PASS" : "FAIL"}  ${label}  (${r.dir})`);

  for (const f of errors) console.log(`  error    ${f.file}:${f.line}  ${f.message}`);
  for (const f of warnings) console.log(`  warning  ${f.file}:${f.line}  ${f.message}`);
  if (!errors.length && !warnings.length) console.log("  no findings");
}

const bad = results.filter((r) => !r.ok);
console.log(bad.length
  ? `\n${bad.length} of ${results.length} template(s) failed.`
  : `\n${results.length} template(s) passed.`);

process.exit(bad.length ? 1 : 0);
