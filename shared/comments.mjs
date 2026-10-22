// Page comments: the rules every comment is held to, and the browser library
// every site loads to read and write them.
//
// Pure: no filesystem, no S3, no network, no SDK. Node imports the rules (the
// tests, and the Lambda that will sign upload tickets); browsers get
// clientSource(), which is assembled from the SAME functions by toString(). One
// implementation, so what test/comments.test.mjs checks is byte for byte what a
// reader's browser runs.
//
// NO COMPUTE ON THE READ OR WRITE PATH
//
// Reading a page costs nothing at rest, and comments keep it that way:
//
//   list    GET /__qw/comments/<thread>/          the edge turns this into an
//                                                 S3 ListObjectsV2 on the site's
//                                                 own _comments/<thread>/ prefix
//   read    GET /__qw/comments/<thread>/<name>    one object, immutable
//   write   POST straight to S3                   a browser form upload, held to
//                                                 a policy S3 itself enforces
//
// The only Lambda involved is the one that already signs readers in: it issues
// the upload "ticket" (an S3 POST policy) once per session, at
// GET /api/comments/ticket. The policy pins the content type, the size range,
// the key prefix and the x-amz-meta-uid / x-amz-meta-name of the person it was
// issued to, and S3 refuses any upload that breaks it. That is what stops a
// multi-gigabyte video: not this file, which an attacker never has to run.
//
// WHAT AN ATTACKER CAN STILL DO, AND WHY IT DOES NOT REACH A READER
//
// Inside those limits, anyone holding a ticket can upload any bytes they like.
// So nothing here trusts a stored object. Every reader checks every entry on
// the way in -- key shape, author against signed metadata, claimed time against
// S3's own LastModified, JSON, schema, lengths, characters -- and an entry that
// fails is reported in `rejected`, never rendered. Text reaches the page only as
// text: rendering is the site's job, and the one rule for it is textContent,
// never innerHTML.
//
// KEYS
//
//   <prefix><thread>/<stamp>-<uid>-<slug>.json
//   sites/acme/_comments/my-article/20261022T153012123Z-k3m9x2p7q4w8-great-post.json
//
//   stamp   UTC to the millisecond, fixed width, so S3's byte order IS time order
//   uid     the author, as the ticket names them; checked against x-amz-meta-uid
//   slug    from the subject, or the kind for an event; display sugar only
//
// The stamp is the client's claim, so it is only accepted within skewSec of
// LastModified. The ticket carries the server's clock so an honest client with a
// wrong clock is corrected rather than rejected.
//
// OBJECTS (v1)
//
//   { "v": 1, "kind": "comment", "thread": "...", "subject": "...", "body": "..." }
//   { "v": 1, "kind": "resolve" | "reopen" | "retract", "thread": "...", "ref": "<name>" }
//
// Nothing is ever overwritten or deleted by a reader. Resolving, reopening and
// retracting are new objects that refer to a comment; foldThread() applies them
// in time order. Anyone signed in may resolve or reopen; only the author may
// retract. Author and time are never taken from the body.

const LIMITS = Object.freeze({
  bodyChars: 2000,
  subjectChars: 80,
  authorChars: 80,
  threadChars: 120,
  slugChars: 40,
  // A 2000-character body of 4-byte characters is 8000 bytes before the JSON
  // around it. The ticket's content-length-range uses this same number.
  objectBytes: 10240,
  skewSec: 600,
  // 1,000 entries a page, so 20,000 per thread before load() stops and says so.
  listPages: 20,
  parallel: 6,
  // A ticket this close to expiry is refetched rather than used.
  ticketMarginSec: 60,
});

export const COMMENT_LIMITS = LIMITS;
export const COMMENT_KINDS = Object.freeze(["comment", "resolve", "reopen", "retract"]);
export const COMMENTS_PATH = "/__qw/comments/";
export const TICKET_PATH = "/api/comments/ticket";

// ------------------------------------------------------------------- rules
//
// Everything from here to clientSource() is shipped to the browser by
// toString(), so each function may use only its arguments, LIMITS, the other
// functions in PURE, and what both Node and browsers provide. No imports, no
// module-level helpers outside the list.

