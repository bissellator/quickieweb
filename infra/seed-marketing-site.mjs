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
//
// The seeding itself (what is written where, and in what order) is in
// infra/lib/seed-site.mjs, shared with infra/seed-site.mjs for ordinary tenants.

import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";
import { hostedSettings, isEmail, seedSite } from "./lib/seed-site.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadConfig(ROOT).catch(reportConfigError);

const argv = process.argv.slice(2);
const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const owner = (flag("--owner") ?? "").trim().toLowerCase();
if (!isEmail(owner)) {
  console.error("FATAL: --owner <email> is required (the Google account that will edit it).");
  process.exit(1);
}

const settings = hostedSettings(config);
const dry = argv.includes("--dry-run");
console.log(`marketing site for ${settings.domain}${dry ? "  (dry run)" : ""}`);

await seedSite({
  root: ROOT,
  settings,
  siteId: "www",
  owner,
  // Named from config, not baked in: a self-hoster running this gets their own
  // platform's name at their own apex.
  name: flag("--name")
    ?? config.site?.name
    ?? settings.domain.replace(/\.[a-z.]+$/, "").replace(/^./, (c) => c.toUpperCase()),
  templateId: flag("--template") ?? "journal",
  contentDir: path.join(ROOT, flag("--content") ?? "marketing"),
  shapeNew: (record) => {
    record.site.tagline = config.site?.tagline ?? "";
    record.site.description = config.site?.description ?? "";
    record.site.author = config.site?.author ?? "";
    record.site.nav = [{ label: "Home", href: "/" }];
    record.taxonomy = { categories: { NEWS: { label: "News" }, NOTES: { label: "Notes" } } };
  },
  dry,
});
