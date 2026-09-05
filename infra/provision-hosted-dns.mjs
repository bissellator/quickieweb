#!/usr/bin/env node
// DNS and TLS for the hosted platform's own apex.
//
//   node infra/provision-hosted-dns.mjs
//   node infra/provision-hosted-dns.mjs --status     report only, change nothing
//   node infra/provision-hosted-dns.mjs --no-wait    request, do not poll
//
// Reads `hosted.domain` from config.json. Creates (or finds) the Route 53 zone,
// requests one certificate covering the apex and a wildcard, writes the DNS
// validation records into that same zone, and waits for ACM to issue.
//
// WHY ONE WILDCARD CERT
//
// Hosted tenants live at <site>.quickieweb.com, which one `*.quickieweb.com`
// certificate covers for all of them at once. The alternative -- a certificate
// per customer domain -- means an ACM request, a DNS validation and a
// distribution alias every time somebody signs up, none of which can complete
// until that customer updates their own DNS. Custom domains are a later tier
// deliberately: they turn signup from an API call into a support conversation.
//
// A wildcard covers exactly one label. `foo.quickieweb.com` is covered;
// `a.b.quickieweb.com` is not. If tenants ever move under a deeper apex, that
// apex needs its own wildcard.
//
// Everything here is idempotent and nothing is destructive: it never deletes a
// zone, a record or a certificate.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadConfig(ROOT).catch(reportConfigError);

const STATUS_ONLY = process.argv.includes("--status");
const NO_WAIT = process.argv.includes("--no-wait");

const DOMAIN = config.hosted?.domain;
if (!DOMAIN || DOMAIN.includes("REPLACE-ME")) {
  console.error("FATAL: set hosted.domain in config.json (the platform apex, e.g. quickieweb.com).");
  process.exit(1);
}
const WILDCARD = `*.${DOMAIN}`;

async function aws(args, { region = "us-east-1", allowFail = false } = {}) {
  try {
    const { stdout } = await execFileAsync("aws",
      [...args, "--region", region, "--output", "json"], { maxBuffer: 16e6 });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`aws ${args.slice(0, 2).join(" ")} failed:\n  ${String(err.stderr || err.message).trim()}`);
  }
}

const log = (s) => console.log(`    ${s}`);
const step = (n, s) => console.log(`\n[${n}] ${s}`);

console.log(`hosted apex ${DOMAIN}${STATUS_ONLY ? "  (status only)" : ""}`);

// -------------------------------------------------------------------- zone
step(1, "Hosted zone");
const zones = await aws(["route53", "list-hosted-zones-by-name", "--dns-name", DOMAIN]);
let zone = (zones.HostedZones ?? []).find((z) => z.Name === `${DOMAIN}.` && !z.Config?.PrivateZone);

if (zone) {
  log(`exists: ${zone.Id.split("/").pop()}`);
} else if (STATUS_ONLY) {
  log("MISSING (status only, not creating)");
  process.exit(0);
} else {
  const created = await aws(["route53", "create-hosted-zone",
    "--name", DOMAIN,
    "--caller-reference", `quickieweb-${Date.now()}`,
    "--hosted-zone-config", `Comment=Quickieweb hosted platform,PrivateZone=false`]);
  zone = created.HostedZone;
  log(`created: ${zone.Id.split("/").pop()}`);
  console.log("\n    Point the registrar at these nameservers before continuing:");
  for (const ns of created.DelegationSet.NameServers) console.log(`      ${ns}`);
}
const ZONE_ID = zone.Id.split("/").pop();

// -------------------------------------------------------------- delegation
step(2, "Delegation");
// ACM validates over the public internet, not through our own account. A cert
// requested before the registrar points here will sit PENDING_VALIDATION until
// it expires after 72 hours, which is a confusing way to lose three days.
const live = await aws(["route53", "get-hosted-zone", "--id", ZONE_ID]);
const ourNs = new Set((live.DelegationSet?.NameServers ?? []).map((n) => n.toLowerCase()));

let delegated = false;
try {
  const { stdout } = await execFileAsync("curl", ["-s", "-m", "15",
    "-H", "accept: application/dns-json",
    `https://dns.google/resolve?name=${DOMAIN}&type=NS`], { maxBuffer: 4e6 });
  const answer = JSON.parse(stdout);
  const seen = (answer.Answer ?? []).map((a) => String(a.data).replace(/\.$/, "").toLowerCase());
  delegated = seen.length > 0 && seen.every((n) => ourNs.has(n));
  log(delegated
    ? "public DNS points at this zone"
    : `public DNS does NOT point here yet (sees: ${seen.join(", ") || "nothing"})`);
} catch {
  // A resolver we cannot reach is not evidence either way; say so and continue
  // rather than pretending we checked.
  log("could not check public DNS from here -- continuing without that evidence");
  delegated = true;
}

