// The admin plane.
//
// A common way to run this shape is behind the Lambda Web Adapter layer. We do
// not: the
// routing here is small enough that a native Function URL handler is less
// machinery, one fewer cross-account layer to depend on, and a faster cold
// start. "Every dependency is a decision" applies to our own stack too.
//
// One router, two entry points: `handler` for Lambda, and a plain node:http
// server for local development. They share every line of logic below.
//
// Every /api route except /api/health requires a verified Google ID token whose
// email is on the admin list. There is no dev bypass, no "auth disabled when
// unconfigured" path, and no route that reads an identity out of a request body.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import sharp from "sharp";

import {
  verifyGoogleIdToken, verifyMicrosoftIdToken, idTokenProvider,
  AuthError, issueSession, verifySession, looksLikeSession,
} from "./lib/auth.mjs";
import { storeFor, s3, PLATFORM_BUCKET } from "./lib/store.mjs";
import * as registry from "./lib/registry.mjs";
import {
  hostToSiteId, checkSiteId, newSiteRecord, normalizeMembers,
  validateMemberChange, canAdminister, canEdit, roleInSite, SITE_ROLES,
  ACCESS_LEVELS, levelForRole,
} from "../shared/site.mjs";
import { desiredEdgeState, planEdgeSync } from "../shared/access-plan.mjs";
import { signGrant } from "../shared/access-token.mjs";
import { edgeConfigured, requireEdge, accessSecret, applyEdgeOps } from "./lib/access-edge.mjs";
import { processLogs, readReport, readDay, readDetailWindow } from "./lib/stats.mjs";
import * as oauthStore from "./lib/oauth-store.mjs";
import {
  looksLikePat, hashSecret, OAuthError, verifyPkce, isAllowedRedirectUri,
  matchRedirectUri, signState, verifyState, checkRegistration, newClientId,
  newPat, newAuthCode, authorizationServerMetadata, protectedResourceMetadata,
} from "../shared/oauth.mjs";
import {
  requirementFor, allows, clampToRole, refusedBy, grantableFor, normalizeScopes,
  describeScopes, UNSCOPED_ROUTES, DEFAULT_AGENT_RESOURCES, RESOURCES,
} from "../shared/scopes.mjs";
import {
  loadTemplate, readCatalog, assetKeysFor, TemplateNotFound, TemplateRejected,
  listSiteTemplates, putSiteTemplate, removeSiteTemplate, evictSiteTemplate,
} from "./lib/templates.mjs";
import {
  putStaticPage, listStaticPages, readStaticPage, removeStaticPage,
  stageStaticPages, StaticPageRejected,
} from "../shared/static-pages.mjs";
import { renderSite, contentType } from "../shared/render.mjs";
import { normalizeContent, validateContent } from "../shared/content.mjs";
import { tokenForm } from "../shared/template/tokens.mjs";
import {
  issuePreviewToken, verifyPreviewToken, previewFile, cachedFiles, cacheFiles,
  PREVIEW_HEADERS, PREVIEW_TTL_SEC, PreviewError,
} from "./lib/preview.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
// Empty means Microsoft sign-in is off; a Microsoft token is then refused with a
// clear message rather than falling through to the Google verifier.
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID ?? "";
const SESSION_SECRET = process.env.SESSION_SECRET ?? "";

// The hosted platform's apex. Used only to work out which site a request is for
// when nothing said explicitly -- `acme.quickieweb.com` means the site `acme`.
// Empty on a self-hosted install, where the site comes from the header instead.
const HOSTED_DOMAIN = process.env.HOSTED_DOMAIN ?? "";
// The OAuth issuer: the console's own origin. Every discovery document, every
// redirect and every token is scoped to this exact string, so it must match
// what a client typed, character for character.
// Everything the OAuth flow needs reachable without an /api prefix. Kept as a
// list so the CloudFront behaviors that route them (infra/wire-oauth.mjs) and
// the server agree on exactly one set of paths.
export const OAUTH_ROOT_PATHS = ["/.well-known", "/authorize", "/register", "/oauth", "/consent"];

const ISSUER = process.env.OAUTH_ISSUER
  || (HOSTED_DOMAIN ? `https://app.${HOSTED_DOMAIN}` : "");

// Where a new tenant's bytes go. One pair of buckets behind one distribution,
// with each site a prefix inside them; see shared/site.mjs for why.
const HOSTED = {
  domain: HOSTED_DOMAIN,
  region: process.env.AWS_BUCKET_REGION ?? "us-west-2",
  stagingBucket: process.env.TENANT_STAGING_BUCKET ?? "",
  liveBucket: process.env.TENANT_LIVE_BUCKET ?? "",
  distributionId: process.env.TENANT_DISTRIBUTION_ID ?? "",
  distributionDomain: process.env.TENANT_DISTRIBUTION_DOMAIN ?? "",
  logBucket: process.env.TENANT_LOG_BUCKET ?? "",
};

// ------------------------------------------------------------ origin lockdown
//
// The function URL is AuthType NONE and reachable by anyone who knows the
// hostname. That was always the trade-off (see infra/wire-cloudfront.mjs), and
// it was defensible because every /api route authenticates. But it meant any
// rate limit, WAF rule or edge check placed in front of CloudFront could be
// walked around by calling the .on.aws URL directly, and it left invocation
// itself -- cost and concurrency -- open to anyone.
//
// CloudFront now attaches a shared secret as an origin custom header. It
// overwrites any same-named header from the viewer before forwarding, so a
// caller coming through the CDN cannot spoof it, and a caller going direct does
// not have it.
//
// Two variables, not one, and the separation is the whole safety property:
// ORIGIN_SECRET makes the value known so /api/health can *report* whether the
// header arrived, and ORIGIN_ENFORCE makes it *required*. Deploy with the first
// only, confirm CloudFront is really sending it, then set the second. Flipping
// enforcement is a configuration change, so turning it back off is seconds
// rather than a redeploy.
const ORIGIN_SECRET = process.env.ORIGIN_SECRET ?? "";
const ORIGIN_ENFORCE = process.env.ORIGIN_ENFORCE === "1";
const ORIGIN_HEADER = "x-qw-origin";

/** "match" | "mismatch" | "missing" | "unconfigured" -- never throws. */
function originStatus(headers = {}) {
  if (!ORIGIN_SECRET) return "unconfigured";
  const got = headers[ORIGIN_HEADER] ?? headers[ORIGIN_HEADER.toUpperCase()] ?? "";
  if (!got) return "missing";
  const a = Buffer.from(String(got));
  const b = Buffer.from(ORIGIN_SECRET);
  // Length first: timingSafeEqual throws on a mismatch rather than returning
  // false, which would surface as a 500 instead of a clean 403.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "mismatch";
  return "match";
}
const MAX_BODY = 25 * 1024 * 1024;

const json = (status, obj) => ({
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  },
  body: JSON.stringify(obj),
});

const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70);

// ----------------------------------------------------- identity and access
//
// Two separate questions, deliberately not conflated:
//
//   WHO is calling?     one answer per request, from the bearer token.
//   WHAT may they do?   one answer per SITE, from that site's member list.
//
// The old model had a single admins.json per bucket and a role baked into the
// session. Neither survives multi-tenancy: a person can be an owner of one site
// and unknown to the next, so the role has to be resolved per request against
// the site being touched, not carried around in a token.

function bearer(headers) {
  const raw = headers["authorization"] ?? headers["Authorization"] ?? "";
  const m = raw.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new AuthError("Missing Authorization: Bearer <token>");
  return m[1].trim();
}

/**
 * Who is calling. Accepts either credential:
 *   qw.*  -- a session this server issued. HMAC verified, 12h life.
 *   else  -- a Google ID token, which is only used to obtain a session.
 *
 * Anyone with a valid Google account gets an identity. That is not access to
 * anything: it buys an empty site list until somebody adds them to a site.
 * Authenticating and being authorized are different events, and collapsing them
 * is what makes "add a collaborator" require a deploy.
 *
 * The platform role is re-read from the registry on every request rather than
 * trusted from the token, so revoking staff takes effect immediately instead of
 * at their next sign-in.
 */
