// Loads infra/edge/comment-writer.js the way test/edge.test.mjs loads the
// router: the shipped file, evaluated as-is, with `cloudfront` swapped for an
// in-memory store, `crypto` for node:crypto, and Date for a settable clock.
// Not a test file itself (no .test.mjs), so `node --test test/*.test.mjs` only
// runs it through the tests that import it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @returns { handler, store, setClock, put }
 *   put(host, uri, { ticket, length, headers }) runs a PUT through the handler
 */
export function loadWriter({ apex = "quickieweb.com", secret, now }) {
  const store = new Map(secret ? [["_secret", secret]] : []);
  let clock = now;
  const cf = {
    kvs: () => ({
      exists: async (k) => store.has(k),
      get: async (k) => { if (!store.has(k)) throw new Error("key not found"); return store.get(k); },
    }),
  };
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [clock])); }
    static now() { return clock; }
  }
  const source = readFileSync(path.join(ROOT, "infra", "edge", "comment-writer.js"), "utf8")
    .replace("__APEX__", apex)
    .replace(/^import cf from 'cloudfront';$/m, "")
    .replace(/^import crypto from 'crypto';$/m, "");
  // eslint-disable-next-line no-new-func -- our own file, in a test, on purpose.
  const handler = new Function("cf", "crypto", "Date", `${source}; return handler;`)(cf, crypto, FakeDate);

  const put = (host, uri, { ticket, length = 20, headers = {}, method = "PUT" } = {}) => handler({
    request: {
      method,
      uri,
      querystring: {},
      cookies: {},
      headers: {
        ...(host === null ? {} : { host: { value: host } }),
        ...(ticket === undefined ? {} : { "x-qw-ticket": { value: ticket } }),
        ...(length === null ? {} : { "content-length": { value: String(length) } }),
        ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, { value: v }])),
      },
    },
  });

  return { handler, store, setClock: (ms) => { clock = ms; }, put };
}
