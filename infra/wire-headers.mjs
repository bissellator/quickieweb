#!/usr/bin/env node
// Attaches security response headers to the shared hosted distribution.
//
//   node infra/wire-headers.mjs            attach
//   node infra/wire-headers.mjs --status   report only, change nothing
//
// WHY THIS EXISTS SEPARATELY FROM wire-edge.mjs / wire-cloudfront.mjs
//
// Those two are single-site heritage and predate the hosted, multi-tenant
// distribution. wire-cloudfront.mjs would add an `/admin*` cache behavior with
// its own rewrite function (`qw-admin-rewrite`), which on this distribution is
// both redundant and wrong: `quickieweb-tenant-router` already maps Host to a
// prefix, including app.<domain> -> /admin/. Running it here would leave two
// rewrite functions with overlapping jobs.
//
// THE THING THAT MAKES THIS NON-OBVIOUS
//
// CloudFront picks a cache behavior from the URI the VIEWER sent, and only then
// runs that behavior's viewer-request function. The tenant router rewrites
// app.quickieweb.com/app.js to /admin/app.js *after* the behavior was already
// chosen -- so console requests are served by the DEFAULT behavior, exactly
// like a tenant site's pages. An `/admin*` behavior would never match them.
//
// So one policy has to cover both the console and every tenant site, and it
// therefore has to be the permissive one: the console loads Google Identity
// Services, and a policy that forbids it would fill the console with violations
// -- report-only, so nothing breaks, but noise that reads as a fault.
//
// The strict policy for tenant sites becomes possible when app.quickieweb.com
// gets its own distribution. Until then this is the honest ceiling, and the CSP
// is REPORT-ONLY regardless: it is here to collect violations, not to enforce.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadConfig(ROOT).catch(reportConfigError);

const STATUS_ONLY = process.argv.includes("--status");
// The HOSTED distribution, not deploy.distributionId -- that one is the
// single-site heritage and is still REPLACE-ME on a hosted install.
const DIST = config.hosted?.distributionId;
const POLICY = "quickieweb-shared-headers";

if (!DIST || DIST.includes("REPLACE-ME")) {
  console.error("FATAL: no hosted.distributionId in config.json."
    + " Run: node infra/provision-hosted.mjs");
  process.exit(1);
}