async function requireActor(headers) {
  const token = bearer(headers);

  // A personal access token identifies a person the same way a session does --
  // the record names the email -- but carries scopes, which a session does not.
  // A person in the console is limited by their role; a token is limited by its
  // role AND its scopes, and the scopes can only ever narrow.
  if (looksLikePat(token)) {
    const record = await oauthStore.getPat(s3, hashSecret(token));
    if (!record) throw new AuthError("That token is not valid, or has been revoked", 401);
    const email = String(record.email ?? "").trim().toLowerCase();
    const user = await registry.getUser(s3, email);
    oauthStore.touchPat(s3, record);
    return {
      email,
      name: user?.name ?? null,
      displayName: user?.name ?? email,
      platformRole: user?.platformRole ?? "user",
      isStaff: registry.isStaff(user),
      // Present only for a token. `null` means a person is driving, so no scope
      // narrowing applies -- the distinction every scope check below turns on.
      scopes: record.scopes ?? [],
      tokenName: record.name ?? "",
    };
  }

  // A session, or an ID token from either provider. Which verifier runs is read
  // from the token's issuer, and each verifier re-checks that issuer against a
  // signature it validates, so the choice cannot be steered into trusting it.
  const identity = looksLikeSession(token)
    ? verifySession(token, SESSION_SECRET)
    : idTokenProvider(token) === "microsoft"
      ? await verifyMicrosoftIdToken(token, MICROSOFT_CLIENT_ID)
      : await verifyGoogleIdToken(token, GOOGLE_CLIENT_ID);

  const email = String(identity.email ?? "").trim().toLowerCase();
  if (!email) throw new AuthError("Token carries no email address", 403);

  const user = await registry.getUser(s3, email);
  return {
    email,
    name: identity.name ?? user?.name ?? null,
    displayName: identity.name ?? user?.name ?? email,
    platformRole: user?.platformRole ?? "user",
    isStaff: registry.isStaff(user),
    scopes: null,
  };
}

/**
 * What a token may reach, on top of what its holder's role allows.
 *
 * Called for every site-scoped route. A person in the console has
 * `scopes === null` and passes straight through -- this narrows a credential,
 * it never widens one, so the existing role checks stay exactly where they are.
 *
 * An unlisted route has no requirement, which is read as "no token reaches
 * this" rather than "any token does": a route added without a scope decision
 * fails closed.
 */
function requireScope(actor, head, method, siteId, second = null) {
  if (actor.scopes === null) return;
  if (UNSCOPED_ROUTES.has(head)) return;

  const need = requirementFor(head, method, second);
  if (!need) {
    throw new AuthError(
      `"${head}" cannot be reached with an access token. Use the console.`, 403);
  }
  if (!allows(actor.scopes, { site: siteId, resource: need.resource, action: need.action })) {
    throw new AuthError(
      `This token does not allow ${need.action} on ${need.resource}` +
      `${siteId ? ` for "${siteId}"` : ""}.`, 403);
  }
}

/**
 * Which site is this request for?
 *
 * Explicit beats derived: the admin UI is one deployment serving every site, so
 * it names the site it means. Deriving from Host is the fallback that makes a
 * self-hosted install and a per-site admin work without any of that.
 *
 * Returns null rather than a default. There is no default site -- falling back
 * to one would serve a tenant's content under another tenant's request.
 */
function requestedSiteId(query, headers) {
  const explicit = query.get("site") ?? headers["x-qw-site"] ?? headers["X-QW-Site"];
  if (explicit) return String(explicit).trim().toLowerCase();
  const host = headers.host ?? headers.Host ?? "";
  return HOSTED_DOMAIN ? hostToSiteId(host, HOSTED_DOMAIN) : null;
}

/** Bind the request to one tenant, or refuse. Everything downstream takes this. */
async function siteContext(actor, query, headers) {
  const siteId = requestedSiteId(query, headers);
  if (!siteId) {
    throw new AuthError(
      "No site selected. Pass ?site=<id> or an X-QW-Site header.", 400);
  }
  const { site, role, viaStaff } = await registry.authorizeSite(s3, {
    email: actor.email, siteId, staff: actor.isStaff,
  });
  requireConsoleRole(role, viaStaff || actor.isStaff, siteId);
  return { site, role, viaStaff, store: storeFor(site) };
}

/**
 * The console is for people who edit. A viewer is a member -- authorizeSite
 * finds them -- but may only READ the published site, which happens at the edge
 * and never here. Every route below siteContext assumed "member means editor"
 * before viewers existed, so this one check is what keeps that assumption true.
 */
function requireConsoleRole(role, staff, siteId) {
  if (staff || canEdit(role)) return;
  throw new AuthError(`You can read "${siteId}", but not edit it.`, 403);
}

// ------------------------------------------------------------------ content
//
// Site identity lives on the SITE RECORD in the platform bucket, not in the
// site's own staging bucket. One object, one writer, and a tenant's content
// bucket holds only content -- so a bug in the content path cannot rewrite the
// record that says who may read it.
const articleKey = (slug) => `_internal/articles/${slug}.json`;
const INDEX_KEY = "_internal/articles/index.json";

async function allArticles(store) {
  const index = await store.getJson(INDEX_KEY, []);
  const out = [];
  for (const slug of index) {
    const a = await store.getJson(articleKey(slug), null);
    if (a) out.push(a);
  }
  return out;
}

/**
 * Re-render one site into its staging bucket. Cheap enough to do on every save:
 * a site is a handful of small files, and the alternative is partial rebuilds
 * that drift out of sync with the index and the feeds.
 */
/**
 * How a site names its template to the loader. The siteId is not decoration: it
 * keys the loader's cache for a private template, and two sites may hold the
 * same id at the same version.
 */
const templateRefFor = (site, over = {}) => ({
  id: site.template.id,
  version: site.template.version,
  scope: site.template.scope,
  siteId: site.siteId,
  ...over,
});

async function rebuild(ctx) {
  const { site, store } = ctx;
  const template = await loadTemplate(s3, templateRefFor(site), store);
  const records = (await allArticles(store)).map((a) => normalizeContent(a));

  const { files, warnings } = renderSite({
    template, site: site.site, theme: site.theme, records, access: site.access.default,
  });
  for (const w of warnings) console.warn(`[${site.siteId}] theme: ${w}`);

  // The admin's category picker and its customization form both read this, so
  // the editor can only offer what the site and the active template declare.
  // Written on every rebuild rather than seeded once, so changing the template
  // changes the form with no separate step.
  files["taxonomy.json"] = JSON.stringify({
    categories: site.taxonomy.categories,
    template: { id: template.manifest.id, name: template.manifest.name, version: template.version },
    theme: tokenForm(template.manifest, site.theme),
  }, null, 2);

  for (const [name, body] of Object.entries(files)) {
    const type = name.endsWith(".xml") ? "application/xml; charset=utf-8"
      : name.endsWith(".json") ? "application/json; charset=utf-8"
      : name.endsWith(".css") ? "text/css; charset=utf-8"
      : "text/html; charset=utf-8";
    await store.putText(name, body, type);
  }

  // The template's own assets are copied server-side from the platform bucket
  // into this site's staging bucket, so the bytes never pass through here and a
  // site keeps working if the library later drops that version.
  // Hand-authored pages are not in renderSite's file set -- nothing templates
  // them -- so they are put back after it, from their source under _internal/.
  const staticPaths = await stageStaticPages(store);

  for (const { source, target, scope } of assetKeysFor(template)) {
    if (scope === "site") await store.copyWithinStaging(source, target);
    else await store.copyFromPlatform(source, target);
  }

  return [...Object.keys(files), ...staticPaths];
}

