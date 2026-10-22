// The Lambda's part in comments: signing a commenter in, issuing upload
// tickets, and the console's moderation queue.
//
// None of this runs on a page view or a comment write. A reader's browser lists
// and reads comments through the edge, and uploads them straight to S3; this
// module only decides who gets a ticket (once an hour, per commenter) and lets a
// site admin approve what is waiting.
//
//   POST   /api/comments/grant      console host, signed in   -> redirect to the site
//   GET    /api/comments/session    site host, ?g=<grant>     -> qw_commenter cookie
//   DELETE /api/comments/session    site host                 -> cookie cleared
//   GET    /api/comments/ticket     site host, cookie         -> S3 POST policy
//
//   GET    /api/comments            console, site admin       -> settings + pending
//   PUT    /api/comments/settings   { who, approval }
//   POST   /api/comments/approve    { key }   _pending/... -> _comments/...
//   POST   /api/comments/reject     { key }   deleted
//
// Pure apart from the `ops` it is handed: list/read/copy/remove on the site's
// LIVE bucket, by site-relative key. server.mjs binds them to the store, and
// test/comments-api.test.mjs to a Map.

import { COMMENT_LIMITS, parseEntryName, validThread, checkObject, buildEntryName } from "../../shared/comments.mjs";
import {
  commentDecision, commenterUid, signCommentGrant, signCommentSession, verifyCommenterToken,
  signCommentTicket, COMMENTER_COOKIE, COMMENT_GRANT_SEC, COMMENT_SESSION_SEC,
} from "../../shared/comment-ticket.mjs";
import { COMMENT_WHO } from "../../shared/site.mjs";

export const PENDING_PREFIX = "_pending/";
export const COMMENTS_PREFIX = "_comments/";

export class CommentError extends Error {
  constructor(message, status = 400) { super(message); this.name = "CommentError"; this.status = status; }
}

const COOKIE_ATTRS = "Secure; HttpOnly; SameSite=Lax; Path=/api/comments";

