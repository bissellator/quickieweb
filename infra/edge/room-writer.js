// CloudFront Function, viewer request, on the /__qw/room-post/* behavior.
//
// How a game on a site (Vamp Town) finds the other players in a room. A
// player's browser PUTs small JSON files to its own site:
//
//   PUT /__qw/room-post/<room>/here/<stamp>-<uid>-<session>.json        "I'm here"
//   PUT /__qw/room-post/<room>/sig/<to-uid>/<stamp>-<uid>-<session>.json an offer/answer
//   x-qw-ticket: t1.<site>.<exp>.<uid>.<role>.<c|p>.<name>.<hmac>
//
// and reads them back through the tenant router (/__qw/rooms/*). The players
// then connect browser to browser (WebRTC); nothing else goes through here.
//
// The ticket is the COMMENT ticket (shared/comment-ticket.mjs), same secret,
// same checks as infra/edge/comment-writer.js. This function refuses the PUT
// unless:
//
//   - the ticket is ours, unexpired, and for the site on this host
//   - the uid in the file name is the ticket's uid (for sig/, the SENDER's)
//   - the room and recipient are plain slugs, the name's time is near now
//   - the declared size is within the limit
//
// Then it replaces every header S3 acts on and writes with If-None-Match: *,
// so a file is never overwritten. Files live OUTSIDE sites/, at
// _rooms/<site>/<room>/..., so one lifecycle rule on _rooms/ expires them all
// (infra/wire-rooms.mjs); a room is only ever minutes of state.
//
// The bucket policy only lets this distribution PutObject under _rooms/, and
// only with If-None-Match present.
//
// Runtime: cloudfront-js-2.0, deployed with full-line comments stripped.

import cf from 'cloudfront';
import crypto from 'crypto';

var APEX = '__APEX__';
var MARKETING = 'www';
var TICKET_MAX_SEC = 3600;
var MAX_BYTES = 16384;
var SKEW_SEC = 600;
var ROLES = ['owner', 'admin', 'editor', 'viewer', 'none'];
var ROOM_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
var UID_RE = /^[a-z0-9]{8,32}$/;
var NAME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-([a-z0-9]{8,32})-([a-z0-9]{6,16})\.json$/;
var kvs = cf.kvs();

async function handler(event) {
  var request = event.request;
  if (request.method !== 'PUT') return refuse(405, 'Room files are written with PUT');

  var siteId = siteFor(request.headers.host ? request.headers.host.value : '');
  if (siteId === null) return refuse(404, 'No site here');

  if (request.uri.substring(0, 16) !== '/__qw/room-post/') return refuse(404, 'Not a room');
  var p = request.uri.substring(16).split('/');
  var room = p[0];
  if (!room || room.length > 40 || !ROOM_RE.test(room)) return refuse(404, 'Not a room');
  var path, name;
  if (p.length === 3 && p[1] === 'here') {
    path = 'here/';
    name = p[2];
  } else if (p.length === 4 && p[1] === 'sig' && UID_RE.test(p[2])) {
    path = 'sig/' + p[2] + '/';
    name = p[3];
  } else {
    return refuse(404, 'Not a room folder');
  }
  var m = NAME_RE.exec(name);
  if (!m) return refuse(400, 'Not a room file name');

  var h = request.headers['x-qw-ticket'];
  var t = await ticket(h ? h.value : '', siteId);
  if (t === null) return refuse(403, 'The ticket is missing, expired or not for this site');
  if (m[8] !== t.uid) return refuse(403, 'A room file can only be written under its writer\'s own uid');

  var at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
  if (Math.abs(at - Date.now()) > SKEW_SEC * 1000) return refuse(400, 'The file\'s time is too far from now');

  var len = request.headers['content-length'] ? parseInt(request.headers['content-length'].value, 10) : NaN;
  if (!(len >= 1 && len <= MAX_BYTES)) return refuse(413, 'A room file is 1 to ' + MAX_BYTES + ' bytes');

  var keep = { 'host': 1, 'content-length': 1 };
  for (var k in request.headers) {
    if (!keep[k]) delete request.headers[k];
  }
  request.headers['content-type'] = { value: 'application/json' };
  request.headers['cache-control'] = { value: 'no-store' };
  request.headers['if-none-match'] = { value: '*' };
  request.headers['x-amz-meta-uid'] = { value: t.uid };
  request.cookies = {};
  request.querystring = {};
  request.uri = '/_rooms/' + siteId + '/' + room + '/' + path + name;
  return request;
}

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

async function ticket(token, siteId) {
  var p = String(token).split('.');
  if (p.length !== 8 || p[0] !== 't1' || p[1] !== siteId) return null;
  var exp = parseInt(p[2], 10);
  var now = Math.floor(Date.now() / 1000);
  if (!(exp > now) || exp > now + TICKET_MAX_SEC) return null;
  if (!UID_RE.test(p[3]) || ROLES.indexOf(p[4]) === -1 || (p[5] !== 'c' && p[5] !== 'p')) return null;
  if (!/^[A-Za-z0-9%_~!*'()-]{1,1000}$/.test(p[6])) return null;
  var secret = await kvGet('_secret');
  if (secret === null) throw new Error('access store has no _secret');
  var want = crypto.createHmac('sha256', secret).update(p.slice(0, 7).join('.')).digest('hex');
  if (!same(p[7], want)) return null;
  return { uid: p[3] };
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
