// Authenticated preview: see a site rendered with a template it has not adopted.
//
// HOW IT HANGS TOGETHER
//
// The console asks for a token, then opens /api/preview/<token>/. Every page the
// preview serves is rendered with `base` set to that same prefix, so each
// stylesheet, link and image inside it is written relative -- and a browser
// resolves them straight back through the token. That is the whole trick, and it
// is why shared/template/viewmodel.mjs hands templates finished URLs instead of
// letting them write "/assets/style.css".
//
// WHY A TOKEN IN THE PATH AND NOT A BEARER HEADER
//
// The console authenticates with an Authorization header. A browser loading an
// <iframe>, a stylesheet or an image sends no such header, so a header-only
// scheme can preview the HTML and nothing else -- an unstyled skeleton. The
// token has to travel in the URL, and it has to be a prefix rather than a query
// parameter so relative references inherit it.
//
// WHAT THAT COSTS
//
// A URL is not a secret: it lands in browser history, in a Referer on any
// outbound link, and in access logs. So the token is deliberately weak tea --
// fifteen minutes, one site, read-only, and it grants nothing but a rendering of
// content the holder could already see. It is not a session and cannot become
// one: nothing about it is accepted by any other route.

import { createHmac, timingSafeEqual } from "node:crypto";

export const PREVIEW_TTL_SEC = 15 * 60;

const b64u = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

export class PreviewError extends Error {
  constructor(message, status = 403) { super(message); this.name = "PreviewError"; this.status = status; }
}

/**
 * @param claims { siteId, templateId, templateScope, email }
 * @returns { token, expiresAt }
 */
export function issuePreviewToken({ siteId, templateId, templateScope, email }, secret) {
  if (!secret) throw new PreviewError("Server misconfigured: no SESSION_SECRET", 500);
  const payload = {
    s: siteId,
    t: templateId || "",
    // Which shelf that id is on. A private template and a library one can
    // share a name, so the scope has to be signed alongside it rather than
    // guessed at serve time.
    c: templateScope === "site" ? "site" : "",
    e: email,
    x: Math.floor(Date.now() / 1000) + PREVIEW_TTL_SEC,
  };
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(createHmac("sha256", secret).update(`preview.${body}`).digest());
  return { token: `${body}.${sig}`, expiresAt: payload.x * 1000 };
}

export function verifyPreviewToken(token, secret) {
  if (!secret) throw new PreviewError("Server misconfigured: no SESSION_SECRET", 500);
  const raw = String(token ?? "");
  const dot = raw.lastIndexOf(".");
  if (dot === -1) throw new PreviewError("Malformed preview token", 400);

  const body = raw.slice(0, dot);
  const given = unb64u(raw.slice(dot + 1));
  // Namespaced with a "preview." prefix so a preview token can never be confused
  // with a session token, even though both are HMACs under the same secret.
  const expected = createHmac("sha256", secret).update(`preview.${body}`).digest();
  // Length first: timingSafeEqual throws on a mismatch rather than returning
  // false, which would surface as a 500 instead of a clean 403.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new PreviewError("Preview link is not valid");
  }

  let payload;
  try {
    payload = JSON.parse(unb64u(body).toString("utf8"));
  } catch {
    throw new PreviewError("Unreadable preview token", 400);
  }
  if (!payload.x || payload.x * 1000 < Date.now()) {
    throw new PreviewError("This preview link has expired. Open a new one.", 410);
  }
  return {
    siteId: payload.s, templateId: payload.t,
    templateScope: payload.c === "site" ? "site" : "library",
    email: payload.e, expiresAt: payload.x * 1000,
  };
}

/**
 * Which file inside the preview is being asked for.
 * Never trusts the path: a preview serves only names the renderer produced, so a
 * traversal attempt cannot reach anything because nothing outside that map
 * exists to reach.
 */
export function previewFile(segments) {
  const rel = segments.join("/");
  if (!rel || rel.endsWith("/")) return `${rel}index.html`;
  return rel;
}

// Rendering a whole site per request is fine -- a site is a handful of small
// files and a preview is a rare, human-paced action -- but a browser loading one
// page fetches the stylesheet and the favicon right behind it, and re-rendering
// for each would be silly. Keyed by token, so it expires with the token.
const cache = new Map();
const MAX_CACHED = 4;

export const cachedFiles = (token) => cache.get(token) ?? null;

export function cacheFiles(token, files) {
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
  cache.set(token, files);
  return files;
}

/** A preview must never be indexed, cached by a shared cache, or framed elsewhere. */
export const PREVIEW_HEADERS = {
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "x-content-type-options": "nosniff",
  // The console frames the preview, so same-origin rather than DENY.
  "x-frame-options": "SAMEORIGIN",
  "content-security-policy": "frame-ancestors 'self'",
};

// ---------------------------------------------------------------- media view
//
// The editor shows a post's images, and for a protected site the site's own
// host answers an <img> with a redirect to sign-in -- the console holds no
// cookie there. So the console serves them itself, from STAGING (which also
// holds uploads not yet published), under a token in the path for the same
// reason a preview uses one: an <img> request carries no Authorization header.
//
// Narrower than a preview token: one site, images only, nothing rendered, and a
// separate namespace so neither kind of token is accepted in place of the other.
// Longer-lived, because it is fetched when an editing session opens and every
// image in that session is loaded through it.

export const MEDIA_VIEW_TTL_SEC = 4 * 60 * 60;

export function issueMediaViewToken({ siteId, email }, secret) {
  if (!secret) throw new PreviewError("Server misconfigured: no SESSION_SECRET", 500);
  const x = Math.floor(Date.now() / 1000) + MEDIA_VIEW_TTL_SEC;
  const body = b64u(JSON.stringify({ s: siteId, e: email, x }));
  const sig = b64u(createHmac("sha256", secret).update(`media.${body}`).digest());
  return { token: `${body}.${sig}`, expiresAt: x * 1000 };
}

export function verifyMediaViewToken(token, secret) {
  if (!secret) throw new PreviewError("Server misconfigured: no SESSION_SECRET", 500);
  const raw = String(token ?? "");
  const dot = raw.lastIndexOf(".");
  if (dot === -1) throw new PreviewError("Malformed media token", 400);
  const body = raw.slice(0, dot);
  const given = unb64u(raw.slice(dot + 1));
  const expected = createHmac("sha256", secret).update(`media.${body}`).digest();
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new PreviewError("Media link is not valid");
  }
  let payload;
  try {
    payload = JSON.parse(unb64u(body).toString("utf8"));
  } catch {
    throw new PreviewError("Unreadable media token", 400);
  }
  if (!payload.x || payload.x * 1000 < Date.now()) throw new PreviewError("This media link has expired", 410);
  return { siteId: payload.s, email: payload.e, expiresAt: payload.x * 1000 };
}

const IMAGE_TYPES = {
  webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  gif: "image/gif", avif: "image/avif", svg: "image/svg+xml",
};
const VIEWABLE = /\.(webp|jpe?g|png|gif|avif|svg)$/i;

/** The content type of a name mediaViewKey accepted. */
export const imageType = (name) => IMAGE_TYPES[name.slice(name.lastIndexOf(".") + 1).toLowerCase()];

/** The staged key an image request names, or a 404 for anything that is not an image. */
export function mediaViewKey(segments) {
  const parts = segments.map((s) => decodeURIComponent(s));
  const rel = parts.join("/");
  if (!parts.length || parts.some((p) => !p || p === "." || p === ".." || p.includes("\\"))
    || rel.startsWith("_internal/") || !VIEWABLE.test(rel)) {
    throw new PreviewError("Not an image", 404);
  }
  return rel;
}
