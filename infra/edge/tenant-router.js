// CloudFront Function, viewer request, attached to the default behavior.
//
// Maps a Host header onto a key prefix in the shared live bucket, and decides
// whether the reader may see the page. No lookup table for routing, because the
// site id IS the subdomain:
//
//   quickieweb.com          -> /sites/www/...      (the marketing site)
//   www.quickieweb.com      -> 301 to the apex     (one canonical host)
//   app.quickieweb.com      -> /admin/...          (the console, one copy)
//   acme.quickieweb.com     -> /sites/acme/...
//   anything else           -> 404, never a default site
//
// The console gets its own host for a reason outside AWS: Google OAuth
// authorized origins cannot contain wildcards, so an admin at
// <site>.quickieweb.com/admin/ would mean calling the Google API to add an
// origin on every signup. One host, one origin, forever.
//
// Runtime: cloudfront-js-2.0. Deployed with full-line comments stripped
// (infra/provision-access.mjs), because CloudFront caps a function at 10 KB.
//
// WHY VIEWER-REQUEST AND NOT ORIGIN-REQUEST
//
// The rewrite has to happen before the cache lookup, so the cache key carries
// the tenant prefix and two tenants' /index.html cannot collide. It is also why
// the access check can live here: it runs on every request, cached or not, so a
// protected page in the cache is still only handed to someone allowed to read it.
//
// ACCESS
//
// The edge store (a CloudFront KeyValueStore) holds, per protected site:
//   <siteId>          the site's default level        e.g. "viewer"
//   <siteId>/<path>   a page that differs from it      e.g. "jeffseats/team.html" -> "admin"
//   _secret           the HMAC key for access tokens
// A site with no entry is public, which is every site until someone turns
// protection on -- one existence check per request, and nothing else.
//
// Levels are public < viewer < editor < admin (shared/site.mjs is the source).
// The reader's level comes from the qw_access cookie: `v1.<site>.<level>.<exp>.<hmac>`,
// minted here at /__qw/session from a 2-minute grant the console's sign-in page
// obtains from the Lambda (`g1.` prefix, same shape). Tokens are signed by
// shared/access-token.mjs on the Lambda side; test/edge.test.mjs holds the two
// implementations to the same answers.
//
// FAILURE IS CLOSED. If the store cannot be read, the function throws and
// CloudFront answers 503 -- an outage must never serve a protected page.
//
// KEEP THIS IN SYNC WITH shared/site.mjs
//
// hostToSiteId() there and this function must agree on what a valid label is.
// They are tested against each other in test/edge.test.mjs, because a
// disagreement means the admin writes to one prefix and readers are served from
// another.

import cf from 'cloudfront';
import crypto from 'crypto';

var APEX = '__APEX__';           // replaced at deploy time from config.hosted.domain
var PREFIX = 'sites/';
var MARKETING = 'www';           // the site served at the apex
var CONSOLE = 'app';             // the admin console host: app.<apex>
var LEVELS = ['public', 'viewer', 'editor', 'admin'];
var COOKIE = 'qw_access';
var SESSION_SEC = 43200;         // 12 hours
var GRANT_MAX_SEC = 120;
var kvs = cf.kvs();

async function handler(event) {
  var request = event.request;
  var host = request.headers.host ? request.headers.host.value.toLowerCase() : '';
  var uri = request.uri;

  // Strip a port if one somehow arrives, and a trailing dot (a fully qualified
  // name is legal in a Host header and would otherwise miss every comparison).
  var colon = host.indexOf(':');
  if (colon !== -1) host = host.substring(0, colon);
  if (host.length && host.charAt(host.length - 1) === '.') host = host.substring(0, host.length - 1);

  // www redirects to the apex rather than serving the same bytes at two names.
  if (host === 'www.' + APEX) {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { 'location': { value: 'https://' + APEX + uri } }
    };
  }

  // The console is not a tenant. It lives at admin/ in the bucket ROOT, outside
  // sites/, so no site's changeset can reach the tool that fixes a bad publish.
  if (host === CONSOLE + '.' + APEX) {
    if (uri.length === 0 || uri.charAt(uri.length - 1) === '/') uri = uri + 'index.html';
    request.uri = '/admin' + uri;
    return request;
  }

  var siteId;
  if (host === APEX) {
    siteId = MARKETING;
  } else if (host.length > APEX.length + 1 &&
             host.substring(host.length - APEX.length - 1) === '.' + APEX) {
    siteId = host.substring(0, host.length - APEX.length - 1);
  } else {
    // An unrecognised Host is not a request for the default site. Serving one
    // here is how a tenant's content ends up under somebody else's name.
    return notFound();
  }

  if (!validLabel(siteId)) return notFound();

  if (uri === '/__qw/session') return await mintSession(siteId, request);
  if (uri === '/__qw/signout') return redirect('/', '', 0);

  // Directory index. CloudFront resolves DefaultRootObject for "/" and nothing
  // else, so /about/ would ask S3 for a key literally named "about/" and get a
  // 403 -- the bucket policy grants GetObject but not ListBucket.
  var asked = uri;
  if (uri.length === 0 || uri.charAt(uri.length - 1) === '/') uri = uri + 'index.html';

  var need = await requiredLevel(siteId, uri);
  if (need !== 'public') {
    var held = await readerLevel(siteId, request);
    if (held === null) return signIn(siteId, asked, request.method);
    if (!admits(need, held)) return denied(siteId, asked, need);
  }

  request.uri = '/' + PREFIX + siteId + uri;
  return request;
}

// ------------------------------------------------------------------- access