/** One cookie's value from a Cookie header, or null. */
export function readCookie(headers, name) {
  const raw = headers.cookie ?? headers.Cookie ?? "";
  for (const part of String(raw).split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Who the qw_commenter cookie says this is, on this site; null if nobody. */
export function commenterFrom(headers, siteId, secret, now = Date.now()) {
  const token = readCookie(headers, COMMENTER_COOKIE);
  return token ? verifyCommenterToken(token, { kind: "cs1", siteId, maxSec: COMMENT_SESSION_SEC, secret, now }) : null;
}

/**
 * After sign-in on the console host: where to send the person so their
 * commenter session is set on the SITE's host, where the library will ask for
 * tickets. Refused here, rather than at ticket time, if they may not comment at
 * all -- so the sign-in page can say why instead of bouncing them back.
 */
export function grantRedirect({ site, actor, next, secret, gateOrigin, now = Date.now() }) {
  const d = commentDecision(site, actor.email);
  if (!d.allowed) throw new CommentError(d.reason, d.status);
  const g = signCommentGrant({ siteId: site.siteId, email: actor.email, name: actor.name ?? "", secret, now });
  return `${gateOrigin}/api/comments/session?site=${encodeURIComponent(site.siteId)}` +
    `&g=${encodeURIComponent(g)}&next=${encodeURIComponent(next)}`;
}

/** The Set-Cookie value for a grant, or a 403 if the grant is no good. */
export function sessionCookie({ siteId, grant, secret, now = Date.now() }) {
  const who = verifyCommenterToken(grant, { kind: "cg1", siteId, maxSec: COMMENT_GRANT_SEC, secret, now });
  if (!who) throw new CommentError("That sign-in link has expired or is not for this site. Sign in again.", 403);
  const token = signCommentSession({ siteId, email: who.email, name: who.name, secret, now });
  return `${COMMENTER_COOKIE}=${token}; ${COOKIE_ATTRS}; Max-Age=${COMMENT_SESSION_SEC}`;
}

export const CLEAR_SESSION_COOKIE = `${COMMENTER_COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`;

/**
 * An upload ticket for whoever the cookie names. The site's CURRENT settings
 * decide, every time: a session proves who someone is, not that they may still
 * comment.
 */
export function ticketFor({ site, commenter, secret, credentials, now = Date.now() }) {
  const d = commentDecision(site, commenter?.email ?? null);
  if (!d.allowed) throw new CommentError(d.reason, d.status);
  const st = site.storage;
  if (st.driver !== "prefix") throw new CommentError("Comments are only available on hosted sites.", 409);
  return signCommentTicket({
    bucket: st.liveBucket,
    region: st.region,
    sitePrefix: st.prefix.replace(/\/+$/, ""),
    pending: d.pending,
    uid: commenterUid(commenter.email, secret),
    name: commenter.name,
    credentials,
    now,
  });
}

/** { who, approval } from a request body, refusing anything else. */
export function settingsFrom(body) {
  const { who, approval, ...rest } = body ?? {};
  const extra = Object.keys(rest);
  if (extra.length) throw new CommentError(`Unknown comment setting: ${extra.join(", ")}`);
  if (!COMMENT_WHO.includes(who)) throw new CommentError(`who must be one of: ${COMMENT_WHO.join(", ")}`);
  if (typeof approval !== "boolean") throw new CommentError("approval must be true or false");
  return { who, approval };
}

// ------------------------------------------------------------- moderation

/** { thread, name, parsed } for <root><thread>/<name>, else null. */
function locate(key, root) {
  if (typeof key !== "string" || !key.startsWith(root)) return null;
  const rest = key.slice(root.length);
  const i = rest.lastIndexOf("/");
  const thread = rest.slice(0, i);
  const name = rest.slice(i + 1);
  const parsed = i > 0 ? parseEntryName(name) : null;
  return parsed && validThread(thread) ? { thread, name, parsed } : null;
}

/**
 * The same checks every reader makes, applied before an admin sees it -- so a
 * junk upload shows up as junk to reject, not as a comment to approve.
 */
async function inspect(ops, key, modified) {
  const where = locate(key, PENDING_PREFIX);
  if (!where) return { key, modified, problem: "not a comment key" };
  const got = await ops.read(key);
  if (got === null) return null;
  const base = { key, thread: where.thread, name: where.name, modified };
  if (Math.abs(where.parsed.at - modified) > COMMENT_LIMITS.skewSec * 1000) {
    return { ...base, problem: "its time does not match when it was stored" };
  }
  const entry = { key, name: where.name, uid: where.parsed.uid, modified };
  const header = (h) => (h === "x-amz-meta-uid" ? got.meta.uid ?? null : h === "x-amz-meta-name" ? got.meta.name ?? null : null);
  const checked = checkObject(entry, got.text, header, where.thread);
  return checked.item
    ? { ...base, author: checked.item.author, comment: checked.item.comment }
    : { ...base, problem: checked.reason };
}

/** Everything waiting for approval, oldest first. */
export async function listPending(ops) {
  const listed = await ops.list(PENDING_PREFIX);
  const out = [];
  for (const o of listed) {
    const modified = new Date(o.modified).getTime();
    const item = await inspect(ops, o.key, modified);
    // Gone between the listing and the read: another admin got to it first.
    if (item !== null) out.push(item);
  }
  return out.sort((a, b) => a.modified - b.modified || (a.key < b.key ? -1 : 1));
}

/**
 * Publish a pending comment. It is renamed with the approval time, because a
 * reader accepts a key's time only within skewSec of when S3 stored it, and the
 * copy is stored now. Its author metadata travels with it unchanged.
 */
export async function approve(ops, key, now = Date.now()) {
  const where = locate(key, PENDING_PREFIX);
  if (!where) throw new CommentError("Not a pending comment.", 400);
  const got = await ops.read(key);
  if (got === null) throw new CommentError("That comment is no longer waiting -- it was approved or rejected already.", 404);
  const item = await inspect(ops, key, new Date(got.modified).getTime());
  if (item.problem) throw new CommentError(`This upload cannot be approved: ${item.problem}. Reject it instead.`, 409);
  const target = `${COMMENTS_PREFIX}${where.thread}/${buildEntryName(now, where.parsed.uid, where.parsed.slug)}`;
  await ops.copy(key, target);
  await ops.remove(key);
  return { key: target, thread: where.thread };
}

export async function reject(ops, key) {
  if (typeof key !== "string" || !key.startsWith(PENDING_PREFIX) || key.includes("..")) {
    throw new CommentError("Not a pending comment.", 400);
  }
  await ops.remove(key);
  return { key };
}