/**
 * Publish staging to live, keeping the edge store in step with it.
 *
 * The bytes and the access levels cannot change atomically together, so the
 * store goes to the stricter of old and new BEFORE the copy and to exactly the
 * new levels AFTER it (shared/access-plan.mjs explains why). The site record is
 * written after each step so it never claims less than the store holds.
 *
 * A site that has never been protected plans no edge changes at all, and so
 * publishes exactly as it always did -- with or without an edge store.
 */
async function publishWithAccess(ctx, onLog = () => {}) {
  const { site, store } = ctx;
  const records = (await allArticles(store)).map((a) => normalizeContent(a));
  const next = desiredEdgeState(site.access.default, records);
  const plan = planEdgeSync(site.siteId, site.access.edge, next);
  const touchesEdge = [plan.before, plan.after].some((o) => o.puts.length || o.deletes.length);
  if (touchesEdge) requireEdge();

  await applyEdgeOps(plan.before, onLog);
  if (touchesEdge) {
    site.access.edge = plan.max;
    await registry.putSite(s3, site);
  }

  const result = await store.publish(await store.computeChangeset(), onLog);

  await applyEdgeOps(plan.after, onLog);
  if (touchesEdge) {
    site.access.edge = next;
    await registry.putSite(s3, site);
  }
  return { ...result, access: { default: site.access.default, protectedPages: Object.keys(next.paths).length } };
}

/** Only a path on the same site, the same rule the edge applies after sign-in. */
const safeNext = (n) => {
  const s = String(n ?? "/");
  return s.startsWith("/") && !s.startsWith("//") && !s.includes("\\") ? s : "/";
};

/** Persist a change to the site record, then re-render against it. */
async function saveSite(ctx, mutate) {
  mutate(ctx.site);
  await registry.putSite(s3, ctx.site);
  await rebuild(ctx);
  return ctx.site;
}

/**
 * Serve one file of a preview rendering.
 *
 * The whole site is rendered in memory and the requested file picked out of it.
 * Nothing is written anywhere: a preview that stored files would need a lifetime,
 * a cleanup path, and a way to be sure yesterday's preview is not still sitting
 * in a bucket. Rendering costs a few milliseconds and owns none of that.
 */
async function servePreview(segments) {
  const [token, ...rest] = segments;
  const claims = verifyPreviewToken(token, SESSION_SECRET);

  const site = await registry.getSite(s3, claims.siteId);
  if (!site) throw new PreviewError("That site no longer exists", 404);

  // Re-check membership on every preview fetch rather than trusting the token's
  // own claim. A token issued before somebody was removed from a site must stop
  // working the moment they are, not fifteen minutes later.
  // A viewer may not preview: a preview is unpublished work, and a viewer reads
  // only what has been published.
  if (!canEdit(roleInSite(claims.email, site))) {
    const user = await registry.getUser(s3, claims.email);
    if (!registry.isStaff(user)) throw new PreviewError("You no longer have access to that site", 403);
  }

  const base = `/api/preview/${token}/`;
  let files = cachedFiles(token);
  if (!files) {
    const store = storeFor(site);
    const template = await loadTemplate(s3, claims.templateId
      ? { id: claims.templateId, version: "", scope: claims.templateScope, siteId: site.siteId }
      : templateRefFor(site), store);
    // Staging, not live: the point of a preview is to see work that has not been
    // published, under a template the site has not adopted.
    const records = (await allArticles(store)).map((a) => normalizeContent(a));
    // base = this preview's own prefix, which every relative link in the output
    // then resolves back through.
    files = renderSite({ template, site: site.site, theme: site.theme, records, access: site.access.default, base }).files;
    cacheFiles(token, files);
  }

  const name = previewFile(rest);
  const body = files[name];
  if (body === undefined) {
    // A miss inside a preview shows the site's OWN 404, which is usually what
    // you wanted to look at anyway.
    return {
      status: 404,
      headers: { ...PREVIEW_HEADERS, "content-type": "text/html; charset=utf-8" },
      body: files["404.html"] ?? "Not found",
    };
  }

  return {
    status: 200,
    headers: { ...PREVIEW_HEADERS, "content-type": contentType(name) },
    body,
  };
}