async function aws(args, { allowFail = false } = {}) {
  try {
    const { stdout } = await execFileAsync("aws", [...args, "--output", "json"],
      { maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`aws ${args.slice(0, 3).join(" ")} failed:\n  ${String(err.stderr || err.message).trim()}`);
  }
}

const log = (s) => console.log(`    ${s}`);
const step = (n, s) => console.log(`\n[${n}] ${s}`);

// Every relaxation below is load-bearing:
//   accounts.google.com    the GIS client script, its styles, its connections
//   'unsafe-inline' style  CKEditor sets element styles at runtime
//   googleusercontent.com  the signed-in user's avatar
//   img-src https: blob:   the editor shows body images from the site's own
//                          host (any custom domain) and fresh uploads as blobs
//   data: fonts/images     the generated favicon, and CKEditor's inline icons
//   login.microsoftonline.com   Microsoft sign-in redeems its code here
//                          (admin/ui/ms-signin.js); the authorize step is a
//                          top-level navigation, which CSP does not govern
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://accounts.google.com https://login.microsoftonline.com",
  // Kept for browsers that have not moved One Tap to FedCM. With
  // use_fedcm_for_prompt the browser renders the chooser itself and no iframe
  // is embedded, but the fallback still needs to be allowed.
  "frame-src https://accounts.google.com",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

const PERMISSIONS = "camera=(), microphone=(), geolocation=(), payment=(), usb=()";

const policyConfig = {
  Name: POLICY,
  Comment: "Shared: GIS-aware CSP (report-only), HSTS, COOP for Google sign-in",
  SecurityHeadersConfig: {
    StrictTransportSecurity: {
      Override: true,
      AccessControlMaxAgeSec: 63072000,
      IncludeSubdomains: true,
      // Not preload. Preload is a submission to a browser-baked list and is
      // effectively irreversible; it should be a deliberate later decision, not
      // a side effect of turning HSTS on.
      Preload: false,
    },
    ContentTypeOptions: { Override: true },
    // SAMEORIGIN, not DENY. The console frames its own preview
    // (/api/preview/<token>/…), and DENY on a shared policy would break it.
    // Third-party framing -- the actual threat -- is refused either way.
    FrameOptions: { Override: true, FrameOption: "SAMEORIGIN" },
    ReferrerPolicy: { Override: true, ReferrerPolicy: "strict-origin-when-cross-origin" },
    // X-XSS-Protection is deliberately absent: deprecated, its filter has
    // introduced vulnerabilities of its own, and CSP replaces it.
  },
  CustomHeadersConfig: {
    Quantity: 3,
    Items: [
      { Header: "Permissions-Policy", Value: PERMISSIONS, Override: true },
      // Report-only, sent as a custom header because SecurityHeadersConfig can
      // only emit the enforcing Content-Security-Policy.
      { Header: "Content-Security-Policy-Report-Only", Value: CSP, Override: true },
      // same-origin-allow-popups, never same-origin. Google Identity Services
      // opens a popup and talks to it via postMessage; plain same-origin severs
      // that channel and sign-in hangs with no error.
      { Header: "Cross-Origin-Opener-Policy", Value: "same-origin-allow-popups", Override: true },
    ],
  },
};

console.log(`distribution ${DIST}${STATUS_ONLY ? "  (status only)" : ""}`);

// ------------------------------------------------------------------- policy
step(1, "Response headers policy");
const list = await aws(["cloudfront", "list-response-headers-policies", "--type", "custom"],
  { allowFail: true });
const found = (list?.ResponseHeadersPolicyList?.Items ?? [])
  .find((i) => i.ResponseHeadersPolicy?.ResponseHeadersPolicyConfig?.Name === POLICY);

let policyId = found?.ResponseHeadersPolicy?.Id ?? null;

if (STATUS_ONLY) {
  log(policyId ? `exists ${policyId}` : "MISSING (status only, not creating)");
} else if (!policyId) {
  const res = await aws(["cloudfront", "create-response-headers-policy",
    "--response-headers-policy-config", JSON.stringify(policyConfig)]);
  policyId = res.ResponseHeadersPolicy.Id;
  log(`created ${policyId}`);
} else {
  const current = await aws(["cloudfront", "get-response-headers-policy", "--id", policyId]);
  await aws(["cloudfront", "update-response-headers-policy",
    "--id", policyId, "--if-match", current.ETag,
    "--response-headers-policy-config", JSON.stringify(policyConfig)]);
  log(`updated ${policyId}`);
}

// ------------------------------------------------------------------- attach
step(2, "Attach to every behavior");
const dist = await aws(["cloudfront", "get-distribution-config", "--id", DIST]);
const cfg = dist.DistributionConfig;
const etag = dist.ETag;

const behaviors = [cfg.DefaultCacheBehavior, ...(cfg.CacheBehaviors?.Items ?? [])];
let changed = false;
// Behaviors that carry a stricter policy of their own, set by the script named.
const OWNED = { "/__qw/comments/*": "infra/wire-comments.mjs" };
for (const b of behaviors) {
  const name = b.PathPattern ?? "(default)";
  if (OWNED[name]) {
    log(`${name}: has its own headers policy (${OWNED[name]}), left alone`);
    continue;
  }
  if (b.ResponseHeadersPolicyId === policyId) {
    log(`${name}: already attached`);
    continue;
  }
  log(`${name}: ${b.ResponseHeadersPolicyId ? "replacing" : "attaching"}`);
  // Everything else on the behavior is left exactly as found -- origins, cache
  // policies and above all FunctionAssociations, which is where the tenant
  // router lives. This script attaches headers and touches nothing else.
  if (!STATUS_ONLY) b.ResponseHeadersPolicyId = policyId;
  changed = true;
}

if (STATUS_ONLY) {
  console.log("\nstatus only, nothing changed.");
  process.exit(0);
}
if (!changed) {
  console.log("\nalready wired, nothing to do.");
  process.exit(0);
}

await aws(["cloudfront", "update-distribution", "--id", DIST, "--if-match", etag,
  "--distribution-config", JSON.stringify(cfg)]);
console.log(`\nattached ${POLICY} to ${behaviors.length} behavior(s).`);
console.log("CloudFront takes a few minutes to deploy. CSP is REPORT-ONLY:");
console.log("watch the browser console for violations before promoting it.");