/** Why a piece of text is unacceptable, or null. Length is in code points. */
function textProblem(label, value, max, required, multiline) {
  if (typeof value !== "string") return label + " must be text";
  if (required && value.trim() === "") return label + " is empty";
  if (Array.from(value).length > max) return label + " is longer than " + max + " characters";
  // C0 controls but tab and newline, DEL and C1, the byte-order mark, and the
  // bidirectional overrides and isolates -- which make text display in a
  // different order than it reads, the classic way to disguise a link.
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f﻿‪-‮⁦-⁩]/.test(value)) {
    return label + " contains control characters";
  }
  if (!multiline && /[\t\n]/.test(value)) return label + " must be one line";
  return null;
}

function validThread(t) {
  return typeof t === "string" && t.length > 0 && t.length <= LIMITS.threadChars &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(t);
}

function validSite(s) {
  return typeof s === "string" && /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(s);
}

/**
 * The thread a page gets when it does not name one: its path, without .html,
 * lowercased, anything else folded to hyphens. "/" and "/index.html" are
 * "index"; "/docs/" is "docs". A static site with no article ids gets a stable
 * thread per page for free, and can always name one explicitly instead.
 */
function threadFromPath(pathname) {
  var p = String(pathname || "/").toLowerCase().replace(/\/index\.html?$/, "/").replace(/\.html?$/, "");
  var segs = p.split("/")
    .map(function (s) { return s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); })
    .filter(function (s) { return s.length > 0; });
  var t = segs.length ? segs.join("/") : "index";
  return t.length > LIMITS.threadChars ? t.slice(0, LIMITS.threadChars).replace(/[-\/]+$/, "") : t;
}

/** The site a hosted page belongs to, from its host; null when that cannot tell. */
function siteFromHost(host, apex) {
  host = String(host || "").toLowerCase();
  if (host === apex || host === "www." + apex) return "www";
  var tail = "." + apex;
  if (host.length > tail.length && host.slice(-tail.length) === tail) {
    var label = host.slice(0, -tail.length);
    return label !== "app" && validSite(label) ? label : null;
  }
  return null;
}

function slugify(text, fallback) {
  var s = String(text || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length > LIMITS.slugChars) s = s.slice(0, LIMITS.slugChars).replace(/-+$/, "");
  return s || fallback;
}

/** 2026-10-22T15:30:12.123Z -> 20261022T153012123Z */
function stampOf(ms) {
  var d = new Date(ms);
  if (isNaN(d.getTime())) throw new Error("not a time: " + ms);
  return d.toISOString().replace(/[-:.]/g, "");
}

function buildEntryName(ms, uid, slug) {
  return stampOf(ms) + "-" + uid + "-" + slug + ".json";
}

