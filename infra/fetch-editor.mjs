#!/usr/bin/env node
// Vendors CKEditor 5 into admin/ui/, where the console loads it from.
//
//   npm run fetch-editor
//   node infra/fetch-editor.mjs --version 48.5.0
//   node infra/fetch-editor.mjs --check      report what is installed, change nothing
//
// WHY FETCHED AND NOT COMMITTED
//
// Two reasons, and both matter.
//
// 1. LICENCE. CKEditor 5 is dual-licensed GPL-2.0-or-later or commercial. This
//    repository is Apache-2.0. Committing the bundle would mean an Apache-2.0
//    project shipping a GPL binary, and anyone redistributing it inheriting an
//    obligation they did not read. Fetching it makes that a choice the installer
//    makes knowingly, at a moment when this file can tell them about it.
//
// 2. WEIGHT. It is ~2 MB of somebody else's minified JavaScript that changes
//    only when we deliberately upgrade. Git is a poor place for that.
//
// WHY THIS IS STILL SELF-HOSTED
//
// Fetched is not the same as CDN-loaded. The bytes land in admin/ui/ and are
// deployed to your own bucket by infra/deploy-admin-ui.mjs; a browser never
// talks to ckeditor.com. That distinction is the whole point: a CDN script has
// execution rights inside the authenticated console with nothing pinning the
// bytes, and it would force the console's CSP past `script-src 'self'`.

import { readFile, writeFile, mkdtemp, rm, cp, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI = path.join(ROOT, "admin", "ui");

const argv = process.argv.slice(2);
const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const CHECK = argv.includes("--check");
// Pinned rather than "latest": a console that silently changes editor version
// between two installs is a support conversation nobody enjoys.
const VERSION = flag("--version") ?? "48.5.0";

const TARGETS = [
  ["dist/browser/ckeditor5.umd.js", "ckeditor.js"],
  ["dist/ckeditor5.css", "ckeditor.css"],
  ["LICENSE.md", "ckeditor-LICENSE.md"],
];

const exists = async (p) => access(p).then(() => true, () => false);
const log = (s) => console.log(`    ${s}`);

if (CHECK) {
  console.log("editor status");
  let all = true;
  for (const [, name] of TARGETS) {
    const at = path.join(UI, name);
    const there = await exists(at);
    all &&= there;
    log(`${name.padEnd(24)} ${there ? "present" : "MISSING"}`);
  }
  if (!all) console.log("\n  Run: npm run fetch-editor");
  process.exit(all ? 0 : 1);
}

console.log(`fetching ckeditor5@${VERSION}\n`);
console.log("  CKEditor 5 is dual-licensed GPL-2.0-or-later or commercial from CKSource.");
console.log("  Quickieweb itself is Apache-2.0; the editor is not, and its terms travel");
console.log("  with it. This installs the GPL arm. See docs/ADMIN.md, 'The editor'.\n");

// Installed into a scratch directory so this repository never gains a dependency
// on a file it vendors by hand.
const tmp = await mkdtemp(path.join(os.tmpdir(), "qw-editor-"));
try {
  await writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: "qw-editor-fetch", private: true }));
  await execFileAsync("npm", ["install", `ckeditor5@${VERSION}`, "--no-audit", "--no-fund", "--loglevel=error"],
    { cwd: tmp, maxBuffer: 64e6, shell: process.platform === "win32" });

  const pkg = path.join(tmp, "node_modules", "ckeditor5");
  const installed = JSON.parse(await readFile(path.join(pkg, "package.json"), "utf8")).version;
  log(`installed ${installed}`);

  for (const [from, to] of TARGETS) {
    const src = path.join(pkg, from);
    if (!(await exists(src))) {
      throw new Error(`ckeditor5@${installed} has no ${from}. The package layout changed; ` +
        "update TARGETS in this script rather than guessing.");
    }
    await cp(src, path.join(UI, to));
    const bytes = (await readFile(path.join(UI, to))).length;
    log(`${to.padEnd(24)} ${(bytes / 1024).toFixed(0)} KB`);
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(`\nVendored into admin/ui/. Deploy it with: node infra/deploy-admin-ui.mjs`);
console.log("These files are gitignored on purpose -- see .gitignore for why.");