if (!delegated && !STATUS_ONLY) {
  console.error("\nFATAL: the registrar is not pointing at this zone yet.\n" +
    "  Requesting a certificate now would sit unvalidated until it expires in 72h.\n" +
    "  Set these nameservers at the registrar, then re-run:");
  for (const ns of live.DelegationSet?.NameServers ?? []) console.error(`    ${ns}`);
  process.exit(1);
}

// -------------------------------------------------------------------- cert
step(3, `Certificate for ${DOMAIN} + ${WILDCARD}`);
const list = await aws(["acm", "list-certificates",
  "--certificate-statuses", "PENDING_VALIDATION", "ISSUED"]);

// Match on the pair, not just the apex: an existing apex-only cert would be the
// wrong one to adopt and would quietly fail for every tenant subdomain.
let arn = null;
for (const c of list.CertificateSummaryList ?? []) {
  if (c.DomainName !== DOMAIN) continue;
  const d = await aws(["acm", "describe-certificate", "--certificate-arn", c.CertificateArn]);
  const names = new Set(d.Certificate.SubjectAlternativeNames ?? []);
  if (names.has(DOMAIN) && names.has(WILDCARD)) { arn = c.CertificateArn; break; }
}

if (arn) {
  log(`exists: ${arn.split("/").pop()}`);
} else if (STATUS_ONLY) {
  log("MISSING (status only, not requesting)");
  process.exit(0);
} else {
  const res = await aws(["acm", "request-certificate",
    "--domain-name", DOMAIN,
    "--subject-alternative-names", WILDCARD,
    "--validation-method", "DNS",
    "--key-algorithm", "RSA_2048",
    "--tags", "Key=purpose,Value=quickieweb-hosted"]);
  arn = res.CertificateArn;
  log(`requested: ${arn.split("/").pop()}`);
  // ACM does not populate the validation CNAMEs immediately.
  await new Promise((r) => setTimeout(r, 8000));
}

// ------------------------------------------------------------- validation
step(4, "Validation records");
let detail = await aws(["acm", "describe-certificate", "--certificate-arn", arn]);
log(`status: ${detail.Certificate.Status}`);

if (detail.Certificate.Status !== "ISSUED") {
  const changes = [];
  const seen = new Set();
  for (const o of detail.Certificate.DomainValidationOptions ?? []) {
    const rr = o.ResourceRecord;
    // The apex and its wildcard validate through the SAME CNAME. Sending it
    // twice in one batch is a duplicate-record error, not a no-op.
    if (!rr || seen.has(rr.Name)) continue;
    seen.add(rr.Name);
    changes.push({
      Action: "UPSERT",
      ResourceRecordSet: { Name: rr.Name, Type: rr.Type, TTL: 300, ResourceRecords: [{ Value: rr.Value }] },
    });
  }

  if (!changes.length) {
    console.error("\nACM has not published validation records yet. Re-run in a minute.");
    process.exit(1);
  }
  if (STATUS_ONLY) {
    log(`${changes.length} record(s) would be written`);
    process.exit(0);
  }

  await aws(["route53", "change-resource-record-sets", "--hosted-zone-id", ZONE_ID,
    "--change-batch", JSON.stringify({ Comment: "ACM validation", Changes: changes })]);
  for (const c of changes) log(`upserted ${c.ResourceRecordSet.Name}`);
}

// ------------------------------------------------------------------- wait
if (detail.Certificate.Status !== "ISSUED" && !NO_WAIT) {
  step(5, "Waiting for ACM");
  log("usually under two minutes once the record is visible");
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 15000));
    detail = await aws(["acm", "describe-certificate", "--certificate-arn", arn]);
    const s = detail.Certificate.Status;
    if (s === "ISSUED") break;
    if (s === "FAILED" || s === "VALIDATION_TIMED_OUT") {
      console.error(`\nFATAL: certificate ${s}.`);
      for (const o of detail.Certificate.DomainValidationOptions ?? []) {
        console.error(`  ${o.DomainName}: ${o.ValidationStatus}`);
      }
      process.exit(1);
    }
    log(`${s} (${(i + 1) * 15}s)`);
  }
}

console.log(`\nzone     ${ZONE_ID}`);
console.log(`cert     ${arn}`);
console.log(`status   ${detail.Certificate.Status}`);
console.log(`covers   ${(detail.Certificate.SubjectAlternativeNames ?? []).join(", ")}`);
if (detail.Certificate.Status === "ISSUED") {
  console.log("\nPut the cert ARN in config.json as hosted.certificateArn, then build the\n" +
    "shared distribution.");
}
