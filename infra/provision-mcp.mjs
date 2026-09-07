#!/usr/bin/env node
// Puts mcp.<domain> in front of the MCP function.
//
//   node infra/provision-mcp.mjs
//   node infra/provision-mcp.mjs --status
//
// Its own distribution, deliberately, for three reasons:
//
//   NO CustomErrorResponses. The shared distribution rewrites 403 and 404 into
//   the platform's HTML 404 page, so an agent told "you are not an owner of
//   that site" would read "not found" and conclude the site does not exist.
//   This one passes status codes through untouched.
//
//   A viewer-response function. Lambda function URLs rename WWW-Authenticate to
//   x-amzn-Remapped-WWW-Authenticate, which no MCP client looks at, so the 401
//   challenge that begins discovery never registers. edge/mcp-headers.js
//   renames it back. Without it nothing can log in and the symptom is a server
//   that appears to 401 forever.
//
//   No tenant router. mcp.<domain> is not a site, and the shared distribution's
//   viewer-request function would map it to a tenant prefix and 404.
//
// The wildcard certificate already covers this name, so nothing new is issued.

import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig, reportConfigError } from "../cli/lib/config.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "config.json");
const config = await loadConfig(ROOT).catch(reportConfigError);

const STATUS_ONLY = process.argv.includes("--status");
const FN = "qw-mcp";
const EDGE_FN = "quickieweb-mcp-headers";

const { domain: DOMAIN, hostedZoneId: ZONE, certificateArn: CERT } = config.hosted ?? {};
for (const [k, v] of Object.entries({ domain: DOMAIN, hostedZoneId: ZONE, certificateArn: CERT })) {
  if (!v || String(v).includes("REPLACE-ME")) {
    console.error(`FATAL: hosted.${k} is not set. Run: node infra/provision-hosted.mjs`);
    process.exit(1);
  }
}
const HOST = `mcp.${DOMAIN}`;

// Managed policies: never cache, and forward everything except Host (which a
// function URL rejects if it is the viewer's).
const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
const ALL_VIEWER_EXCEPT_HOST = "b689b0a8-53d0-40ab-baf2-68738e2966ac";

