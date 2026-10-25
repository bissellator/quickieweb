// The Lambda's part in comments: signing a commenter in, issuing upload
// tickets, and the console's moderation queue.
//
// None of this runs on a page view or a comment write. A reader's browser lists
// and reads comments through the edge, and writes them through it too; this
// module only decides who gets a ticket (once an hour, per commenter) and lets a
// site admin approve what is waiting.
//
//   POST   /api/comments/grant      console host, signed in   -> redirect to the site
//   GET    /api/comments/session    site host, ?g=<grant>     -> qw_commenter cookie
//   DELETE /api/comments/session    site host                 -> cookie cleared
//   GET    /api/comments/ticket     site host, cookie         -> a write ticket for the edge
//
//   GET    /api/comments            console, site admin       -> settings + pending
//   GET    /api/comments/published  console, site admin       -> every published comment
//   PUT    /api/comments/settings   { who, approval }
//   POST   /api/comments/approve    { key }   _pending/... -> _comments/...
//   POST   /api/comments/reject     { key }   deleted
//   POST   /api/comments/remove     { thread, name }  a published comment, deleted
//
// Pure apart from the `ops` it is handed: list/read/copy/remove on the site's
// LIVE bucket, by site-relative key. server.mjs binds them to the store, and
// test/comments-api.test.mjs to a Map.

import { COMMENT_LIMITS, parseEntryName, validThread, checkObject, buildEntryName, foldThread } from "../../shared/comments.mjs";
import {
  commentDecision, commenterUid, signCommentGrant, signCommentSession, verifyCommenterToken,
  signCommentTicket, COMMENTER_COOKIE, COMMENT_GRANT_SEC, COMMENT_SESSION_SEC,
} from "../../shared/comment-ticket.mjs";
import { COMMENT_WHO, roleInSite } from "../../shared/site.mjs";

export const PENDING_PREFIX = "_pending/";
export const COMMENTS_PREFIX = "_comments/";

export class CommentError extends Error {
  constructor(message, status = 400) { super(message); this.name = "CommentError"; this.status = status; }
}

const COOKIE_ATTRS = "Secure; HttpOnly; SameSite=Lax; Path=/api/comments";

// The page-readable companion: the display name only, so a static page can show
// a form or a "Sign in" button without asking the Lambda on every view. It
// grants nothing -- tickets come from the HttpOnly cookie above -- so a forged
// one only shows a form whose Post is refused. Read by hintName() in
// shared/comments.mjs.
export const COMMENTER_HINT_COOKIE = "qw_cmt";
const HINT_ATTRS = "Secure; SameSite=Lax; Path=/";

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

/**
 * The Set-Cookie values for a grant -- the session, then its hint -- or a 403
 * if the grant is no good. Both share a lifetime, so the hint never outlives
 * the session by more than a sign-out on another tab.
 */
export function sessionCookies({ siteId, grant, secret, site = null, now = Date.now() }) {
  const who = verifyCommenterToken(grant, { kind: "cg1", siteId, maxSec: COMMENT_GRANT_SEC, secret, now });
  if (!who) throw new CommentError("That sign-in link has expired or is not for this site. Sign in again.", 403);
  const token = signCommentSession({ siteId, email: who.email, name: who.name, secret, now });
  // "<role>:<name>". The role is a hint for which buttons to draw and nothing
  // more: readers trust the role S3 stored with each event, and deleting asks
  // the Lambda, which looks the role up again.
  return [
    `${COMMENTER_COOKIE}=${token}; ${COOKIE_ATTRS}; Max-Age=${COMMENT_SESSION_SEC}`,
    hintCookie(who, site),
  ];
}

/**
 * The hint for a commenter, with their role on the site as it stands now. Set
 * at sign-in, and again with every ticket, so a role granted or taken away
 * after sign-in reaches the page's buttons at the next post or resolve.
 */
export function hintCookie(who, site) {
  const role = (site && roleInSite(who.email, site)) || "none";
  const shown = `${role}:${encodeURIComponent(String(who.name || "Reader").slice(0, 80))}`;
  return `${COMMENTER_HINT_COOKIE}=${shown}; ${HINT_ATTRS}; Max-Age=${COMMENT_SESSION_SEC}`;
}

export const CLEAR_SESSION_COOKIES = [
  `${COMMENTER_COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`,
  `${COMMENTER_HINT_COOKIE}=; ${HINT_ATTRS}; Max-Age=0`,
];

/**
 * An upload ticket for whoever the cookie names. The site's CURRENT settings
 * decide, every time: a session proves who someone is, not that they may still
 * comment.
 */
