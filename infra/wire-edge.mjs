#!/usr/bin/env node
// Creates the edge resources the distribution will reference: two response
// headers policies and the /admin* URI-rewrite function.
//
//   node infra/wire-edge.mjs
//
// ADDITIVE AND IDEMPOTENT. Nothing here changes what any viewer sees. A
// response headers policy does nothing until a cache behavior names it, and a
// CloudFront Function does nothing until it is associated. Attaching them is
// infra/wire-cloudfront.mjs, deliberately a separate step, because that one is
// user-visible and this one is not.
//
// WHY THESE HEADERS
//
// The distribution had no ResponseHeadersPolicy on any behavior, so the public
// site shipped no security headers at all. The only ones anywhere were three
// the Lambda set by hand on admin responses -- which is exactly what moving the
// admin UI to S3 would have silently dropped, because S3 sets none of them.
//
// One of those three is load-bearing rather than decorative:
// Cross-Origin-Opener-Policy: same-origin-allow-popups. Google Identity
// Services opens a popup and talks to it via postMessage; the default COOP
// severs that channel and sign-in hangs. If it is missing from the admin
// policy, nobody can log in.
//
// CSP ships REPORT-ONLY here and is promoted to enforcing later. GIS plus
// CKEditor is precisely the combination that fails silently and only at the
// moment someone tries to sign in, and there is no staging distribution to
// catch it. Report-only surfaces violations in the browser console without
// blocking anything.

import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// CloudFront's control plane is global but signs in us-east-1.
const REGION = "us-east-1";

const SITE_POLICY = "qw-site-headers";
const ADMIN_POLICY = "qw-admin-headers";
const REWRITE_FN = "qw-admin-rewrite";

