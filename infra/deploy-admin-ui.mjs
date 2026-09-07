#!/usr/bin/env node
// Ships the admin UI to S3 as flat files.
//
//   node infra/deploy-admin-ui.mjs --dry-run
//   node infra/deploy-admin-ui.mjs
//   node infra/deploy-admin-ui.mjs --local   write admin/ui/config.json only
//
// WHY THIS EXISTS AS ITS OWN SCRIPT
//
// The admin UI used to be served by the Lambda, out of the deployment bundle,
// so that a bad publish could not take down the tool that fixes a bad publish.
// It is now static objects in the LIVE bucket under the `admin/` prefix, which
// keeps that property for a better reason: `SKIP_PREFIXES` in admin/lib/store.mjs
// excludes `admin/` from both the upload and the delete side of computeChangeset,
// and cli/deploy.mjs excludes it from every sync. Publishing genuinely
// cannot reach these files.
//
// The flip side is that nothing else deploys them either. Hence this script.
//
// It writes to LIVE, not staging. Staging is not fronted by CloudFront, so an
// admin UI there would be unreachable. This is the one thing that is written
// straight to the live bucket rather than promoted through staging, because it
// is not site content -- it never appears in a changeset and it is never
// published.
//
// Uses the AWS CLI rather than the SDK so this stays consistent with the rest
// of the repo's zero-dependency scripts.

import { writeFile, mkdtemp, cp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadConfig(ROOT).catch(reportConfigError);
// The console is one deployment serving every site, so it goes to the shared
// live bucket at the ROOT admin/ prefix -- outside sites/, where no tenant's
// changeset can reach it. That is the same property the old per-site admin had,
// for a better reason: it is not merely excluded from a publish, it is not in
// any site's key space at all.
const LIVE = config.hosted?.tenantLiveBucket || config.deploy.bucket;
const distributionId = config.hosted?.distributionId || config.deploy.distributionId;
const { region, googleClientId } = config.deploy;
const CONSOLE_NAME = config.hosted?.domain ? "Quickieweb" : (config.site?.shortName || config.site?.name || "Admin");

const DRY = process.argv.includes("--dry-run");
// The UI reads /admin/config.json for the Google client id. In production that
// file is generated into the upload staging dir below and never touches the
// repo. Local dev serves admin/ui straight off disk, so it needs a real copy
// there -- gitignored, because config.json is the source of truth and a second
// committed copy would drift from it.
const LOCAL = process.argv.includes("--local");

const missing = Object.entries({ LIVE, distributionId, googleClientId })
  .filter(([, v]) => !v || String(v).includes("REPLACE-ME"));
if (missing.length) {
  console.error("FATAL: deploy target is not configured. Run: node infra/provision.mjs");
  for (const [k, v] of missing) console.error(`  ${k} = ${JSON.stringify(v)}`);
  process.exit(1);
}

function run(cmd, args) {
  console.log(`  ${cmd} ${args.join(" ")}`);
  if (DRY) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))));
  });
}

const clientConfig = () =>
  JSON.stringify({ googleClientId, siteName: CONSOLE_NAME, generatedAt: new Date().toISOString() }, null, 2);

if (LOCAL) {
  const dest = path.join(ROOT, "admin", "ui", "config.json");
  await writeFile(dest, clientConfig());
  console.log(`wrote ${path.relative(ROOT, dest)} for local dev (QW_LOCAL=1)`);
  process.exit(0);
}

console.log(`deploy admin ui${DRY ? " (dry run)" : ""}\n  admin/ui -> s3://${LIVE}/admin/\n`);

// Stage into a temp dir so the generated config.json sits alongside the UI
// without ever being written into the repo, where it would drift from
// config.json and get committed with a client id in two places.
const tmp = await mkdtemp(path.join(os.tmpdir(), "qw-admin-ui-"));
await cp(path.join(ROOT, "admin", "ui"), tmp, { recursive: true });

// The admin used to learn the client id by calling /api/health on every page
// load, which woke the Lambda for a build-time constant. It is a flat file now.
// Nothing secret lives here: a Google client id is public by design, and it is
// already visible in the sign-in request every browser makes.
await writeFile(path.join(tmp, "config.json"), clientConfig());
console.log(`  generated config.json (clientId ${googleClientId.slice(0, 12)}...)`);

// The template contract, for the "Build with AI" tab to hand to somebody's
// assistant. Staged from skills/ rather than copied into admin/ui in the repo,
// for the same reason config.json is generated here: a second copy of a
// contract drifts from the validator that enforces it, and the drift is
// invisible until someone's template is rejected for breaking a rule the page
// they were given did not mention.
const CONTRACT = path.join(ROOT, "skills", "quickieweb-template", "SKILL.md");
await cp(CONTRACT, path.join(tmp, "template-contract.md"));
console.log("  staged template-contract.md (from skills/quickieweb-template)");

// --delete so a removed file actually disappears: this prefix is a mirror of
// admin/ui, not an accumulation. Safe precisely because no other process
// writes under admin/.
await run("aws", ["s3", "sync", tmp, `s3://${LIVE}/admin`,
  "--region", region, "--delete",
  // Same split as the rest of the site: the CDN holds it ~forever and we
  // invalidate below; browsers revalidate quickly because we cannot reach them.
  // Deliberately NOT `immutable` -- ckeditor.js is at a stable path, so the
  // bytes there do change on an upgrade.
  "--cache-control", "public,max-age=300,s-maxage=31536000"]);

await run("aws", ["cloudfront", "create-invalidation",
  "--distribution-id", distributionId, "--paths", "/admin/*"]);

console.log(DRY
  ? "\ndry run complete, nothing changed."
  : `\nconsole live at https://app.${config.hosted?.domain ?? config.site?.domain}/`);
