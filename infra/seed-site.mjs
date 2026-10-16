#!/usr/bin/env node
// Creates a hosted site from the command line: what "+ New site" in the console
// does, for somebody holding AWS credentials instead of a staff session.
//
//   node infra/seed-site.mjs --site acme --owner you@example.com
//   node infra/seed-site.mjs --site acme --owner you@example.com --name "Acme" --template plain
//   node infra/seed-site.mjs --site acme --owner you@example.com --content path/to/json
//   node infra/seed-site.mjs --site acme --owner you@example.com --dry-run
//
// Without --content the site is a blank shell: the template's empty index and
// 404, ready to be edited in the console or published to.
//
// WHY THIS EXISTS
//
// For a tenant created before anyone can sign in to the console for it -- a
// site being set up on somebody's behalf, or a test tenant -- and for
// provisioning that should be scripted rather than clicked.
//
// It is NOT a way around the reserved list. The id goes through the same
// checkSiteId() as the create API, so `www`, `app`, `admin` and the rest are
// refused here too. The apex site has its own script, infra/seed-marketing-site.mjs,
// for exactly that one case.
//
// Re-running is safe: an existing site record is reused, never replaced.

import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";
import { checkSiteId } from "../shared/site.mjs";
import { hostedSettings, isEmail, seedSite } from "./lib/seed-site.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadConfig(ROOT).catch(reportConfigError);

const argv = process.argv.slice(2);
const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);

const siteId = (flag("--site") ?? "").trim().toLowerCase();
const bad = checkSiteId(siteId);
if (!siteId || bad) {
  console.error(`FATAL: --site ${siteId ? `"${siteId}" ${bad}` : "<id> is required"}.`);
  process.exit(1);
}
const owner = (flag("--owner") ?? "").trim().toLowerCase();
if (!isEmail(owner)) {
  console.error("FATAL: --owner <email> is required (the Google account that will edit it).");
  process.exit(1);
}

const settings = hostedSettings(config);
const dry = argv.includes("--dry-run");
console.log(`site ${siteId}.${settings.domain}${dry ? "  (dry run)" : ""}`);

const content = flag("--content");
await seedSite({
  root: ROOT,
  settings,
  siteId,
  owner,
  name: flag("--name") ?? siteId,
  templateId: flag("--template") ?? "journal",
  contentDir: content ? path.resolve(content) : null,
  dry,
});