// -------------------------------------------------------------------- router
async function routeApi({ method, segments, query, headers, body }) {
  const [head, second] = segments;

  // Unauthenticated liveness probe. The sign-in page no longer calls this --
  // it reads the client id from the flat /admin/config.json in S3 -- so this
  // exists for deploys and diagnostics.
  //
  // `origin` reports whether CloudFront's shared header arrived, which is what
  // makes the lockdown verifiable before it is enforced. It reveals that an
  // origin check exists, not what the secret is; a check nobody can see is not
  // a check anybody can trust.
  if (head === "health") {
    return json(200, {
      ok: true,
      clientId: GOOGLE_CLIENT_ID || null,
      origin: originStatus(headers),
      enforcing: ORIGIN_ENFORCE,
      // Reports whether the library and registry are reachable, not what is in
      // them. A function with no PLATFORM_BUCKET cannot render or authorize
      // anything, and that is worth learning from a probe rather than from a
      // failed save.
      platform: PLATFORM_BUCKET ? "configured" : "unconfigured",
      hostedDomain: HOSTED_DOMAIN || null,
    });
  }

  // ---- preview: /api/preview/<token>/<path>
  //
  // Deliberately ahead of requireActor. Its credential is the signed token in
  // the path, because a browser fetching a stylesheet or an image inside the
  // preview sends no Authorization header -- and a preview that can only render
  // the HTML is an unstyled skeleton, which is not a preview of anything.
  if (head === "preview" && method === "GET" && second) {
    return await servePreview(segments.slice(1));
  }

  const asJson = () => {
    if (!body || !body.length) return {};
    try { return JSON.parse(body.toString("utf8")); }
    catch { throw new AuthError("Request body is not valid JSON", 400); }
  };

  // ---- OAuth 2.1 authorization server
  //
  // These are NOT site-scoped and must sit above siteContext: a client
  // discovering that it needs to authenticate has no site yet, and asking it
  // for one before it can log in is a chicken-and-egg it cannot solve.
  //
  // Errors here follow RFC 6749 shape ({error, error_description}) rather than
  // this API's {error}, because a generic OAuth client parses the former and
  // will show the latter as "unknown error".
  const oauthFail = (err) => json(err.status ?? 400, {
    error: err.code ?? "invalid_request",
    error_description: err.description ?? err.message,
  });

  // RFC 8414. Served at both the bare path and the MCP-style suffixed one,
  // because clients differ on which they probe first and a 404 on discovery
  // reads as "this server does not do OAuth".
  if (method === "GET" && head === ".well-known") {
    const doc = segments[1] ?? "";
    if (doc === "oauth-authorization-server" || doc.startsWith("oauth-authorization-server")) {
      return json(200, authorizationServerMetadata(ISSUER));
    }
    if (doc === "oauth-protected-resource" || doc.startsWith("oauth-protected-resource")) {
      return json(200, protectedResourceMetadata(`${ISSUER}/api`, ISSUER));
    }
    return json(404, { error: "not_found" });
  }

  // RFC 7591 dynamic client registration. Deliberately open: an MCP client
  // registers itself before any human is involved, so requiring a pre-shared
  // client id would mean a person editing a table before they can log in. What
  // registration grants is the right to ASK -- nothing is authorized until
  // somebody approves it on the consent screen.
  if (method === "POST" && head === "register") {
    try {
      const client = {
        ...checkRegistration(asJson()),
        client_id: newClientId(),
        client_id_issued_at: Math.floor(Date.now() / 1000),
      };
      await oauthStore.putClient(s3, client);
      return json(201, client);
    } catch (err) {
      if (err instanceof OAuthError) return oauthFail(err);
      throw err;
    }
  }

  // GET /authorize -- hand the request to the consent page as a signed blob.
  //
  // Nothing is stored here. The redirect URI, the PKCE challenge, the client
  // and a nonce are signed into a state token the consent page hands back, so
  // a Lambda that scales to zero never has to hold a pending authorization.
  if (method === "GET" && head === "authorize") {
    const p = Object.fromEntries(query.entries());
    try {
      const client = await oauthStore.getClient(s3, p.client_id);
      if (!client) throw new OAuthError("invalid_client", "Unknown client_id");

      // Redirect and client are validated BEFORE anything is echoed back to a
      // redirect_uri, because an unvalidated redirect is the one error that
      // must never be delivered by redirecting to it.
      if (!matchRedirectUri(client.redirect_uris, p.redirect_uri)) {
        throw new OAuthError("invalid_request",
          "redirect_uri does not match one registered by this client");
      }
      if (p.response_type !== "code") {
        throw new OAuthError("unsupported_response_type", "Only response_type=code is supported");
      }
      if (p.code_challenge_method !== "S256") {
        throw new OAuthError("invalid_request", "code_challenge_method must be S256");
      }
      if (!p.code_challenge) throw new OAuthError("invalid_request", "code_challenge is required");

      const state = signState({
        c: client.client_id,
        n: client.client_name ?? "",
        r: p.redirect_uri,
        h: p.code_challenge,
        s: p.state ?? "",
      }, SESSION_SECRET);

      // Straight to the console's consent page. It signs the person in with the
      // same Google flow the console uses, then POSTs back to /authorize/consent.
      return {
        status: 302,
        headers: {
          location: `/consent.html#${encodeURIComponent(state)}`,
          "cache-control": "no-store",
        },
        body: "",
      };
    } catch (err) {
      if (err instanceof OAuthError) return oauthFail(err);
      throw err;
    }
  }

  // What the consent page needs to render: who is asking, and which sites this
  // person could actually grant. Authenticated as the person, like any other
  // console call.
  if (method === "GET" && head === "authorize" && second === "context") {
    return json(404, { error: "not_found" });
  }
  if (head === "consent") {
    const actor = await requireActor(headers);
    if (actor.scopes !== null) {
      return json(403, { error: "A token cannot approve a new grant. Sign in." });
    }
    let claims;
    try {
      claims = verifyState(asJson().state ?? query.get("state"), SESSION_SECRET);
    } catch (err) {
      return oauthFail(err);
    }

    // Which sites this person may offer, and at what. Rendered from membership,
    // so a site they are only an editor on shows what it can and cannot grant
    // rather than quietly disappearing.
    const mine = await registry.sitesFor(s3, actor.email, { staff: actor.isStaff });
    // A site you only view has nothing to grant, so it is not offered at all.
    const offers = mine.filter((s) => s.role !== "viewer").map((s) => ({
      siteId: s.siteId,
      name: s.name || s.siteId,
      role: s.role,
      grantable: grantableFor(s.role, s.siteId),
      // Everything an agent normally wants, pre-ticked where the role allows
      // it. Publishing is deliberately not in this list.
      suggested: clampToRole(
        DEFAULT_AGENT_RESOURCES.map((r) => `qw:${s.siteId}:${r}:write`), s.role, s.siteId),
      refused: refusedBy(
        DEFAULT_AGENT_RESOURCES.map((r) => `qw:${s.siteId}:${r}:write`), s.role, s.siteId),
    }));

    if (method === "GET") {
      return json(200, {
        client: { id: claims.c, name: claims.n || "An application" },
        email: actor.email,
        sites: offers,
        resources: RESOURCES,
      });
    }

    if (method === "POST") {
      const body = asJson();
      // Clamp per site against the role, again, here. The consent page already
      // did it for display; doing it only there would make the UI the security
      // boundary, and a client that POSTs its own body would walk past it.
      const granted = [];
      for (const offer of offers) {
        const asked = normalizeScopes(body.scopes ?? []).filter((sc) => sc.startsWith(`qw:${offer.siteId}:`));
        granted.push(...clampToRole(asked, offer.role, offer.siteId));
      }
      if (!granted.length) {
        return json(400, { error: "Choose at least one site to grant access to." });
      }

      // The durable credential. The client never sees this secret: the code
      // binds to its hash, and the token endpoint hands back the secret exactly
      // once, to whoever proves they hold the PKCE verifier.
      const pat = newPat();
      const days = Math.min(Math.max(Number(body.days) || 30, 1), 365);
      await oauthStore.putPat(s3, {
        hash: pat.hash,
        email: actor.email,
        name: claims.n || "Connected app",
        scopes: granted,
        source: "oauth",
        clientId: claims.c,
        clientName: claims.n ?? "",
        expiresAt: new Date(Date.now() + days * 86400_000).toISOString(),
      });

      const code = newAuthCode();
      await oauthStore.putCode(s3, code.hash, {
        clientId: claims.c,
        redirectUri: claims.r,
        challenge: claims.h,
        patHash: pat.hash,
        patSecret: pat.secret,
        email: actor.email,
        scopes: granted,
      });

      const url = new URL(claims.r);
      url.searchParams.set("code", code.code);
      if (claims.s) url.searchParams.set("state", claims.s);
      return json(200, { redirect: url.toString(), scopes: granted });
    }
  }

  // POST /oauth/token -- authorization_code + PKCE, or refresh_token.
  //
  // Accepts form encoding as well as JSON: RFC 6749 says form, and a generic
  // OAuth client sends form. Accepting only JSON is the quiet mistake that
  // makes a spec-compliant client fail at the last step of the flow.
  if (method === "POST" && head === "oauth" && second === "token") {
    const ct = String(headers["content-type"] ?? headers["Content-Type"] ?? "");
    const form = ct.includes("application/x-www-form-urlencoded")
      ? Object.fromEntries(new URLSearchParams(String(body ?? "")))
      : asJson();

    try {
      if (form.grant_type === "refresh_token") {
        // The refresh token IS the PAT. Presenting it returns a fresh access
        // token, which is the same string -- there is one credential, and its
        // expiry is the PAT's. Kept so a standard client's refresh path works
        // rather than 400ing at the end of a working day.
        const record = await oauthStore.getPat(s3, hashSecret(form.refresh_token));
        if (!record) throw new OAuthError("invalid_grant", "That refresh token is not valid", 400);
        return json(200, {
          access_token: form.refresh_token,
          token_type: "Bearer",
          refresh_token: form.refresh_token,
          scope: "quickieweb",
          expires_in: Math.max(60, Math.floor(
            (Date.parse(record.expiresAt ?? "") - Date.now()) / 1000) || 3600),
        });
      }

      if (form.grant_type !== "authorization_code") {
        throw new OAuthError("unsupported_grant_type", "Unsupported grant_type");
      }

      // Read-and-delete. A code presented twice fails the second time even if
      // the first redemption is still in flight: replay is an attack, not a
      // retry.
      const record = await oauthStore.takeCode(s3, hashSecret(form.code ?? ""));
      if (!record) throw new OAuthError("invalid_grant", "That code is not valid or was already used");
      if (record.clientId !== form.client_id) {
        throw new OAuthError("invalid_grant", "That code was issued to a different client");
      }
      if (record.redirectUri !== form.redirect_uri) {
        throw new OAuthError("invalid_grant", "redirect_uri does not match the one authorized");
      }
      if (!verifyPkce(form.code_verifier, record.challenge)) {
        throw new OAuthError("invalid_grant", "code_verifier does not match the challenge");
      }

      const pat = await oauthStore.getPat(s3, record.patHash);
      if (!pat) throw new OAuthError("invalid_grant", "That grant has been revoked");

      return json(200, {
        access_token: record.patSecret,
        token_type: "Bearer",
        refresh_token: record.patSecret,
        scope: "quickieweb",
        expires_in: Math.max(60, Math.floor(
          (Date.parse(pat.expiresAt ?? "") - Date.now()) / 1000) || 3600),
      });
    } catch (err) {
      if (err instanceof OAuthError) return oauthFail(err);
      throw err;
    }
  }

  // ---- tokens: the console's own view of what it has issued
  if (head === "tokens") {
    const actor = await requireActor(headers);
    if (actor.scopes !== null) {
      return json(403, { error: "A token cannot manage tokens." });
    }

    if (method === "GET") {
      const tokens = await oauthStore.listPatsFor(s3, actor.email);
      return json(200, {
        tokens: tokens.map((t) => ({ ...t, summary: describeScopes(t.scopes) })),
      });
    }

    // Minting by hand, for a script or a headless job. The same record shape
    // consent produces, so there is one kind of credential to audit.
    if (method === "POST") {
      const b = asJson();
      const siteId = String(b.siteId ?? "").trim().toLowerCase();
      const { role } = await registry.authorizeSite(s3, {
        email: actor.email, siteId, staff: actor.isStaff,
      });
      const granted = clampToRole(b.scopes ?? [], role, siteId);
      if (!granted.length) {
        return json(400, {
          error: "Nothing to grant. Your role on that site may not allow what you asked for.",
          refused: refusedBy(b.scopes ?? [], role, siteId),
        });
      }

      const pat = newPat();
      const days = Math.min(Math.max(Number(b.days) || 90, 1), 365);
      await oauthStore.putPat(s3, {
        hash: pat.hash,
        email: actor.email,
        name: String(b.name ?? "").slice(0, 80) || "Access token",
        scopes: granted,
        source: "console",
        expiresAt: new Date(Date.now() + days * 86400_000).toISOString(),
      });
      // The one and only time this value exists outside the caller's hands.
      return json(201, { token: pat.secret, scopes: granted, expiresInDays: days });
    }

    if (method === "DELETE" && second) {
      const record = await oauthStore.findPatByShortId(s3, actor.email, second);
      if (!record) return json(404, { error: "No such token" });
      await oauthStore.revokePat(s3, record.hash);
      return json(200, { revoked: second });
    }
  }

  const actor = await requireActor(headers);

  // Exchange a verified Google ID token for a session. This is the only route
  // that needs a Google credential; everything else runs on the session, so a
  // one-hour ID token does not become a one-hour login.
  //
  // The session carries identity only. It deliberately does NOT carry a site
  // role: a person can own one site and be a stranger to the next, so the role
  // is resolved per request against the site being touched.
  if (head === "session" && method === "POST") {
    const { token, expiresAt } = issueSession(
      { email: actor.email, role: actor.platformRole, name: actor.displayName }, SESSION_SECRET);
    return json(200, {
      sessionToken: token, expiresAt,
      email: actor.email, name: actor.displayName,
      platformRole: actor.platformRole, staff: actor.isStaff,
    });
  }

  if (head === "me") {
    return json(200, {
      email: actor.email, name: actor.displayName,
      platformRole: actor.platformRole, staff: actor.isStaff,
    });
  }

  // ---- sites: the platform surface. No site context, by definition.
  if (head === "sites") {
    // The listing IS the visibility rule. A site nobody has added you to does
    // not appear here and cannot be addressed by guessing its id -- authorizeSite
    // answers "no such site" for both cases, so the API is not an oracle for
    // which tenant names exist.
    // A site you only VIEW is not in the console's list: there is nothing in the
    // console you could do with it, and opening it would only meet a 403.
    if (method === "GET" && !second) {
      const sites = (await registry.sitesFor(s3, actor.email, { staff: actor.isStaff }))
        .filter((s) => actor.isStaff || canEdit(s.role));
      return json(200, { sites, staff: actor.isStaff, hostedDomain: HOSTED_DOMAIN || null });
    }

    if (method === "GET" && second) {
      const { site, role, viaStaff } = await registry.authorizeSite(s3, {
        email: actor.email, siteId: second, staff: actor.isStaff,
      });
      // The record carries the member list; a viewer does not get to read it.
      requireConsoleRole(role, viaStaff || actor.isStaff, second);
      return json(200, { site, role, viaStaff });
    }

    // Provisioning. Staff only, and deliberately so: there is no public signup
    // yet, and "anyone with a Google account can claim a subdomain on our apex"
    // is not a thing to switch on by accident.
    if (method === "POST" && !second) {
      if (!actor.isStaff) return json(403, { error: "Only platform staff can create sites" });

      const b = asJson();
      const siteId = String(b.siteId ?? "").trim().toLowerCase();

      const problem = checkSiteId(siteId);
      if (problem) return json(400, { error: `siteId ${problem}` });

      const ownerEmail = String(b.ownerEmail ?? actor.email).trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) {
        return json(400, { error: "ownerEmail must be a real address" });
      }

      for (const [k, v] of Object.entries({
        HOSTED_DOMAIN: HOSTED.domain,
        TENANT_STAGING_BUCKET: HOSTED.stagingBucket,
        TENANT_LIVE_BUCKET: HOSTED.liveBucket,
      })) {
        if (!v) return json(503, { error: `${k} is not set on this function; hosted provisioning is unavailable` });
      }

      // Check the registry, not a list we keep. A name freed by deleting a
      // record would otherwise be reusable while the previous tenant's objects
      // are still sitting under that prefix.
      if (await registry.siteExists(s3, siteId)) {
        return json(409, { error: `A site named "${siteId}" already exists` });
      }

      const record = newSiteRecord({
        siteId,
        name: b.name || siteId,
        ownerEmail,
        ownerName: b.ownerName ?? "",
        hosted: HOSTED,
        template: b.template || "journal",
      });
      if (b.tagline) record.site.tagline = String(b.tagline).slice(0, 200);
      if (b.description) record.site.description = String(b.description).slice(0, 400);

      // The record first: it is the thing that makes the site exist. If any
      // later step fails, a site with no content is recoverable by rebuilding;
      // content with no record is orphaned bytes nobody can reach.
      await registry.putSite(s3, record);
      await registry.rememberMembership(s3, ownerEmail, siteId, { name: b.ownerName ?? "" });

      const ctx = { site: record, role: "owner", viaStaff: false, store: storeFor(record) };
      await ctx.store.putJson(INDEX_KEY, []);
      await rebuild(ctx);

      // Publish immediately. A provisioned site that 404s until somebody
      // remembers to press Publish looks broken, and the person it looks broken
      // to is the customer we just created it for.
      const changeset = await ctx.store.computeChangeset();
      const published = await ctx.store.publish(changeset);

      return json(201, {
        site: record,
        url: record.site.baseUrl,
        published,
        by: actor.email,
      });
    }
  }

  // ---- reader sign-in: POST /api/access/grant  { site, next }
  //
  // The sign-in page (admin/ui/access.html) calls this once the person is
  // signed in. It answers with a redirect to the SITE's /__qw/session carrying
  // a 60-second grant, which the edge turns into a host-only cookie. Above
  // siteContext on purpose: a viewer may read a site but not use the console,
  // and this is the one door they need.
  //
  // "No such site" and "not a member" get the same answer, so this is not an
  // oracle for which private sites exist or who is on them.
  if (head === "access" && second === "grant") {
    if (method !== "POST") return json(405, { error: "POST only" });
    if (actor.scopes !== null) {
      return json(403, { error: "An access token cannot sign in to read a site. Sign in as a person." });
    }
    const b = asJson();
    const siteId = String(b.site ?? "").trim().toLowerCase();
    const site = siteId ? await registry.getSite(s3, siteId) : null;
    const role = site ? (roleInSite(actor.email, site) ?? (actor.isStaff ? "staff" : null)) : null;
    const level = levelForRole(role);
    if (level === "public") {
      return json(403, {
        error: `${actor.email} does not have access to this site. Ask whoever runs it to add you, or sign in with a different account.`,
        email: actor.email,
      });
    }
    const grant = signGrant({ siteId, level, secret: await accessSecret() });
    return json(200, {
      redirect: `${site.site.baseUrl}/__qw/session?g=${encodeURIComponent(grant)}&next=${encodeURIComponent(safeNext(b.next))}`,
      level,
      email: actor.email,
    });
  }

  // ---- preview links. Issuing one is a normal authenticated, site-scoped act;
  // only the fetching of preview bytes uses the token instead.
  if (head === "preview" && method === "POST") {
    const b = asJson();
    const siteId = String(b.siteId ?? requestedSiteId(query, headers) ?? "").toLowerCase();
    if (!siteId) return json(400, { error: "siteId is required" });

    // Authorize the SITE here, once, so the token can be trusted later without
    // re-reading membership on every stylesheet fetch.
    const { site, role, viaStaff } = await registry.authorizeSite(s3, { email: actor.email, siteId, staff: actor.isStaff });
    requireConsoleRole(role, viaStaff || actor.isStaff, siteId);

    // Fail now if the template does not exist, rather than handing back a link
    // that 500s when it is opened.
    if (b.templateId) {
      try {
        await loadTemplate(s3,
          { id: b.templateId, version: "", scope: b.templateScope, siteId },
          storeFor(site));
      } catch (err) {
        if (err instanceof TemplateNotFound) return json(400, { error: err.message });
        throw err;
      }
    }

    const { token, expiresAt } = issuePreviewToken(
      { siteId, templateId: b.templateId ?? "", templateScope: b.templateScope,
        email: actor.email }, SESSION_SECRET);
    return json(201, {
      url: `/api/preview/${token}/`,
      expiresAt,
      ttlSeconds: PREVIEW_TTL_SEC,
      siteId,
      templateId: b.templateId ?? null,
    });
  }

  // ------------------------------------------------------------------------
  // Everything below is scoped to one tenant. `ctx` is the only way to reach a
  // bucket from here down; no route builds a key or names a bucket itself.
  const ctx = await siteContext(actor, query, headers);
  const { site, role, store } = ctx;
  const mayAdminister = canAdminister(role) || actor.isStaff;

  // Membership decided what this person may do; the token now decides how much
  // of that it may act on. Both, in that order, for every route below.
  requireScope(actor, head, method, site.siteId, second);

  // ---- content: posts, podcast episodes and static pages, one shape
  //
  // The route is still /api/articles because the admin UI and the storage keys
  // predate pages. The RECORDS are unified -- `type` decides the layout -- so
  // there is one list, one editor and one publish path rather than three.
  if (head === "articles") {
    if (method === "GET" && !second) {
      const list = (await allArticles(store))
        .map((a) => normalizeContent(a))
        .map((a) => ({
          slug: a.slug, type: a.type, status: a.status,
          title: a.title, dek: a.dek, date: a.date ?? "",
          category: a.category, categoryLabel: a.categoryLabel,
          nav: a.nav ?? null, updatedAt: a.updatedAt,
        }))
        // Pages have no date, so they sort after the dated stream rather than
        // ahead of everything on an empty string.
        .sort((x, y) => (y.date || "0").localeCompare(x.date || "0") || x.title.localeCompare(y.title));
      return json(200, list);
    }

    if (method === "GET" && second) {
      const a = await store.getJson(articleKey(second), null);
      return a ? json(200, normalizeContent(a)) : json(404, { error: "No such item" });
    }

    if (method === "POST") {
      const b = asJson();
      const record = normalizeContent({ ...b, createdBy: actor.email, updatedBy: actor.email });
      const problems = validateContent(record);
      if (problems.length) return json(400, { error: problems.join("; "), problems });
      if (await store.exists(articleKey(record.slug))) {
        return json(409, { error: `Something already lives at slug "${record.slug}"` });
      }

      await store.putJson(articleKey(record.slug), record);
      const index = await store.getJson(INDEX_KEY, []);
      if (!index.includes(record.slug)) await store.putJson(INDEX_KEY, [...index, record.slug]);
      await rebuild(ctx);
      return json(201, record);
    }

    if (method === "PUT" && second) {
      const existing = await store.getJson(articleKey(second), null);
      if (!existing) return json(404, { error: "No such item" });
      // slug is the identity; changing it here would orphan the rendered file.
      const record = normalizeContent({
        ...existing, ...asJson(), slug: existing.slug,
        updatedBy: actor.email, updatedAt: new Date().toISOString(),
      });
      const problems = validateContent(record);
      if (problems.length) return json(400, { error: problems.join("; "), problems });

      await store.putJson(articleKey(second), record);
      await rebuild(ctx);
      return json(200, record);
    }

    if (method === "DELETE" && second) {
      const index = await store.getJson(INDEX_KEY, []);
      await store.putJson(INDEX_KEY, index.filter((s) => s !== second));
      await store.remove(articleKey(second));
      await store.remove(`${second}.html`);
      await rebuild(ctx);
      return json(200, { deleted: second });
    }
  }

  // ---- templates: the library, read-only from here
  //
  // Switching a site's template is a record write plus a rebuild. The content is
  // untouched -- that is the point of templates being data rather than the
  // renderer -- and theme overrides the new template does not declare are simply
  // dropped by resolveTokens rather than carried as invisible state.
  if (head === "templates") {
    // GET /templates -> the shared library plus this site's own uploads. Both in
    // one payload because from the console's point of view they are one shelf
    // with a badge on some of the items.
    if (method === "GET" && !second) {
      const [catalog, mine] = await Promise.all([readCatalog(s3), listSiteTemplates(store)]);
      return json(200, {
        active: site.template,
        templates: (catalog.templates ?? []).map((t) => ({ ...t, scope: "library" })),
        siteTemplates: mine,
      });
    }

    // POST /templates -> upload a template into THIS SITE's own storage.
    //
    // The payload is a { path: text } map rather than an archive: templates are
    // text files, the browser can build one from a folder picker, and unpacking
    // a zip in the Lambda would mean either a dependency or hand-rolling an
    // archive parser over attacker-supplied bytes. This shape is also what an
    // MCP client or a script can POST without a toolchain.
    if (method === "POST" && !second) {
      if (!mayAdminister) return json(403, { error: "Only an owner can upload a template" });
      const b = asJson();
      const files = b.files;
      if (!files || typeof files !== "object" || Array.isArray(files)) {
        return json(400, { error: 'Send { "files": { "template.json": "…", "layouts/index.html": "…" } }' });
      }
      for (const [rel, text] of Object.entries(files)) {
        if (typeof text !== "string") return json(400, { error: `${rel} is not text` });
        // The package path space is flat and traversal-free, like every other
        // key this system builds. A template cannot write outside its own prefix.
        if (rel.includes("..") || rel.startsWith("/") || rel.includes("\\")) {
          return json(400, { error: `Unsafe path in package: ${rel}` });
        }
      }

      try {
        const result = await putSiteTemplate(store, files);
        return json(201, { ...result, scope: "site" });
      } catch (err) {
        if (err instanceof TemplateRejected) {
          return json(400, { error: err.message, findings: err.findings });
        }
        throw err;
      }
    }

    // POST /templates/validate -> a dry run. Writes nothing.
    //
    // The loop that makes an assistant able to write a template at all: draft,
    // check, read findings that name a file and a line, fix. Without it a model
    // is guessing against a contract it cannot see, and its first signal is a
    // rejected upload.
    if (method === "POST" && second === "validate") {
      const b = asJson();
      if (!b.files || typeof b.files !== "object" || Array.isArray(b.files)) {
        return json(400, { error: 'Send { "files": { "template.json": "…", … } }' });
      }
      const { ok, manifest, findings } = validateTemplate(b.files);
      return json(200, {
        ok,
        id: manifest?.id ?? null,
        errors: findings.filter((f) => f.level === "error").length,
        findings,
      });
    }

    // DELETE /templates/<id> -> drop one of this site's own templates.
    if (method === "DELETE" && second) {
      if (!mayAdminister) return json(403, { error: "Only an owner can delete a template" });
      // Refusing while it is in use is the difference between "you cannot delete
      // this" and every page of the site 503ing on the next save.
      if (site.template.scope === "site" && site.template.id === second) {
        return json(409, { error: `"${second}" is the template this site is using. Switch first.` });
      }
      try {
        const removed = await removeSiteTemplate(store, second, query.get("version"));
        // The loader caches by id@version inside a warm container, so a deleted
        // template would keep rendering until that container recycled.
        evictSiteTemplate(site.siteId, second);
        return json(200, { id: second, objectsRemoved: removed });
      } catch (err) {
        if (err instanceof TemplateNotFound) return json(404, { error: err.message });
        throw err;
      }
    }

    if (method === "PUT" && !second) {
      if (!mayAdminister) return json(403, { error: "Only an owner can change the template" });
      const b = asJson();
      if (!b.id) return json(400, { error: "id is required" });
      const scope = b.scope === "site" ? "site" : "library";

      // Load before saving: a template that does not exist or does not compile
      // must fail here, not on the next save when the site is already pointed at
      // it and every rebuild throws.
      let loaded;
      try {
        loaded = await loadTemplate(s3,
          templateRefFor(site, { id: b.id, version: b.version ?? "", scope }), store);
      } catch (err) {
        if (err instanceof TemplateNotFound) return json(400, { error: err.message });
        throw err;
      }

      await saveSite(ctx, (s) => { s.template = { id: b.id, version: b.version ?? "", scope }; });
      return json(200, { template: site.template, resolvedVersion: loaded.version });
    }
  }

  // ---- static pages: complete documents, published verbatim
  //
  // These bypass the content model on purpose. A `page` record is content with
  // the site's chrome around it; this is for markup the editor cannot express,
  // published exactly as given.
  if (head === "static") {
    const rest = segments.slice(1).join("/");

    if (method === "GET" && !rest) return json(200, { pages: await listStaticPages(store) });

    if (method === "GET" && rest) {
      const body = await readStaticPage(store, rest);
      if (body === null) return json(404, { error: `No static page at "${rest}"` });
      return json(200, { path: rest, body });
    }

    if (method === "PUT" || method === "POST") {
      if (!mayAdminister) return json(403, { error: "Only an owner can upload a static page" });
      const b = asJson();
      const target = rest || b.path;
      try {
        // Slugs are passed in so a static page cannot quietly shadow a post or
        // page that renders to the same filename.
        const records = await allArticles(store);
        const result = await putStaticPage(store, target, b.body, {
          slugs: records.map((r) => r.slug).filter(Boolean),
        });
        return json(201, result);
      } catch (err) {
        if (err instanceof StaticPageRejected) return json(400, { error: err.message });
        throw err;
      }
    }

    if (method === "DELETE" && rest) {
      if (!mayAdminister) return json(403, { error: "Only an owner can delete a static page" });
      try {
        return json(200, { path: await removeStaticPage(store, rest) });
      } catch (err) {
        if (err instanceof StaticPageRejected) return json(404, { error: err.message });
        throw err;
      }
    }
  }

  // ---- theme: the customization form and its values
  if (head === "theme") {
    const template = await loadTemplate(s3, templateRefFor(site), store);

    if (method === "GET") {
      return json(200, {
        template: { id: template.manifest.id, name: template.manifest.name, version: template.version },
        groups: tokenForm(template.manifest, site.theme),
        values: site.theme,
      });
    }
    if (method === "PUT") {
      const next = asJson();
      if (!next || typeof next !== "object" || Array.isArray(next)) {
        return json(400, { error: "Body must be an object of token key -> value" });
      }
      // Warnings rather than errors: an override the template does not declare
      // is dropped, and the editor is told which and why instead of the save
      // failing on a key that a template swap made obsolete.
      const { warnings } = renderSite({ template, site: site.site, theme: next, records: [] });
      await saveSite(ctx, (s) => { s.theme = next; });
      return json(200, { theme: next, warnings });
    }
  }

  // ---- site: the reader-visible identity (name, tagline, nav, categories)
  if (head === "site") {
    if (method === "GET") {
      return json(200, { siteId: site.siteId, site: site.site, taxonomy: site.taxonomy, role });
    }
    if (method === "PUT") {
      if (!mayAdminister) return json(403, { error: "Only an owner can change site settings" });
      const b = asJson();
      await saveSite(ctx, (s) => {
        // The domain and baseUrl are derived from the site id, not chosen. A
        // tenant editing its own hostname would simply stop resolving.
        const { domain, baseUrl, ...rest } = b.site ?? {};
        s.site = { ...s.site, ...rest };
        if (b.taxonomy?.categories) s.taxonomy = { categories: b.taxonomy.categories };
      });
      return json(200, { site: site.site, taxonomy: site.taxonomy });
    }
  }

  // ---- media: images are resized here, audio is stored as uploaded
  if (head === "media" && method === "POST") {
    const kind = query.get("kind") ?? "image";
    const filename = query.get("filename") ?? `upload-${Date.now()}`;
    if (!body?.length) return json(400, { error: "Empty upload" });
    const stem = slugify(filename.replace(/\.[a-z0-9]+$/i, "")) || "file";

    if (kind === "image") {
      const base = `media/${Date.now()}-${stem}`;
      const meta = await sharp(body).metadata();
      // Two renditions: a display-width webp and a thumbnail. The original is
      // deliberately not kept -- it is the largest object and nothing reads it.
      const full = await sharp(body).rotate().resize({ width: 1400, withoutEnlargement: true })
        .webp({ quality: 82 }).toBuffer();
      const thumb = await sharp(body).rotate().resize({ width: 480, withoutEnlargement: true })
        .webp({ quality: 74 }).toBuffer();
      await store.putBuffer(`${base}.webp`, full, "image/webp");
      await store.putBuffer(`${base}-thumb.webp`, thumb, "image/webp");
      return json(201, { url: `/${base}.webp`, thumbnail: `/${base}-thumb.webp`,
        width: meta.width, height: meta.height, bytes: full.length });
    }

    if (kind === "audio") {
      const ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] ?? "mp3").toLowerCase();
      const mime = { mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4",
        wav: "audio/wav", ogg: "audio/ogg", opus: "audio/opus" }[ext] ?? "audio/mpeg";
      const key = `media/audio/${Date.now()}-${stem}.${ext}`;
      await store.putBuffer(key, body, mime);
      // Duration is not derivable without decoding; the browser measures it and
      // sends it with the article, which keeps ffmpeg out of this bundle.
      return json(201, { url: `/${key}`, mimeType: mime, byteLength: body.length });
    }

    return json(400, { error: `Unknown media kind: ${kind}` });
  }

  // ---- members: who may edit THIS site
  //
  // Membership lives on the site record, which is also what every access
  // decision reads. There is no second list to drift from it.
  if (head === "members") {
    if (method === "GET") {
      return json(200, { members: site.members, roles: SITE_ROLES, you: actor.email, role });
    }
    if (method === "PUT") {
      if (!mayAdminister) return json(403, { error: "Only an owner can change the member list" });
      const next = normalizeMembers(asJson().members);
      const problems = validateMemberChange(next, actor.email);
      if (problems.length) return json(400, { error: problems.join("; "), problems });

      const before = new Set(site.members.map((m) => m.email));
      const after = new Set(next.map((m) => m.email));

      site.members = next;
      await registry.putSite(s3, site);

      // Keep each person's own site list in step. It is only an index -- access
      // is decided from the site record -- but a stale one shows sites in the
      // switcher that then refuse to open, which reads as a bug.
      for (const m of next) if (!before.has(m.email)) await registry.rememberMembership(s3, m.email, site.siteId, { name: m.name });
      for (const email of before) if (!after.has(email)) await registry.forgetMembership(s3, email, site.siteId);

      return json(200, { members: next });
    }
  }

  // ---- access: who may READ the published site (the big switch)
  //
  // GET  -> the site's default level, the levels, and whether the edge can
  //         enforce anything at all on this installation
  // PUT  { default } -> change it, then rebuild and publish
  //
  // Changing it publishes, deliberately. The listings (index, feeds, search) are
  // rendered at the default level, so a change is not complete until they are
  // re-rendered and live -- and the edge sync around that publish is what makes
  // the switch safe in both directions.
  if (head === "access") {
    if (method === "GET") {
      return json(200, {
        default: site.access.default,
        levels: ACCESS_LEVELS,
        enforced: edgeConfigured(),
        protectedPages: Object.keys(site.access.edge.paths).length,
      });
    }
    if (method === "PUT") {
      if (!mayAdminister) return json(403, { error: "Only an owner or admin can change who may read the site" });
      const level = asJson().default;
      if (!ACCESS_LEVELS.includes(level)) {
        return json(400, { error: `default must be one of: ${ACCESS_LEVELS.join(", ")}` });
      }
      if (level !== "public") requireEdge();
      site.access.default = level;
      await registry.putSite(s3, site);
      await rebuild(ctx);
      const logs = [];
      const result = await publishWithAccess(ctx, (m) => logs.push(m));
      return json(200, { ...result, default: level, logs, by: actor.email });
    }
  }

  // ---- stats: CloudFront access logs, processed on demand
  if (head === "stats") {
    if (!store.LOG_BUCKET) {
      return json(503, { error: "Access logging is not enabled. Run infra/enable-logging.mjs." });
    }
    if (method === "GET") {
      const days = Math.min(Number(query.get("days") ?? 30) || 30, 365);

      // /stats/detail   the drill-down tabs: geo, bots, acquisition, security.
      // Rolled across the same window as the summary unless ?date= names one
      // day. Kept off the default GET because it is a read per day in the
      // window, and the overview must stay one object.
      if (second === "detail") {
        const date = query.get("date");
        if (date) {
          const one = await readDay(store, date);
          return one ? json(200, one) : json(404, { error: `No processed logs for ${date}` });
        }
        const report = await readReport(store, days);
        const detail = await readDetailWindow(store, report.dates);
        return json(200, detail ?? { date: null, empty: true });
      }
      return json(200, await readReport(store, days));
    }
    // POST folds any newly delivered log objects into the stored daily report.
    if (method === "POST") {
      const result = await processLogs({
        s3, logBucket: store.LOG_BUCKET, store,
        ownHost: new URL(site.site.baseUrl).hostname,
        force: query.get("force") === "1",
      });
      return json(200, result);
    }
  }

  // ---- publish
  if (head === "publish") {
    if (method === "GET") return json(200, await store.computeChangeset());
    if (method === "POST") {
      await rebuild(ctx);
      const logs = [];
      const result = await publishWithAccess(ctx, (m) => logs.push(m));
      return json(200, { ...result, logs, by: actor.email, siteId: site.siteId });
    }
  }

  return json(404, { error: `No route for ${method} /api/${segments.join("/")}` });
}