async function aws(args, { allowFail = false } = {}) {
  try {
    const { stdout } = await execFileAsync("aws",
      [...args, "--region", REGION, "--output", "json"], { maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`aws ${args.slice(0, 3).join(" ")} failed:\n  ${String(err.stderr || err.message).trim()}`);
  }
}

const step = (n, s) => console.log(`\n[${n}] ${s}`);
const log = (s) => console.log(`    ${s}`);

// --------------------------------------------------------------- policies

const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=(), usb=()";

// The public site loads only same-origin CSS and an SVG favicon -- no external
// script, no web fonts -- so it can take a genuinely strict policy. The one
// thing to watch is the inline <script type="application/ld+json"> block in
// shared/render.mjs: browsers do not execute JSON-LD so script-src should not
// apply, but per-article content makes hashing impractical, so verify before
// promoting this out of report-only.
const SITE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

// Looser by necessity, and every relaxation below is load-bearing:
//   accounts.google.com  GIS client script, its injected stylesheet, its iframe
//   'unsafe-inline' style  CKEditor injects element styles at runtime
//   googleusercontent.com  the signed-in user's avatar
//   img-src https: blob:   the editor shows body images from the site's own
//                          host (any custom domain) and fresh uploads as blobs
const ADMIN_CSP = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://accounts.google.com",
  "frame-src https://accounts.google.com",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

function policyConfig({ name, comment, csp, coop }) {
  const custom = [
    { Header: "Permissions-Policy", Value: PERMISSIONS_POLICY, Override: true },
    // Report-only: sent as a custom header because SecurityHeadersConfig can
    // only emit the enforcing Content-Security-Policy.
    { Header: "Content-Security-Policy-Report-Only", Value: csp, Override: true },
  ];
  if (coop) {
    custom.push({ Header: "Cross-Origin-Opener-Policy", Value: coop, Override: true });
  }

  return {
    Name: name,
    Comment: comment,
    SecurityHeadersConfig: {
      StrictTransportSecurity: {
        Override: true,
        AccessControlMaxAgeSec: 63072000,
        IncludeSubdomains: true,
        // Not preload. Preload is a submission to a browser-baked list and is
        // effectively irreversible; it should be a deliberate later decision,
        // not a side effect of turning HSTS on.
        Preload: false,
      },
      ContentTypeOptions: { Override: true },
      FrameOptions: { Override: true, FrameOption: "DENY" },
      ReferrerPolicy: { Override: true, ReferrerPolicy: "strict-origin-when-cross-origin" },
      // XSSProtection is deliberately omitted. X-XSS-Protection is deprecated,
      // its filter has introduced vulnerabilities of its own, and CSP replaces
      // it. Modern guidance is to not send it at all.
    },
    CustomHeadersConfig: { Quantity: custom.length, Items: custom },
  };
}

async function upsertPolicy(config) {
  const existing = await aws(["cloudfront", "list-response-headers-policies",
    "--type", "custom"], { allowFail: true });

  const found = (existing?.ResponseHeadersPolicyList?.Items ?? [])
    .find((i) => i.ResponseHeadersPolicy?.ResponseHeadersPolicyConfig?.Name === config.Name);

  if (!found) {
    const res = await aws(["cloudfront", "create-response-headers-policy",
      "--response-headers-policy-config", JSON.stringify(config)]);
    log(`created ${config.Name} -> ${res.ResponseHeadersPolicy.Id}`);
    return res.ResponseHeadersPolicy.Id;
  }

  const id = found.ResponseHeadersPolicy.Id;
  const current = await aws(["cloudfront", "get-response-headers-policy", "--id", id]);
  await aws(["cloudfront", "update-response-headers-policy",
    "--id", id, "--if-match", current.ETag,
    "--response-headers-policy-config", JSON.stringify(config)]);
  log(`updated ${config.Name} -> ${id}`);
  return id;
}

step(1, "Response headers policies");
const siteId = await upsertPolicy(policyConfig({
  name: SITE_POLICY,
  comment: "Public site: strict CSP (report-only), HSTS, nosniff, DENY framing",
  csp: SITE_CSP,
}));
const adminId = await upsertPolicy(policyConfig({
  name: ADMIN_POLICY,
  comment: "Admin: GIS-aware CSP (report-only) + COOP required by Google sign-in",
  csp: ADMIN_CSP,
  coop: "same-origin-allow-popups",
}));

// ---------------------------------------------------------------- function

step(2, "Admin URI-rewrite function");
const code = await readFile(path.join(ROOT, "infra", "edge", "admin-rewrite.js"), "utf8");

const fnConfig = {
  Comment: "Serve /admin/ as /admin/index.html; DefaultRootObject covers only /",
  Runtime: "cloudfront-js-2.0",
};

let fnEtag = null;
const describe = await aws(["cloudfront", "describe-function", "--name", REWRITE_FN],
  { allowFail: true });

if (!describe) {
  const created = await aws(["cloudfront", "create-function", "--name", REWRITE_FN,
    "--function-config", JSON.stringify(fnConfig),
    "--function-code", `fileb://${path.join(ROOT, "infra", "edge", "admin-rewrite.js")}`]);
  fnEtag = created.ETag;
  log(`created ${REWRITE_FN}`);
} else {
  const updated = await aws(["cloudfront", "update-function", "--name", REWRITE_FN,
    "--if-match", describe.ETag,
    "--function-config", JSON.stringify(fnConfig),
    "--function-code", `fileb://${path.join(ROOT, "infra", "edge", "admin-rewrite.js")}`]);
  fnEtag = updated.ETag;
  log(`updated ${REWRITE_FN}`);
}

// A function must be published before a distribution can associate it. The
// DEVELOPMENT stage is only reachable by test-function.
const published = await aws(["cloudfront", "publish-function",
  "--name", REWRITE_FN, "--if-match", fnEtag]);
const fnArn = published.FunctionSummary.FunctionMetadata.FunctionARN;
log(`published -> ${fnArn}`);

// ------------------------------------------------------------------ report

console.log(`\nCreated. Nothing is attached yet -- no viewer sees any change.`);
console.log(`\n  site headers policy   ${siteId}`);
console.log(`  admin headers policy  ${adminId}`);
console.log(`  admin rewrite fn      ${fnArn}`);
console.log(`\nAttach with: node infra/wire-cloudfront.mjs`);
console.log(`Code chars: ${code.length}`);
