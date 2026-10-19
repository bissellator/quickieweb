// Custom-domain mirrors in the shared LIVE bucket's policy. Pure: no AWS calls.
//
// A mirror is a CloudFront distribution of a site's own -- a custom domain with
// its own certificate -- whose origin is the shared live bucket with the site's
// prefix as its origin path. It has to be let in by the bucket policy, and it
// must be let in to THAT SITE'S PREFIX ONLY: the bucket holds every tenant's
// pages, protected sites included, and a mirror that could read the whole
// bucket would serve any of them to anyone who guessed a path.
//
// Two edits to the template's document, both keyed by the mirror's ARN:
//
//   1. an Allow of s3:GetObject on <bucket>/<prefix>* for that distribution
//   2. its ARN added to the DenyAnonymousAndCrossAccount SourceArn list, without
//      which that explicit Deny overrides the Allow (the keys are ANDed under
//      StringNotEquals, and a mirror's SourceArn is not the shared one)
//
// Used by infra/provision-hosted.mjs (which writes the policy from the template)
// and infra/wire-mirror.mjs (which adds a mirror), so the two can never disagree
// and re-provisioning does not silently cut a custom domain off.

const PREFIX_RE = /^sites\/[a-z0-9][a-z0-9-]{1,38}[a-z0-9]\/$/;
const DIST_RE = /^[A-Z0-9]{8,20}$/;

/**
 * @param doc      the parsed live-bucket policy (from the template, filled)
 * @param bucket   the live bucket name
 * @param account  the AWS account id
 * @param mirrors  [{ distributionId, prefix }] -- prefix like "sites/acme/"
 * @returns a new document; `doc` is not modified
 */
export function withMirrors(doc, { bucket, account, mirrors = [] }) {
  const out = structuredClone(doc);
  const deny = out.Statement.find((s) => s.Sid === "DenyAnonymousAndCrossAccount");
  if (!deny) throw new Error("live bucket policy has no DenyAnonymousAndCrossAccount statement");

  for (const m of mirrors) {
    if (!DIST_RE.test(m.distributionId ?? "")) throw new Error(`mirror distribution id "${m.distributionId}" is not valid`);
    // The prefix is the isolation boundary, so it is checked rather than trusted:
    // an empty or "sites/" prefix would grant the whole bucket.
    if (!PREFIX_RE.test(m.prefix ?? "")) throw new Error(`mirror prefix "${m.prefix}" must be sites/<siteId>/`);
    const arn = `arn:aws:cloudfront::${account}:distribution/${m.distributionId}`;

    out.Statement.push({
      Sid: `MirrorRead${m.distributionId}`,
      Effect: "Allow",
      Principal: { Service: "cloudfront.amazonaws.com" },
      Action: "s3:GetObject",
      Resource: `arn:aws:s3:::${bucket}/${m.prefix}*`,
      Condition: { StringEquals: { "AWS:SourceArn": arn } },
    });

    const cond = deny.Condition.StringNotEquals;
    const arns = [].concat(cond["aws:SourceArn"]);
    if (!arns.includes(arn)) cond["aws:SourceArn"] = [...arns, arn];
  }
  return out;
}