/** { stamp, at, uid, slug } for a well-formed object name, else null. */
function parseEntryName(name) {
  var m = /^((\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z)-([a-z0-9]{8,32})-([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/
    .exec(typeof name === "string" ? name : "");
  if (!m || m[10].length > LIMITS.slugChars) return null;
  var at = Date.UTC(+m[2], +m[3] - 1, +m[4], +m[5], +m[6], +m[7], +m[8]);
  if (stampOf(at) !== m[1]) return null; // 20261340T... is not a date
  return { stamp: m[1], at: at, uid: m[9], slug: m[10] };
}

function byteLength(s) {
  return new TextEncoder().encode(s).length;
}

/**
 * Everything wrong with a comment object, as sentences a person can act on.
 * An empty list means it may be written, and may be shown.
 */
function lintComment(obj, thread) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return ["a comment must be a JSON object"];
  var problems = [];
  var isComment = obj.kind === "comment";
  var isEvent = obj.kind === "resolve" || obj.kind === "reopen" || obj.kind === "retract";
  if (!isComment && !isEvent) problems.push("unknown kind " + JSON.stringify(obj.kind));
  var allowed = isComment ? ["v", "kind", "thread", "subject", "body"] : ["v", "kind", "thread", "ref"];
  Object.keys(obj).forEach(function (k) {
    if (allowed.indexOf(k) === -1) problems.push("unexpected field " + JSON.stringify(k));
  });
  if (obj.v !== 1) problems.push("unsupported version " + JSON.stringify(obj.v));
  if (!validThread(obj.thread)) problems.push("thread is not valid");
  else if (thread !== undefined && obj.thread !== thread) problems.push("belongs to another thread");
  if (isComment) {
    var p = obj.subject === undefined ? null : textProblem("subject", obj.subject, LIMITS.subjectChars, false, false);
    if (p) problems.push(p);
    p = textProblem("comment", obj.body, LIMITS.bodyChars, true, true);
    if (p) problems.push(p);
  } else if (isEvent && !parseEntryName(obj.ref)) {
    problems.push("ref is not a comment name");
  }
  if (!problems.length && byteLength(JSON.stringify(obj)) > LIMITS.objectBytes) {
    problems.push("comment is larger than " + LIMITS.objectBytes + " bytes");
  }
  return problems;
}

function decodeXml(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, function (_, e) {
    if (e.charAt(0) === "#") {
      return String.fromCodePoint(e.charAt(1) === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    }
    return { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" }[e];
  });
}

function xmlTag(xml, tag) {
  var m = new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">").exec(xml);
  return m ? decodeXml(m[1]) : null;
}

/**
 * An S3 ListObjectsV2 response, as { entries: [{ key, modified, size }],
 * truncated, next }. S3 writes this XML and escapes every key in it, so a flat
 * pattern match is exact -- and unlike DOMParser it runs, and is tested, in
 * Node. Anything that is not a list response throws: an error page or a
 * misrouted request must not read as "no comments".
 */
function parseListXml(xml) {
  if (typeof xml !== "string" || xml.indexOf("<ListBucketResult") === -1) {
    throw new Error("the comment list is not an S3 list response");
  }
  var entries = [];
  var re = /<Contents>([\s\S]*?)<\/Contents>/g;
  var m;
  while ((m = re.exec(xml)) !== null) {
    var key = xmlTag(m[1], "Key");
    var modified = Date.parse(xmlTag(m[1], "LastModified") || "");
    var size = Number(xmlTag(m[1], "Size"));
    if (key === null || isNaN(modified) || !(size >= 0)) {
      throw new Error("an S3 list entry is missing its Key, LastModified or Size");
    }
    entries.push({ key: key, modified: modified, size: size });
  }
  return { entries: entries, truncated: xmlTag(xml, "IsTruncated") === "true", next: xmlTag(xml, "NextContinuationToken") };
}

/**
 * A listed key, checked before anything is fetched for it:
 * { entry } with the parsed name, or { reason } it will not be shown.
 */
function checkEntry(listed, thread) {
  var key = listed.key;
  var name = key.slice(key.lastIndexOf("/") + 1);
  if (key.slice(-("/_comments/" + thread + "/" + name).length) !== "/_comments/" + thread + "/" + name) {
    return { reason: "not in this thread" };
  }
  var parsed = parseEntryName(name);
  if (!parsed) return { reason: "not a comment name" };
  if (listed.size > LIMITS.objectBytes) return { reason: "larger than " + LIMITS.objectBytes + " bytes" };
  if (Math.abs(parsed.at - listed.modified) > LIMITS.skewSec * 1000) return { reason: "its time does not match when it was stored" };
  return {
    entry: { key: key, name: name, stamp: parsed.stamp, uid: parsed.uid, slug: parsed.slug, modified: listed.modified, size: listed.size },
  };
}

/**
 * A fetched object, checked against its entry and the metadata the ticket
 * pinned: { item } ready to fold, or { reason }. `header` reads a response
 * header by lowercase name.
 */
function checkObject(entry, text, header, thread) {
  var obj;
  try { obj = JSON.parse(text); } catch (e) { return { reason: "not JSON" }; }
  var problems = lintComment(obj, thread);
  if (problems.length) return { reason: problems.join("; ") };
  if (header("x-amz-meta-uid") !== entry.uid) return { reason: "its author does not match who uploaded it" };
  var raw = header("x-amz-meta-name");
  var name;
  try { name = decodeURIComponent(raw === null ? "" : raw); } catch (e) { return { reason: "author name is not readable" }; }
  var p = textProblem("author name", name, LIMITS.authorChars, true, false);
  if (p) return { reason: p };
  return {
    item: {
      key: entry.key, name: entry.name, modified: entry.modified,
      author: { uid: entry.uid, name: name }, comment: obj,
    },
  };
}

/**
 * Checked items -> the thread as a reader sees it, oldest first. Events apply
 * in stored order; one that refers to an unknown comment, or a retraction by
 * anyone but the author, is reported rather than applied.
 */
function foldThread(items) {
  var sorted = items.slice().sort(function (a, b) {
    return (a.modified - b.modified) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });
  var byName = Object.create(null);
  var comments = [];
  var rejected = [];
  sorted.forEach(function (it) {
    var c = it.comment;
    if (c.kind === "comment") {
      var rec = {
        name: it.name, key: it.key, at: it.modified, author: it.author,
        subject: c.subject || "", body: c.body, resolved: null, retracted: false,
      };
      byName[it.name] = rec;
      comments.push(rec);
      return;
    }
    var target = byName[c.ref];
    if (!target) { rejected.push({ key: it.key, reason: c.kind + " refers to a comment that is not before it in this thread" }); return; }
    if (c.kind === "retract") {
      if (it.author.uid !== target.author.uid) rejected.push({ key: it.key, reason: "only the author can retract a comment" });
      else target.retracted = true;
    } else if (c.kind === "resolve") {
      target.resolved = { by: it.author, at: it.modified };
    } else {
      target.resolved = null;
    }
  });
  return { comments: comments.filter(function (c) { return !c.retracted; }), rejected: rejected };
}

function commentError(code, message, extra) {
  var e = new Error(message);
  e.name = "CommentError";
  e.code = code;
  if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
  return e;
}

/** What a ticket must look like before a browser will use it. */
function ticketProblem(t) {
  if (!t || typeof t !== "object") return "not an object";
  if (typeof t.url !== "string" || t.url.indexOf("https://") !== 0) return "url is not https";
  if (!t.fields || typeof t.fields !== "object") return "no form fields";
  if (typeof t.prefix !== "string" || !/^[a-z0-9\/_-]+\/$/.test(t.prefix)) return "prefix is not valid";
  if (typeof t.uid !== "string" || !/^[a-z0-9]{8,32}$/.test(t.uid)) return "uid is not valid";
  if (isNaN(Date.parse(t.expires)) || isNaN(Date.parse(t.now))) return "expires and now must be times";
  if (typeof t.pending !== "boolean") return "pending must be true or false";
  return null;
}

/**
 * The commenter's display name from the qw_cmt hint cookie, or null.
 *
 * NOT a credential. The real session (qw_commenter) is HttpOnly, so a page can
 * never see it; this companion, set beside it by /api/comments/session, only
 * lets a page decide between a form and a "Sign in" button without asking the
 * Lambda on every view. A forged or stale hint just shows a form whose Post is
 * refused with code "signin", and the UI falls back to the button.
 */
function hintName(cookies) {
  var m = /(?:^|;\s*)qw_cmt=([^;]*)/.exec(String(cookies || ""));
  if (!m || !m[1]) return null;
  // An undecodable hint is the same as no hint: there is nothing to show for it.
  try { return decodeURIComponent(m[1]) || null; } catch (e) { return null; }
}

/**
 * The client. `env` is everything it touches outside itself -- fetch, location,
 * FormData, Blob, a clock and the hosted apex -- so Node can drive it with
 * fakes and a browser hands it window's.
 */
function createClient(env, opts) {
  opts = opts || {};
  var origin = opts.origin || env.location.origin;
  var site = opts.site || siteFromHost(env.location.hostname, env.apex);
  if (!validSite(site)) {
    throw commentError("config", "QWComments cannot tell which site " + env.location.hostname + " is; pass { site: \"<id>\" }");
  }
  var thread = opts.thread || threadFromPath(env.location.pathname);
  if (!validThread(thread)) throw commentError("config", "not a valid thread: " + JSON.stringify(thread));
  var base = origin + "/__qw/comments/" + thread + "/";
  var ticket = null;
  var offset = 0;

  async function ok(res, what) {
    if (res.ok) return res;
    var detail = "";
    try { detail = (await res.text()).slice(0, 200); } catch (e) { detail = "(no body: " + e.message + ")"; }
    throw commentError("http", what + " failed: HTTP " + res.status, { status: res.status, detail: detail });
  }

  /** One page of the thread's keys, each already checked. */
  async function list(o) {
    o = o || {};
    var q = [];
    if (o.startAfter) q.push("start-after=" + encodeURIComponent(o.startAfter));
    if (o.next) q.push("continuation-token=" + encodeURIComponent(o.next));
    var res = await ok(await env.fetch(base + (q.length ? "?" + q.join("&") : ""), { credentials: "same-origin" }), "listing comments");
    var page = parseListXml(await res.text());
    var entries = [];
    var rejected = [];
    page.entries.forEach(function (l) {
      var c = checkEntry(l, thread);
      if (c.entry) entries.push(c.entry);
      else rejected.push({ key: l.key, reason: c.reason });
    });
    return { entries: entries, rejected: rejected, truncated: page.truncated, next: page.next };
  }

  /** One object: { item } or { reason }. A failed fetch throws. */
  async function get(entry) {
    var res = await ok(await env.fetch(base + entry.name, { credentials: "same-origin" }), "reading " + entry.name);
    var text = await res.text();
    return checkObject(entry, text, function (h) { return res.headers.get(h); }, thread);
  }

  /**
   * The whole thread, or what is new since `startAfter` (the last key a
   * previous load saw, returned as `last`). Folding needs the comments events
   * refer to, so an incremental load is for "is there anything new", and a
   * full load is what a page renders.
   */
  async function load(o) {
    o = o || {};
    var entries = [];
    var rejected = [];
    var next = null;
    var page;
    for (var i = 0; i < LIMITS.listPages; i++) {
      page = await list({ startAfter: i === 0 ? o.startAfter : undefined, next: next });
      entries = entries.concat(page.entries);
      rejected = rejected.concat(page.rejected);
      if (!page.truncated) break;
      next = page.next;
    }
    var items = [];
    for (var j = 0; j < entries.length; j += LIMITS.parallel) {
      var got = await Promise.all(entries.slice(j, j + LIMITS.parallel).map(get));
      got.forEach(function (g, k) {
        if (g.item) items.push(g.item);
        else rejected.push({ key: entries[j + k].key, reason: g.reason });
      });
    }
    var folded = foldThread(items);
    return {
      thread: thread,
      comments: folded.comments,
      rejected: rejected.concat(folded.rejected),
      complete: !page.truncated,
      last: entries.length ? entries[entries.length - 1].key : (o.startAfter || null),
    };
  }

  /** The upload ticket, or null when the reader is not signed in to comment. */
  async function session() {
    if (ticket && Date.parse(ticket.expires) - (env.now() + offset) > LIMITS.ticketMarginSec * 1000) return ticket;
    ticket = null;
    var res = await env.fetch(origin + "/api/comments/ticket?site=" + encodeURIComponent(site), { credentials: "same-origin" });
    if (res.status === 401) return null;
    await ok(res, "getting a comment ticket");
    var t = await res.json();
    var p = ticketProblem(t);
    if (p) throw commentError("ticket", "the comment ticket is unusable: " + p);
    offset = Date.parse(t.now) - env.now();
    ticket = t;
    return ticket;
  }

  function signInUrl() {
    return "https://app." + env.apex + "/access.html?site=" + encodeURIComponent(site) +
      "&for=comment&next=" + encodeURIComponent(env.location.pathname + env.location.search);
  }

  async function write(obj, slug) {
    var problems = lintComment(obj, thread);
    if (problems.length) throw commentError("invalid", problems.join("; "), { problems: problems });
    var t = await session();
    if (!t) throw commentError("signin", "Sign in to comment.", { signInUrl: signInUrl() });
    var name = buildEntryName(env.now() + offset, t.uid, slug);
    var form = new env.FormData();
    Object.keys(t.fields).forEach(function (k) { form.append(k, t.fields[k]); });
    form.append("key", t.prefix + thread + "/" + name);
    // S3 reads every field before the file and ignores anything after it.
    form.append("file", new env.Blob([JSON.stringify(obj)], { type: "application/json" }));
    var res = await env.fetch(t.url, { method: "POST", body: form });
    if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
      var xml = await res.text();
      // A ticket S3 no longer honours is dropped, so the next attempt gets a fresh one.
      if (res.status === 403) ticket = null;
      throw commentError("upload", "S3 refused the comment: " + (xmlTag(xml, "Message") || "HTTP " + res.status),
        { status: res.status, s3Code: xmlTag(xml, "Code") });
    }
    // pending: the site requires approval, so nobody -- the author included --
    // will see this in load() until a site admin approves it. Say so on screen.
    return { name: name, key: t.prefix + thread + "/" + name, pending: t.pending, author: { uid: t.uid, name: t.name } };
  }

  async function event(kind, ref) {
    if (!parseEntryName(ref)) throw commentError("invalid", "not a comment name: " + JSON.stringify(ref));
    return write({ v: 1, kind: kind, thread: thread, ref: ref }, kind);
  }

  return Object.freeze({
    site: site,
    thread: thread,
    list: list,
    get: get,
    load: load,
    session: session,
    signInUrl: signInUrl,
    signIn: function () { env.location.assign(signInUrl()); },
    /** Who the hint cookie says is signed in to comment here, or null. */
    commenter: function () { return hintName(env.cookie ? env.cookie() : ""); },
    signOut: async function () {
      ticket = null;
      return (await ok(await env.fetch(origin + "/api/comments/session?site=" + encodeURIComponent(site),
        { method: "DELETE", credentials: "same-origin" }), "signing out")).json();
    },
    post: function (c) {
      var obj = { v: 1, kind: "comment", thread: thread, body: c && c.body };
      if (c && c.subject) obj.subject = c.subject;
      return write(obj, slugify(c && c.subject, "comment"));
    },
    resolve: function (name) { return event("resolve", name); },
    reopen: function (name) { return event("reopen", name); },
    retract: function (name) { return event("retract", name); },
  });
}

/**
 * The default comment section, for a page that wants comments without writing a
 * renderer: any element carrying data-qw-comments gets one (see autoMount in
 * clientSource). Everything a stranger wrote goes in with textContent. Class
 * names are qw-c-*, styled by DEFAULT_CSS at the lowest specificity, so a
 * template restyles them with ordinary selectors or the --qw-c-* properties.
 */
function mountUi(root, client, doc, win) {
  var h = function (tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  };
  var button = function (cls, text) { var b = h("button", cls, text); b.type = "button"; return b; };
  // Storage is a convenience (a draft, which comments are mine); a browser that
  // refuses it still gets a working section, and the console says why.
  var store = function (kind, key, value) {
    try {
      var s = win[kind];
      if (value === undefined) return s.getItem(key);
      if (value === null) s.removeItem(key); else s.setItem(key, value);
    } catch (e) { win.console.warn("QWComments: " + kind + " is unavailable", e); }
    return null;
  };
  var DRAFT = "qw-comments-draft:" + client.site + ":" + client.thread;
  var MINE = "qw-comments-uid";

  root.classList.add("qw-comments");
  root.replaceChildren();
  var list = h("div", "qw-c-list");
  var composer = h("div", "qw-c-composer");
  var status = h("p", "qw-c-note");
  status.setAttribute("role", "status");
  status.hidden = true;
  root.append(h("h2", "qw-c-title", root.getAttribute("data-qw-title") || "Comments"), list, composer, status);

  function say(text, isError) {
    status.textContent = text || "";
    status.hidden = !text;
    status.className = "qw-c-note" + (isError ? " qw-c-error" : "");
  }

  function render(thread) {
    list.replaceChildren();
    if (!thread.comments.length) list.append(h("p", "qw-c-note", "No comments yet."));
    var mine = store("localStorage", MINE);
    var signedIn = Boolean(client.commenter());
    thread.comments.forEach(function (c) {
      var card = h("article", "qw-c-comment" + (c.resolved ? " qw-c-resolved" : ""));
      var when = new Date(c.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      var meta = h("p", "qw-c-meta");
      meta.append(h("strong", "qw-c-author", c.author.name), doc.createTextNode(" · " + when +
        (c.resolved ? " · resolved by " + c.resolved.by.name : "")));
      card.append(meta);
      if (c.subject) card.append(h("p", "qw-c-subject", c.subject));
      card.append(h("p", "qw-c-body", c.body));
      if (signedIn) {
        var acts = h("div", "qw-c-actions");
        var add = function (label, fn) {
          var b = button("qw-c-link", label);
          b.addEventListener("click", function () { act(b, fn); });
          acts.append(b);
        };
        add(c.resolved ? "Reopen" : "Resolve", function () { return c.resolved ? client.reopen(c.name) : client.resolve(c.name); });
        if (mine && mine === c.author.uid) add("Retract", function () { return client.retract(c.name); });
        card.append(acts);
      }
      list.append(card);
    });
  }

  function load() {
    return client.load().then(render, function (e) {
      list.replaceChildren(h("p", "qw-c-note qw-c-error", "Comments could not be loaded: " + e.message));
    });
  }

  // Every write: resolves true once stored. Sign-in, approval and S3's
  // refusals all reach the reader, none of them silently.
  function act(btn, write) {
    btn.disabled = true;
    say("");
    return write().then(function (res) {
      if (res && res.author) store("localStorage", MINE, res.author.uid);
      if (res && res.pending) say("Thanks. Your comment will appear once it has been approved.");
      return load().then(function () { return true; });
    }, function (e) {
      if (e.code === "signin") {
        signInBox();
        say("Sign in again to post. Your draft is kept.");
      } else {
        say(e.message, true);
      }
      return false;
    }).then(function (stored) { btn.disabled = false; return stored; });
  }

  function signInBox() {
    composer.replaceChildren();
    var b = button("qw-c-button qw-c-primary", "Sign in to comment");
    b.addEventListener("click", function () { client.signIn(); });
    composer.append(b, h("p", "qw-c-hint", "With Google or Microsoft. Your name is shown with what you write; your email address never is."));
  }

  function form(name) {
    composer.replaceChildren();
    var f = h("form", "qw-c-form");
    var text = h("textarea", "qw-c-input");
    text.rows = 4;
    text.placeholder = "Add a comment";
    text.setAttribute("aria-label", "Comment");
    text.value = store("sessionStorage", DRAFT) || "";
    var count = h("span", "qw-c-count");
    var post = h("button", "qw-c-button qw-c-primary", "Post");
    post.type = "submit";
    var out = button("qw-c-link", "Sign out");
    var row = h("div", "qw-c-row");
    row.append(post, count);
    var who = h("p", "qw-c-hint");
    who.append(doc.createTextNode("Commenting as "), h("strong", null, name), doc.createTextNode(" · "), out);
    f.append(text, row, who);
    var update = function () {
      var n = Array.from(text.value).length;
      count.textContent = n + " / " + LIMITS.bodyChars;
      count.classList.toggle("qw-c-over", n > LIMITS.bodyChars);
      // Kept across a sign-in round trip, which leaves the page.
      store("sessionStorage", DRAFT, text.value ? text.value : null);
    };
    text.addEventListener("input", update);
    update();
    f.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var problems = lintComment({ v: 1, kind: "comment", thread: client.thread, body: text.value }, client.thread);
      if (problems.length) return say(problems.join("; "), true);
      act(post, function () { return client.post({ body: text.value }); }).then(function (stored) {
        if (stored) { text.value = ""; update(); }
      });
    });
    out.addEventListener("click", function () {
      act(out, function () { return client.signOut(); }).then(compose);
    });
    composer.append(f);
  }

  function compose() {
    var name = client.commenter();
    if (name) form(name); else signInBox();
  }

  compose();
  return load();
}

