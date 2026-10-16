// The tenant router as CloudFront receives it: one build, shared by every script
// that uploads it (infra/provision-hosted.mjs, infra/provision-access.mjs).
//
// One build because two would drift. The failure that matters is specific: a
// script that uploads the router WITHOUT the edge-store association silently
// detaches the store, after which every protected site 503s (the function
// throws when it cannot read the store). So the association is part of the
// function's config here, not something a caller remembers to add.

import { readFile } from "node:fs/promises";
import path from "node:path";

// CloudFront's limit for a function's code.
export const MAX_FUNCTION_BYTES = 10 * 1024;

export const routerName = (domain) => `${domain.split(".")[0]}-tenant-router`;

/**
 * The router's source with its apex filled in and full-line comments removed.
 * Only whole-line comments: a trailing `//` may be inside a string
 * ('https://...'), and stripping it would change the program.
 */
export async function buildRouterSource(root, domain) {
  const raw = await readFile(path.join(root, "infra", "edge", "tenant-router.js"), "utf8");
  const src = raw.replace("__APEX__", domain)
    .split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join("\n");
  if (src.includes("__APEX__") || !src.includes(domain)) {
    throw new Error("tenant-router.js did not get its apex substituted -- refusing to publish it");
  }
  const bytes = Buffer.byteLength(src);
  if (bytes >= MAX_FUNCTION_BYTES) {
    throw new Error(`tenant-router.js is ${bytes} bytes after stripping comments; CloudFront allows ${MAX_FUNCTION_BYTES}`);
  }
  return src;
}

/** The function config, always carrying the store association when there is one. */
export function routerConfig(domain, kvsArn) {
  return {
    Comment: `${domain} host -> tenant prefix, reader access`,
    Runtime: "cloudfront-js-2.0",
    ...(kvsArn ? { KeyValueStoreAssociations: { Quantity: 1, Items: [{ KeyValueStoreARN: kvsArn }] } } : {}),
  };
}