export function ticketFor({ site, commenter, secret, now = Date.now() }) {
  const d = commentDecision(site, commenter?.email ?? null);
  if (!d.allowed) throw new CommentError(d.reason, d.status);
  // The edge writes to sites/<id>/ in the shared live bucket; a site on its own
  // buckets has no edge writer in front of it.
  if (site.storage.driver !== "prefix") throw new CommentError("Comments are only available on hosted sites.", 409);
  return signCommentTicket({
    siteId: site.siteId,
    pending: d.pending,
    uid: commenterUid(commenter.email, secret),
    name: commenter.name,
    role: d.role,
    secret,
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
async function inspect(ops, key, modified, root = PENDING_PREFIX) {
  const where = locate(key, root);
  if (!where) return { key, modified, problem: "not a comment key" };
  const got = await ops.read(key);
  if (got === null) return null;
  const base = { key, thread: where.thread, name: where.name, modified };
  if (Math.abs(where.parsed.at - modified) > COMMENT_LIMITS.skewSec * 1000) {
    return { ...base, problem: "its time does not match when it was stored" };
  }
  const entry = { key, name: where.name, uid: where.parsed.uid, modified };
  const header = (h) => (h.startsWith("x-amz-meta-") ? got.meta[h.slice(11)] ?? null : null);
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

// How many published entries one listing reads. Every entry is a GET, so a
// site with years of comments would otherwise outlast the Lambda.
export const PUBLISHED_READ_LIMIT = 500;

/**
 * Every published comment on the site, newest first, as readers would see it:
 * each entry passes the readers' checks, then each thread is folded the way the
 * library folds it, so a retracted comment is gone and a resolved one says so.
 * What fails is returned as `problems` rather than dropped -- an upload that
 * readers silently refuse is exactly what an admin needs to see.
 *
 * Whole threads, most recently active first, until PUBLISHED_READ_LIMIT entries:
 * folding half a thread would report its events as pointing at nothing.
 */
export async function listPublished(ops, { limit = PUBLISHED_READ_LIMIT } = {}) {
  const listed = await ops.list(COMMENTS_PREFIX);
  const threads = new Map();
  const problems = [];
  for (const o of listed) {
    const modified = new Date(o.modified).getTime();
    const where = locate(o.key, COMMENTS_PREFIX);
    if (!where) { problems.push({ key: o.key, modified, problem: "not a comment key" }); continue; }
    const t = threads.get(where.thread) ?? { thread: where.thread, latest: 0, objects: [] };
    t.latest = Math.max(t.latest, modified);
    t.objects.push({ key: o.key, modified });
    threads.set(where.thread, t);
  }

  const chosen = [];
  let count = 0;
  for (const t of [...threads.values()].sort((a, b) => b.latest - a.latest)) {
    if (count > 0 && count + t.objects.length > limit) break;
    chosen.push(t);
    count += t.objects.length;
  }

  const comments = [];
  for (const t of chosen) {
    const items = [];
    for (const o of t.objects) {
      const got = await inspect(ops, o.key, o.modified, COMMENTS_PREFIX);
      // Gone between the listing and the read: deleted by someone else meanwhile.
      if (got === null) continue;
      if (got.problem) { problems.push(got); continue; }
      items.push({ key: got.key, name: got.name, modified: got.modified, author: got.author, comment: got.comment });
    }
    const folded = foldThread(items);
    for (const c of folded.comments) comments.push({ ...c, thread: t.thread });
    for (const r of folded.rejected) problems.push({ key: r.key, thread: t.thread, problem: r.reason });
  }

  return {
    comments: comments.sort((a, b) => b.at - a.at || (a.key < b.key ? 1 : -1)),
    problems: problems.sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0)),
    threads: { shown: chosen.length, total: threads.size },
    truncated: chosen.length < threads.size,
  };
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

/**
 * Take a published comment down, with the events that refer to it so they do
 * not linger as "refers to a comment that is not before it". Owners, admins
 * and editors only -- the caller checks the role; this checks the key.
 */
export async function removeComment(ops, { thread, name }) {
  const parsed = typeof name === "string" ? parseEntryName(name) : null;
  if (!validThread(thread) || !parsed) throw new CommentError("Not a comment.", 400);
  const key = `${COMMENTS_PREFIX}${thread}/${name}`;
  const got = await ops.read(key);
  if (got === null) throw new CommentError("That comment is already gone.", 404);
  let kind;
  try { kind = JSON.parse(got.text).kind; } catch { kind = null; }
  if (kind !== "comment") throw new CommentError("That is not a comment; only comments can be deleted.", 400);
  const events = [];
  for (const o of await ops.list(`${COMMENTS_PREFIX}${thread}/`)) {
    const p = parseEntryName(o.key.slice(o.key.lastIndexOf("/") + 1));
    // Events are named for their kind (comments.mjs event()), so only those
    // need reading. A slug is display sugar, so the ref inside is what decides.
    if (!p || !["resolve", "reopen", "retract"].includes(p.slug)) continue;
    const ev = await ops.read(o.key);
    if (ev === null) continue;
    let ref;
    try { ref = JSON.parse(ev.text).ref; } catch { ref = null; }
    if (ref === name) events.push(o.key);
  }
  await ops.remove(key);
  for (const k of events) await ops.remove(k);
  return { key, events: events.length };
}

/**
 * Clear a published object readers refuse -- junk, or a comment overwritten by
 * someone else's upload -- which removeComment will not touch because it is not
 * a readable comment. Only refused objects: a valid one goes through
 * removeComment, so its events go with it.
 */
export async function discard(ops, key) {
  if (typeof key !== "string" || !key.startsWith(COMMENTS_PREFIX) || key.includes("..")) {
    throw new CommentError("Not a published comment object.", 400);
  }
  const got = await ops.read(key);
  if (got === null) throw new CommentError("That object is already gone.", 404);
  const item = await inspect(ops, key, new Date(got.modified).getTime(), COMMENTS_PREFIX);
  if (item && !item.problem) {
    throw new CommentError("Readers accept that one. Delete it as a comment instead.", 409);
  }
  await ops.remove(key);
  return { key };
}

export async function reject(ops, key) {
  if (typeof key !== "string" || !key.startsWith(PENDING_PREFIX) || key.includes("..")) {
    throw new CommentError("Not a pending comment.", 400);
  }
  await ops.remove(key);
  return { key };
}