const PURE = [
  textProblem, validThread, validSite, threadFromPath, siteFromHost, slugify, stampOf, buildEntryName,
  parseEntryName, byteLength, lintComment, decodeXml, xmlTag, parseListXml, checkEntry, checkObject,
  foldThread, commentError, ticketProblem, hintName, createClient, mountUi,
];

export {
  textProblem, validThread, validSite, threadFromPath, siteFromHost, slugify, stampOf, buildEntryName,
  parseEntryName, lintComment, parseListXml, checkEntry, checkObject, foldThread, ticketProblem, hintName, createClient,
};

/**
 * The default section's look: structure and spacing only, colours derived from
 * the page's own text colour, and :where() so any template rule wins. Override
 * --qw-c-accent (buttons) or style the qw-c-* classes directly.
 */
export const DEFAULT_CSS = [
  ":where(.qw-comments){--qw-c-accent:#3554d1;--qw-c-rule:color-mix(in srgb,currentColor 16%,transparent);",
  "--qw-c-soft:color-mix(in srgb,currentColor 62%,transparent);display:grid;gap:1rem;margin:3rem 0 0}",
  ":where(.qw-comments) :where(.qw-c-title){font-size:1.25rem;margin:0}",
  ":where(.qw-comments) :where(.qw-c-list){display:grid;gap:.75rem}",
  ":where(.qw-comments) :where(.qw-c-comment){border:1px solid var(--qw-c-rule);border-radius:8px;padding:.85rem 1rem}",
  ":where(.qw-comments) :where(.qw-c-resolved){opacity:.6}",
  ":where(.qw-comments) :where(.qw-c-meta,.qw-c-hint,.qw-c-count){color:var(--qw-c-soft);font-size:.85rem;margin:0}",
  ":where(.qw-comments) :where(.qw-c-meta){margin:0 0 .35rem}",
  ":where(.qw-comments) :where(.qw-c-author){color:currentColor}",
  ":where(.qw-comments) :where(.qw-c-subject){font-weight:600;margin:0 0 .2rem}",
  ":where(.qw-comments) :where(.qw-c-body){white-space:pre-wrap;overflow-wrap:anywhere;margin:0}",
  ":where(.qw-comments) :where(.qw-c-actions){display:flex;gap:1rem;margin-top:.5rem}",
  ":where(.qw-comments) :where(.qw-c-form,.qw-c-composer){display:grid;gap:.6rem}",
  ":where(.qw-comments) :where(.qw-c-input){font:inherit;color:inherit;background:transparent;width:100%;box-sizing:border-box;",
  "border:1px solid var(--qw-c-rule);border-radius:6px;padding:.6rem .75rem;resize:vertical}",
  ":where(.qw-comments) :where(.qw-c-row){display:flex;align-items:center;gap:.8rem}",
  ":where(.qw-comments) :where(.qw-c-count){margin-left:auto}",
  ":where(.qw-comments) :where(.qw-c-over){color:#c0392b}",
  ":where(.qw-comments) :where(.qw-c-button){font:inherit;cursor:pointer;border-radius:6px;padding:.45rem 1rem;",
  "border:1px solid var(--qw-c-rule);background:transparent;color:inherit;justify-self:start}",
  ":where(.qw-comments) :where(.qw-c-primary){background:var(--qw-c-accent);border-color:var(--qw-c-accent);color:#fff}",
  ":where(.qw-comments) :where(.qw-c-link){font:inherit;font-size:.85rem;cursor:pointer;border:0;padding:0;background:none;",
  "color:var(--qw-c-accent)}",
  ":where(.qw-comments) :where(button:disabled){opacity:.5;cursor:default}",
  ":where(.qw-comments) :where(.qw-c-note){margin:0;color:var(--qw-c-soft)}",
  ":where(.qw-comments) :where(.qw-c-error){color:#c0392b}",
].join("");

