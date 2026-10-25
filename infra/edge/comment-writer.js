// CloudFront Function, viewer request, on the /__qw/post/* behavior.
//
// The only way a comment is written. A reader's browser PUTs the comment to its
// own site, the same origin it reads from:
//
//   PUT /__qw/post/<thread>/<stamp>-<uid>-<slug>.json
//   x-qw-ticket: t1.<site>.<exp>.<uid>.<role>.<c|p>.<name>.<hmac>
//
// and this function decides whether S3 sees it. CloudFront then signs the
// request to the bucket itself (origin access control), so nothing a browser
// holds can write to S3 directly.
//
// WHAT IS CHECKED, AND WHY HERE
//
// The ticket is minted by the Lambda (shared/comment-ticket.mjs) under the same
// secret the edge already holds for reader access. It names one person on one
// site, for at most TICKET_SEC. This function refuses the PUT unless:
//
//   - the ticket is ours, unexpired, and for the site on this host
//   - the uid in the file name is the ticket's uid -- the rule an S3 POST policy
//     could not express, because the uid sits in the middle of the key
//   - the name's time is near now, as a reader will insist it is
//   - the declared size is within the limit (S3 holds the body to it)
//
// Then it REPLACES every header S3 acts on: author metadata from the ticket,
// the content type and cache policy every comment has, and If-None-Match: *, so
// S3 refuses to write over a key that exists -- anyone's, the author's included.
// Comments are never rewritten; resolve, reopen and retract are new objects.
//
// The bucket policy only lets this distribution PutObject under _comments/ and
// _pending/, and only with If-None-Match present (infra/wire-comments.mjs), so a
// mistake here cannot reach the rest of the bucket or overwrite anything.
//
// Runtime: cloudfront-js-2.0, deployed with full-line comments stripped.
// test/comment-writer.test.mjs holds it to the same answers as the Lambda's
// signer and the readers' rules.

import cf from 'cloudfront';
import crypto from 'crypto';

var APEX = '__APEX__';
var PREFIX = 'sites/';
var MARKETING = 'www';
var TICKET_MAX_SEC = 3600;
var MAX_BYTES = 10240;
var SKEW_SEC = 600;
var CACHE = 'public, max-age=31536000, immutable';
var ROLES = ['owner', 'admin', 'editor', 'viewer', 'none'];
var THREAD_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
var NAME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-([a-z0-9]{8,32})-[a-z0-9]+(?:-[a-z0-9]+)*\.json$/;
var kvs = cf.kvs();

async function handler(event) {
  var request = event.request;
  if (request.method !== 'PUT') return refuse(405, 'Comments are written with PUT');

  var siteId = siteFor(request.headers.host ? request.headers.host.value : '');
  if (siteId === null) return refuse(404, 'No site here');

  var rest = request.uri.substring(11);
  var cut = rest.lastIndexOf('/');
  var thread = rest.substring(0, cut);
  var name = rest.substring(cut + 1);
  if (request.uri.substring(0, 11) !== '/__qw/post/' || cut < 1 || thread.length > 120 || !THREAD_RE.test(thread)) {
    return refuse(404, 'Not a comment thread');
  }
  var m = NAME_RE.exec(name);
  if (!m) return refuse(400, 'Not a comment name');

  var h = request.headers['x-qw-ticket'];
  var t = await ticket(h ? h.value : '', siteId);
  if (t === null) return refuse(403, 'The comment ticket is missing, expired or not for this site');
  if (m[8] !== t.uid) return refuse(403, 'A comment can only be written under its author\'s own uid');

  var at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
  if (Math.abs(at - Date.now()) > SKEW_SEC * 1000) return refuse(400, 'The comment\'s time is too far from now');

  var len = request.headers['content-length'] ? parseInt(request.headers['content-length'].value, 10) : NaN;
  if (!(len >= 1 && len <= MAX_BYTES)) return refuse(413, 'A comment is 1 to ' + MAX_BYTES + ' bytes');

  // Only what this function sets reaches S3: anything else the browser sent
  // that S3 would act on (x-amz-*, ACLs, redirects, tags) is dropped first.
  var keep = { 'host': 1, 'content-length': 1 };
  for (var k in request.headers) {
    if (!keep[k]) delete request.headers[k];
  }
  request.headers['content-type'] = { value: 'application/json' };
  request.headers['cache-control'] = { value: CACHE };
  request.headers['if-none-match'] = { value: '*' };
  request.headers['x-amz-meta-uid'] = { value: t.uid };
  request.headers['x-amz-meta-name'] = { value: t.name };
  request.headers['x-amz-meta-role'] = { value: t.role };
  request.cookies = {};
  request.querystring = {};
  request.uri = '/' + PREFIX + siteId + '/' + (t.pending ? '_pending/' : '_comments/') + thread + '/' + name;
  return request;
}

// The apex is the marketing site; <label>.<apex> is that site. Anything else
// is no site at all.
function siteFor(host) {
  host = host.toLowerCase();
  var colon = host.indexOf(':');
  if (colon !== -1) host = host.substring(0, colon);
  if (host.length && host.charAt(host.length - 1) === '.') host = host.substring(0, host.length - 1);
  if (host === APEX) return MARKETING;
  var tail = '.' + APEX;
  if (host.length <= tail.length || host.substring(host.length - tail.length) !== tail) return null;
  var label = host.substring(0, host.length - tail.length);
  return /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(label) ? label : null;
}

// { uid, role, pending, name } from a ticket, or null if anything about it is
// wrong. <name> is the display name URI-encoded with its dots escaped, so the
// token always splits into exactly eight parts.
async function ticket(token, siteId) {
  var p = String(token).split('.');
  if (p.length !== 8 || p[0] !== 't1' || p[1] !== siteId) return null;
  var exp = parseInt(p[2], 10);
  var now = Math.floor(Date.now() / 1000);
  if (!(exp > now) || exp > now + TICKET_MAX_SEC) return null;
  if (!/^[a-z0-9]{8,32}$/.test(p[3]) || ROLES.indexOf(p[4]) === -1 || (p[5] !== 'c' && p[5] !== 'p')) return null;
  if (!/^[A-Za-z0-9%_~!*'()-]{1,1000}$/.test(p[6])) return null;
  var secret = await kvGet('_secret');
  if (secret === null) throw new Error('access store has no _secret');
  var want = crypto.createHmac('sha256', secret).update(p.slice(0, 7).join('.')).digest('hex');
  if (!same(p[7], want)) return null;
  return { uid: p[3], role: p[4], pending: p[5] === 'p', name: p[6] };
}

async function kvGet(key) {
  if (!(await kvs.exists(key))) return null;
  return await kvs.get(key);
}

function same(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function refuse(status, message) {
  return {
    statusCode: status,
    statusDescription: message,
    headers: {
      'content-type': { value: 'application/json' },
      'cache-control': { value: 'no-store' }
    },
    body: JSON.stringify({ error: message })
  };
}
