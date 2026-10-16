// The edge store: where the Lambda tells the tenant router who may read what.
//
// A CloudFront KeyValueStore, read by infra/edge/tenant-router.js on every
// request and written here on publish and when a site's security changes. What
// to write, and in what order, is decided by shared/access-plan.mjs; this file
// only talks to AWS.
//
// WHY TWO NEW PACKAGES
//
// The store's write API is signed with SigV4A, not the SigV4 the S3 and
// CloudFront clients use, so it needs its own client plus the SigV4A signer.
// Both are AWS's own SDK, the same family this function already ships.
// `@aws-sdk/signature-v4a` is the pure-JavaScript signer; importing it is what
// registers it with the client.
//
// Not configured (no ACCESS_KVS_ARN) is a legitimate state -- a self-hosted
// install, or the hosted one before infra/provision-access.mjs has run -- and
// every public site keeps working. Protecting a site with no store to enforce it
// is refused loudly instead (see requireEdge).

import "@aws-sdk/signature-v4a";
import {
  CloudFrontKeyValueStoreClient, DescribeKeyValueStoreCommand, GetKeyCommand, UpdateKeysCommand,
} from "@aws-sdk/client-cloudfront-keyvaluestore";

const KVS_ARN = process.env.ACCESS_KVS_ARN ?? "";
// The store is global; its API lives in us-east-1 like the rest of CloudFront.
const client = KVS_ARN ? new CloudFrontKeyValueStoreClient({ region: "us-east-1" }) : null;

// UpdateKeys takes at most 50 changes per call.
const BATCH = 50;

export const edgeConfigured = () => Boolean(KVS_ARN);

// 409, not 5xx: "this installation cannot enforce that" is a state the person
// can act on, and the router only passes 4xx messages through to the console.
export class EdgeError extends Error {
  constructor(message, status = 409) { super(message); this.name = "EdgeError"; this.status = status; }
}

/** Throw unless protection can actually be enforced. */
export function requireEdge() {
  if (!KVS_ARN) {
    throw new EdgeError("Site security is not available on this installation yet: " +
      "the edge access store is not configured (run infra/provision-access.mjs).");
  }
}

// Read once per warm container. Rotating the secret means redeploying, which
// also signs every reader out -- acceptable for something rotated rarely.
let secretPromise = null;
export function accessSecret() {
  requireEdge();
  secretPromise ??= client.send(new GetKeyCommand({ KvsARN: KVS_ARN, Key: "_secret" }))
    .then((r) => {
      if (!r.Value) throw new EdgeError("The edge access store has no _secret.");
      return r.Value;
    })
    .catch((err) => { secretPromise = null; throw err; });
  return secretPromise;
}

/** Apply `{ puts: [{key, value}], deletes: [key] }`. A no-op costs nothing. */
export async function applyEdgeOps({ puts = [], deletes = [] }, onLog = () => {}) {
  if (!puts.length && !deletes.length) return;
  requireEdge();
  const changes = [
    ...deletes.map((key) => ({ del: key })),
    ...puts.map(({ key, value }) => ({ put: { Key: key, Value: value } })),
  ];
  for (let i = 0; i < changes.length; i += BATCH) {
    const chunk = changes.slice(i, i + BATCH);
    // Optimistic concurrency: the ETag of the store as it was just read. A
    // concurrent writer makes this fail rather than interleave silently.
    const { ETag } = await client.send(new DescribeKeyValueStoreCommand({ KvsARN: KVS_ARN }));
    await client.send(new UpdateKeysCommand({
      KvsARN: KVS_ARN,
      IfMatch: ETag,
      Puts: chunk.filter((c) => c.put).map((c) => c.put),
      Deletes: chunk.filter((c) => c.del).map((c) => ({ Key: c.del })),
    }));
  }
  onLog(`edge access: ${puts.length} set, ${deletes.length} removed`);
}