/**
 * The browser library, served at /__qw/lib/comments.js. `apex` is the hosted
 * domain, which is how a page on acme.quickieweb.com knows it is "acme" and
 * where the sign-in page lives.
 *
 *   <script src="https://quickieweb.com/__qw/lib/comments.js"></script>
 *   const c = QWComments.connect();             // or { site, thread, origin }
 *   const { comments, rejected } = await c.load();
 *   await c.post({ subject, body });            // throws code "signin" -> c.signIn()
 *                                               // { pending: true } -> awaiting approval
 *
 * Or, with no code at all, the default section on any element that asks:
 *
 *   <section data-qw-comments data-qw-thread="my-article"></section>
 */
export function clientSource({ apex }) {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(apex ?? "")) throw new Error(`not a hosted domain: ${apex}`);
  return `// Quickieweb comments. Generated -- edit shared/comments.mjs instead.
(function () {
  "use strict";
  var APEX = ${JSON.stringify(apex)};
  var LIMITS = Object.freeze(${JSON.stringify(LIMITS)});

${PURE.map(String).join("\n\n")}

  function connect(opts) {
    return createClient({
      fetch: window.fetch.bind(window),
      location: window.location,
      FormData: window.FormData,
      Blob: window.Blob,
      now: function () { return Date.now(); },
      cookie: function () { return document.cookie; },
      apex: APEX,
    }, opts);
  }

  var cssDone = false;
  function mount(el, opts) {
    if (!cssDone) {
      var style = document.createElement("style");
      style.setAttribute("data-qw-comments-css", "");
      style.textContent = ${JSON.stringify(DEFAULT_CSS)};
      document.head.prepend(style);
      cssDone = true;
    }
    opts = opts || {};
    var client;
    try {
      client = connect({
        site: opts.site || el.getAttribute("data-qw-site") || undefined,
        thread: opts.thread || el.getAttribute("data-qw-thread") || undefined,
      });
    } catch (e) {
      // Shown where the section would be, not just logged: a misconfigured page
      // should say so to whoever is looking at it.
      el.textContent = "Comments are unavailable here: " + e.message;
      console.error("QWComments:", e);
      return Promise.resolve(null);
    }
    el.setAttribute("data-qw-mounted", "");
    return mountUi(el, client, document, window).then(function () { return client; });
  }

  function autoMount() {
    var els = document.querySelectorAll("[data-qw-comments]:not([data-qw-mounted])");
    for (var i = 0; i < els.length; i++) mount(els[i]);
  }

  window.QWComments = Object.freeze({
    connect: connect,
    mount: mount,
    lint: lintComment,
    threadFromPath: threadFromPath,
    limits: LIMITS,
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoMount);
  else autoMount();
})();
`;
}