// LOCAL DEVELOPMENT ONLY. In production the admin UI is static objects in S3
// and CloudFront never routes /admin* here; this exists so `QW_LOCAL=1` still
// serves the UI off disk without needing a second static server. It is not
// reachable through the deployed Lambda -- handleRequest does not call it.
async function routeUi(pathname) {
  const rel = pathname.replace(/^\/admin\/?/, "") || "index.html";
  if (rel.includes("..")) return { status: 400, headers: { "content-type": "text/plain" }, body: "bad path" };
  const type = rel.endsWith(".js") ? "text/javascript; charset=utf-8"
    : rel.endsWith(".css") ? "text/css; charset=utf-8"
    : rel.endsWith(".json") ? "application/json; charset=utf-8"
    : "text/html; charset=utf-8";
  try {
    const body = await readFile(path.join(HERE, "ui", rel), "utf8");
    return {
      status: 200,
      headers: {
        "content-type": type,
        "cache-control": "no-store",
        // Google Identity Services opens a popup and talks to it via
        // postMessage. The default COOP severs that channel, which surfaces as
        // "Cross-Origin-Opener-Policy policy would block the window.postMessage
        // call" in the console and can leave FedCM sign-in hanging.
        "cross-origin-opener-policy": "same-origin-allow-popups",
        "referrer-policy": "strict-origin-when-cross-origin",
        "x-content-type-options": "nosniff",
      },
      body,
    };
  } catch {
    return { status: 404, headers: { "content-type": "text/plain" }, body: "not found" };
  }
}