async function aws(args, { allowFail = false, region = "us-east-1" } = {}) {
  try {
    const { stdout } = await execFileAsync("aws", [...args, "--region", region, "--output", "json"],
      { maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`aws ${args.slice(0, 3).join(" ")} failed:\n  ${String(err.stderr || err.message).trim()}`);
  }
}

const log = (s) => console.log(`    ${s}`);
const step = (n, s) => console.log(`\n[${n}] ${s}`);

console.log(`provision ${HOST}${STATUS_ONLY ? "  (status only)" : ""}`);

// ------------------------------------------------------------- function url
step(1, "MCP function URL");
const urlCfg = await aws(["lambda", "get-function-url-config", "--function-name", FN], { allowFail: true });
if (!urlCfg) {
  console.error(`FATAL: ${FN} has no function URL. Run: node infra/deploy-mcp.mjs`);
  process.exit(1);
}
const originDomain = new URL(urlCfg.FunctionUrl).host;
log(originDomain);

// -------------------------------------------------------------- edge function
step(2, "Viewer-response header fix");
const codePath = path.join(ROOT, "infra", "edge", "mcp-headers.js");
let fnArn = null;

if (!STATUS_ONLY) {
  const fnConfig = {
    Comment: "Restore WWW-Authenticate, which function URLs rename",
    Runtime: "cloudfront-js-2.0",
  };
  const describe = await aws(["cloudfront", "describe-function", "--name", EDGE_FN], { allowFail: true });
  const saved = describe
    ? await aws(["cloudfront", "update-function", "--name", EDGE_FN, "--if-match", describe.ETag,
        "--function-config", JSON.stringify(fnConfig), "--function-code", `fileb://${codePath}`])
    : await aws(["cloudfront", "create-function", "--name", EDGE_FN,
        "--function-config", JSON.stringify(fnConfig), "--function-code", `fileb://${codePath}`]);
  const published = await aws(["cloudfront", "publish-function", "--name", EDGE_FN,
    "--if-match", saved.ETag]);
  fnArn = published.FunctionSummary.FunctionMetadata.FunctionARN;
  log(`published ${fnArn}`);
} else {
  const describe = await aws(["cloudfront", "describe-function", "--name", EDGE_FN], { allowFail: true });
  log(describe ? "exists" : "MISSING (status only, not creating)");
}

// ------------------------------------------------------------- distribution
step(3, "Distribution");
const list = await aws(["cloudfront", "list-distributions"]);
const found = (list?.DistributionList?.Items ?? [])
  .find((d) => (d.Aliases?.Items ?? []).includes(HOST));

if (found) {
  log(`exists ${found.Id} (${found.DomainName})`);
} else if (STATUS_ONLY) {
  log("MISSING (status only, not creating)");
} else {
  const distConfig = {
    CallerReference: `qw-mcp-${Date.now()}`,
    Comment: "Quickieweb MCP server",
    Enabled: true,
    Aliases: { Quantity: 1, Items: [HOST] },
    Origins: {
      Quantity: 1,
      Items: [{
        Id: "mcp-fn",
        DomainName: originDomain,
        OriginPath: "",
        CustomHeaders: { Quantity: 0, Items: [] },
        CustomOriginConfig: {
          HTTPPort: 80, HTTPSPort: 443,
          OriginProtocolPolicy: "https-only",
          OriginSslProtocols: { Quantity: 1, Items: ["TLSv1.2"] },
          OriginReadTimeout: 60,
          OriginKeepaliveTimeout: 5,
        },
      }],
    },
    DefaultCacheBehavior: {
      TargetOriginId: "mcp-fn",
      ViewerProtocolPolicy: "https-only",
      AllowedMethods: {
        Quantity: 7,
        Items: ["HEAD", "DELETE", "POST", "GET", "OPTIONS", "PUT", "PATCH"],
        CachedMethods: { Quantity: 2, Items: ["HEAD", "GET"] },
      },
      Compress: true,
      CachePolicyId: CACHING_DISABLED,
      OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST,
      FunctionAssociations: {
        Quantity: 1,
        Items: [{ EventType: "viewer-response", FunctionARN: fnArn }],
      },
      LambdaFunctionAssociations: { Quantity: 0, Items: [] },
    },
    // Deliberately absent: CustomErrorResponses. An API client has to be able to
    // tell "forbidden" from "not found".
    ViewerCertificate: {
      ACMCertificateArn: CERT,
      SSLSupportMethod: "sni-only",
      MinimumProtocolVersion: "TLSv1.2_2021",
      CertificateSource: "acm",
    },
    HttpVersion: "http2and3",
    IsIPV6Enabled: true,
    PriceClass: "PriceClass_100",
  };

  const created = await aws(["cloudfront", "create-distribution",
    "--distribution-config", JSON.stringify(distConfig)]);
  log(`created ${created.Distribution.Id} (${created.Distribution.DomainName})`);
}

const dist = found ?? (await aws(["cloudfront", "list-distributions"]))
  ?.DistributionList?.Items?.find((d) => (d.Aliases?.Items ?? []).includes(HOST));

if (STATUS_ONLY || !dist) {
  console.log(STATUS_ONLY ? "\nstatus only, nothing changed." : "\nno distribution yet.");
  process.exit(0);
}

// ----------------------------------------------------------------------- dns
step(4, "DNS");
const change = {
  Comment: `${HOST} -> CloudFront`,
  Changes: ["A", "AAAA"].map((Type) => ({
    Action: "UPSERT",
    ResourceRecordSet: {
      Name: HOST, Type,
      AliasTarget: {
        // The fixed CloudFront hosted zone id, the same in every account.
        HostedZoneId: "Z2FDTNDATAQYW2",
        DNSName: dist.DomainName,
        EvaluateTargetHealth: false,
      },
    },
  })),
};
await aws(["route53", "change-resource-record-sets", "--hosted-zone-id", ZONE,
  "--change-batch", JSON.stringify(change)], { region: "us-east-1" });
log(`${HOST} -> ${dist.DomainName}`);

// -------------------------------------------------------------------- config
const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
raw.hosted = { ...raw.hosted, mcpDistributionId: dist.Id, mcpOrigin: `https://${HOST}` };
await execFileAsync("node", ["-e",
  `require("fs").writeFileSync(${JSON.stringify(CONFIG_PATH)}, ${JSON.stringify(JSON.stringify(raw, null, 2) + "\n")})`]);
log("config.json updated");

console.log(`\n  ${HOST} -> ${dist.DomainName}`);
console.log("CloudFront takes a few minutes. Then:");
console.log(`  curl -i -X POST https://${HOST}/mcp -d '{}'   # expect 401 + WWW-Authenticate`);