// An entry, or null when there is none. Only "absent" is null: any failure to
// read propagates, and a thrown function is a 503, never an open page.
async function kvGet(key) {
  if (!(await kvs.exists(key))) return null;
  return await kvs.get(key);
}

// Anything that is not a known level reads as the strictest, so a corrupt
// entry locks a page rather than opening it.
function level(v) {
  return LEVELS.indexOf(v) === -1 ? 'admin' : v;
}

function admits(need, held) {
  return LEVELS.indexOf(held) >= LEVELS.indexOf(need);
}

async function requiredLevel(siteId, uri) {
  var site = await kvGet(siteId);
  if (site === null) return 'public';
  var page = await kvGet(siteId + uri);
  return level(page === null ? site : page);
}

async function readerLevel(siteId, request) {
  var c = request.cookies && request.cookies[COOKIE];
  if (!c || !c.value) return null;
  return await verify(c.value, 'v1', siteId, SESSION_SEC);
}

// `<kind>.<site>.<level>.<exp>.<hmac>`, or null if anything about it is wrong.
async function verify(token, kind, siteId, maxSec) {
  var p = String(token).split('.');
  if (p.length !== 5 || p[0] !== kind || p[1] !== siteId) return null;
  if (LEVELS.indexOf(p[2]) === -1) return null;
  var exp = parseInt(p[3], 10);
  var now = Math.floor(Date.now() / 1000);
  if (!(exp > now) || exp > now + maxSec) return null;
  var want = await sign(p.slice(0, 4).join('.'));
  return same(p[4], want) ? p[2] : null;
}

async function sign(body) {
  var secret = await kvGet('_secret');
  if (secret === null) throw new Error('access store has no _secret');
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// Constant time over equal lengths: how much of a guess was right must not
// show in how long the answer took.
function same(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The sign-in page hands back here with a short-lived grant; it becomes a
// host-only session cookie for this site and nowhere else.
async function mintSession(siteId, request) {
  var q = request.querystring || {};
  var g = q.g ? q.g.value : '';
  var lvl = await verify(g, 'g1', siteId, GRANT_MAX_SEC);
  if (lvl === null) return page(403, 'Sign-in link expired', '<p>That sign-in link has expired or is not for this site.</p><p><a href="/">Try again</a></p>');
  var exp = Math.floor(Date.now() / 1000) + SESSION_SEC;
  var body = 'v1.' + siteId + '.' + lvl + '.' + exp;
  var token = body + '.' + (await sign(body));
  return redirect(safeNext(q.next ? q.next.value : '/'), token, SESSION_SEC);
}

// Only a path on this same site: never another host, never protocol-relative.
function safeNext(n) {
  n = String(n || '/');
  if (n.charAt(0) !== '/' || n.charAt(1) === '/' || n.indexOf('\\') !== -1) return '/';
  return n;
}

function signIn(siteId, asked, method) {
  if (method !== 'GET' && method !== 'HEAD') return page(401, 'Sign in required', '<p>Sign in to read this site.</p>');
  return redirect('https://' + CONSOLE + '.' + APEX + '/access.html?site=' + siteId + '&next=' + encodeURIComponent(asked));
}

function denied(siteId, asked, need) {
  var again = 'https://' + CONSOLE + '.' + APEX + '/access.html?site=' + siteId + '&switch=1&next=' + encodeURIComponent(asked);
  return page(403, 'Not available',
    '<p>You are signed in, but this page needs <strong>' + need + '</strong> access.</p>' +
    '<p><a href="' + again + '">Sign in with a different account</a> &middot; <a href="/__qw/signout">Sign out</a></p>');
}

// A cookie is set through `cookies`, which is how a viewer-request function
// writes Set-Cookie; host-only (no Domain), so it reaches this site alone.
function redirect(location, cookieValue, maxAge) {
  var res = {
    statusCode: 302,
    statusDescription: 'Found',
    headers: { 'location': { value: location }, 'cache-control': { value: 'no-store' } }
  };
  if (cookieValue !== undefined) {
    res.cookies = {};
    res.cookies[COOKIE] = { value: cookieValue, attributes: 'Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAge };
  }
  return res;
}

function page(status, title, html) {
  return {
    statusCode: status,
    statusDescription: title,
    headers: {
      'content-type': { value: 'text/html; charset=utf-8' },
      'cache-control': { value: 'no-store' }
    },
    body: '<!doctype html><meta charset=utf-8><meta name=robots content=noindex><title>' + title + '</title>' +
      '<style>body{font:16px/1.6 system-ui,sans-serif;margin:15vh auto;max-width:30rem;padding:0 1.5rem}</style>' +
      '<h1>' + title + '</h1>' + html
  };
}

// ------------------------------------------------------------------ routing

// Must accept exactly what shared/site.mjs accepts: 3-40 chars, lowercase
// alphanumeric and hyphens, no leading or trailing hyphen.
function validLabel(s) {
  if (s.length < 3 || s.length > 40) return false;
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    var ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-';
    if (!ok) return false;
  }
  if (s.charAt(0) === '-' || s.charAt(s.length - 1) === '-') return false;
  return true;
}

function notFound() {
  return {
    statusCode: 404,
    statusDescription: 'Not Found',
    headers: {
      'content-type': { value: 'text/html; charset=utf-8' },
      'cache-control': { value: 'max-age=60' }
    },
    body: '<!doctype html><meta charset=utf-8><title>No site here</title>' +
      '<style>body{font:16px/1.6 system-ui,sans-serif;margin:15vh auto;max-width:28rem;padding:0 1.5rem}</style>' +
      '<h1>No site here.</h1><p>Nothing is published at this address.</p>'
  };
}