/** The one router. Both entry points funnel through here. */
export async function handleRequest({ method, pathname, query, headers, body }) {
  try {
    // Before routing, before auth, before anything: a request that did not
    // arrive through CloudFront gets nothing. Deliberately a flat 403 with no
    // detail -- someone probing the function URL directly learns only that it
    // refused, not why or what header it wanted.
    if (ORIGIN_ENFORCE && originStatus(headers) !== "match") {
      return json(403, { error: "Forbidden" });
    }

    // /admin/* is no longer served here. The UI is static objects in the live
    // bucket under the admin/ prefix, which SKIP_PREFIXES excludes from both
    // sides of computeChangeset -- so a bad publish still cannot reach the tool
    // that fixes a bad publish, which was the original reason it lived in this
    // bundle. See infra/deploy-admin-ui.mjs.
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      const segments = pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
      return await routeApi({ method, segments, query, headers, body });
    }

    // The OAuth surface answers at the ROOT as well as under /api.
    //
    // Not a convenience. RFC 8414 builds the metadata URL by inserting
    // /.well-known/ between the host and the issuer's path, and a generic MCP
    // client constructs the rest from the origin it was given. An issuer of
    // https://app.example/api therefore puts its own discovery document at
    // https://app.example/.well-known/oauth-authorization-server/api, which
    // nothing would think to ask for. The issuer has to be the bare origin, so
    // these paths have to exist there.
    if (OAUTH_ROOT_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
      const segments = pathname.replace(/^\//, "").split("/").filter(Boolean);
      return await routeApi({ method, segments, query, headers, body });
    }

    return { status: 404, headers: { "content-type": "text/plain" }, body: "not found" };
  } catch (err) {
    // Any error that carries its own status keeps it. Before this, a
    // PreviewError or a RegistryError -- both of which say something useful and
    // safe -- surfaced as a bare 500 with the detail swallowed into the logs.
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600
      ? err.status
      : 500;
    if (status >= 500) console.error(err);
    // 4xx messages are safe to return: they describe the caller's own request.
    // 5xx are not, so they get a generic string and the detail stays in logs.
    return json(status, { error: status >= 500 ? "Internal error" : err.message });
  }
}

// -------------------------------------------------------- Lambda Function URL
export async function handler(event) {
  const rc = event.requestContext ?? {};
  const method = rc.http?.method ?? "GET";
  const rawPath = rc.http?.path ?? event.rawPath ?? "/";
  const query = new URLSearchParams(event.rawQueryString ?? "");

  let body = null;
  if (event.body) {
    body = Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8");
    if (body.length > MAX_BODY) {
      return { statusCode: 413, headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Request body too large" }) };
    }
  }

  const res = await handleRequest({
    method, pathname: rawPath, query,
    headers: event.headers ?? {}, body,
  });

  return { statusCode: res.status, headers: res.headers, body: res.body };
}

// ------------------------------------------------------------- local dev only
if (process.env.QW_LOCAL === "1") {
  const http = await import("node:http");
  const PORT = Number(process.env.PORT ?? 8080);
  http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    // Local dev serves the admin UI from disk. CloudFront serves it from S3;
    // the deployed Lambda serves it not at all.
    const out = (url.pathname === "/admin" || url.pathname.startsWith("/admin/"))
      ? await routeUi(url.pathname)
      : await handleRequest({
        method: req.method, pathname: url.pathname, query: url.searchParams,
        headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : null,
      });
    res.writeHead(out.status, out.headers);
    res.end(out.body);
  }).listen(PORT, () => console.log(`admin (local) listening on ${PORT}`));
}
