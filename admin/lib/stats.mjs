// Turns CloudFront access logs into daily reports.
//
// Incremental: a metadata object tracks which log files are already folded in,
// so a run costs only the new ones. The report counts visits rather than raw
// hits, and covers bounce rate, channel attribution, named bots with the paths
// they crawled, campaign parameters, city-level geography, and an hour-by-hour
// breakdown.
//
// Two files, on purpose:
//
//   daily.json      one small summary row per day. Read on every page load of
//                   the Stats tab, so it stays cheap no matter how much detail
//                   exists underneath it.
//   days/<date>.json  everything else. Read only when you open a day.
//
// An earlier version put both in daily.json. Thirty days of full detail is a
// few megabytes, and re-reading and re-writing all of it on every processing
// run is the kind of thing that is fine until suddenly it is the whole Lambda
// budget.
//
// Three things worth understanding before reading the numbers:
//
//   Probes are counted separately, not discarded. The first log file this site
//   ever produced was 55 of 56 requests hitting /.env and /.git/HEAD. Folded in,
//   scanners would drown the real traffic and make the Philippines the top
//   country for readership.
//
//   Sessions are reconstructed without a cookie: same client fingerprint, 30
//   minute gap, page requests only. That is where bounce rate and pages-per-
//   visit come from, and it is why a stylesheet is not a page view.
//
//   Audio completion is reconstructed from HTTP range requests: the furthest
//   byte an IP reached against the file size. The only way to know whether
//   anyone listened to the end without putting a tracker in the page.
//
// On addresses: this file used to collapse every IP to a count before writing,
// and said so loudly. That rule was relaxed deliberately. Reports now retain a
// bounded top-N of client and scanner addresses with their geography, the way
// signal's reporter does, because the scanner table is the raw material for
// half of what this publication writes about. Session fingerprints are still
// never written -- those exist only inside a run.

// The AWS SDK is imported lazily inside processLogs rather than here. It only
// exists inside the Lambda bundle, and a top-level import meant this whole file
// could not be loaded by a test on a laptop -- which is why test/stats.test.mjs
// used to re-declare the functions it was checking and assert on the source
// text instead. Everything except processLogs is pure and now directly testable.
import { parseLogBuffer, detectBrowser, detectDevice, detectOS, detectProbePattern, referrerHost } from "./cfparser.mjs";
import {
  parseBotIdentity, isPageRequest, isLegitimateRequest, getRealClientIP,
  parseQueryParams, extractCampaign, classifyChannel, requestCountry,
  getCountryName, sessionize, sessionStats,
} from "./classify.mjs";
import { GeoLookup } from "./mmdb.mjs";

const STATS_PREFIX = "_internal/stats";
const META_KEY = `${STATS_PREFIX}/metadata.json`;
const REPORT_KEY = `${STATS_PREFIX}/daily.json`;
const dayKey = (date) => `${STATS_PREFIX}/days/${date}.json`;

// One run will not process more than this. A backlog could otherwise blow the
// 60s timeout; progress is recorded either way, so running again continues.
const MAX_FILES_PER_RUN = 300;

// Bounded so one loud day cannot grow a detail file without limit.
const PROBE_LOG_CAP = 200;
const IP_TABLE_CAP = 5000;      // distinct addresses tracked during a run
const BOT_PATH_CAP = 200;       // distinct paths remembered per bot

export const topN = (obj, n = 20) =>
  Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([key, count]) => ({ key, count }));

// Takes an ARRAY OF LISTS, not two lists. It was originally binary and callers
// spread N days into it, which put `n` in the `b` slot: a crash on a single day
// and silently dropped days beyond the second once there were more.
export const mergeCounts = (lists, n = 25) => {
  const m = {};
  for (const list of lists) for (const { key, count } of list ?? []) m[key] = (m[key] ?? 0) + count;
  return topN(m, n);
};

/**
 * Merge rows that carry more than a count -- cities, IPs, bots. Rows are keyed
 * by `idKey`; counts add, and the first non-empty value wins for every other
 * field so that a day which learned a city keeps it.
 */
export function mergeRows(lists, idKey, n, opts = {}) {
  const { nested = [] } = opts;
  const m = new Map();
  for (const list of lists) {
    for (const row of list ?? []) {
      const id = row[idKey];
      if (id === undefined || id === null || id === "") continue;
      const prev = m.get(id);
      if (!prev) {
        m.set(id, { ...row, ...Object.fromEntries(nested.map((f) => [f, [row[f] ?? []]])) });
        continue;
      }
      prev.count = (prev.count ?? 0) + (row.count ?? 0);
      for (const [k, v] of Object.entries(row)) {
        if (k === idKey || k === "count" || nested.includes(k)) continue;
        if ((prev[k] === undefined || prev[k] === null || prev[k] === "") && v !== undefined && v !== null && v !== "") {
          prev[k] = v;
        }
      }
      for (const f of nested) prev[f].push(row[f] ?? []);
    }
  }
  const out = [...m.values()].sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).slice(0, n);
  for (const row of out) for (const f of nested) row[f] = mergeCounts(row[f], 25);
  return out;
}

const emptyHour = (hour) => ({ hour, requests: 0, pageViews: 0, hits: 0, misses: 0, errors: 0, bots: 0, probes: 0 });

function emptyDay(date) {
  return {
    date,
    requests: 0, bandwidth: 0, errors: 0, bots: 0, probes: 0, internal: 0,
    hits: 0, misses: 0,
    _uniqueIps: new Set(),
    _events: new Map(),       // fingerprint -> page events, for sessionization
    _audioSessions: {},
    hourly: Array.from({ length: 24 }, (_, h) => emptyHour(h)),
    browsers: {}, devices: {}, deviceCategories: {}, os: {}, countries: {},
    pages: {}, assets: {}, audio: {}, referrers: {}, referrerUrls: {}, statuses: {},
    hosts: {}, edgeLocations: {},
    botNames: {}, botCategories: {},
    scannerCountries: {}, probePatterns: {},
    error404Paths: {}, error403Paths: {},
    utmSources: {}, utmMediums: {}, utmCampaigns: {}, utmTerms: {}, utmContent: {},
    sourceMediums: {}, queryKeys: {}, clickIds: {},
    _cities: new Map(), _regions: new Map(),
    _scannerCities: new Map(), _scannerRegions: new Map(),
    _clientIps: new Map(), _scannerIps: new Map(),
    _bots: new Map(),
    _probeLog: [],
    _preciseGeo: 0, _coarseGeo: 0, _geoResolved: 0,
  };
}

const bump = (obj, key) => { if (key) obj[key] = (obj[key] ?? 0) + 1; };

function accumulateCity(map, loc) {
  if (!loc.city) return;
  const key = `${loc.city}|${loc.region}|${loc.country}`;
  const prev = map.get(key);
  if (prev) { prev.count++; return; }
  if (map.size >= IP_TABLE_CAP) return;
  map.set(key, {
    key, city: loc.city, region: loc.region, country: loc.country,
    countryName: getCountryName(loc.country), lat: loc.lat, lng: loc.lng, count: 1,
  });
}

// Regions average the coordinates of the addresses seen in them, so a region
// row can be dropped on a map without pretending to be a city.
function accumulateRegion(map, loc) {
  if (!loc.region) return;
  const key = `${loc.region}|${loc.country}`;
  const hasLL = loc.lat !== null && loc.lng !== null;
  const prev = map.get(key);
  if (prev) {
    prev.count++;
    if (hasLL) { prev._latSum += loc.lat; prev._lngSum += loc.lng; prev._llCount++; }
    return;
  }
  if (map.size >= IP_TABLE_CAP) return;
  map.set(key, {
    key, region: loc.region, country: loc.country, countryName: getCountryName(loc.country),
    count: 1, _latSum: hasLL ? loc.lat : 0, _lngSum: hasLL ? loc.lng : 0, _llCount: hasLL ? 1 : 0,
  });
}

function accumulateIp(map, ip, loc) {
  if (!ip) return;
  const prev = map.get(ip);
  if (prev) { prev.count++; return; }
  if (map.size >= IP_TABLE_CAP) return;
  map.set(ip, {
    ip, count: 1, country: loc.country, countryName: getCountryName(loc.country),
    city: loc.city, region: loc.region,
  });
}

function accumulateBot(map, bot, uri, ua) {
  let b = map.get(bot.name);
  if (!b) {
    if (map.size >= IP_TABLE_CAP) return;
    b = { name: bot.name, category: bot.category, known: bot.known, count: 0, paths: {}, sampleUA: bot.known ? "" : (ua ?? "").slice(0, 200) };
    map.set(bot.name, b);
  }
  b.count++;
  if (uri && (b.paths[uri] !== undefined || Object.keys(b.paths).length < BOT_PATH_CAP)) {
    b.paths[uri] = (b.paths[uri] ?? 0) + 1;
  }
}

function foldAcquisition(day, params, campaign) {
  // params is a Map, not an object. Object.keys() on it returns [] without
  // complaining, so every query parameter table silently came back empty.
  for (const k of params.keys()) bump(day.queryKeys, k);
  if (!campaign) return;
  bump(day.utmSources, campaign.source);
  bump(day.utmMediums, campaign.medium);
  bump(day.utmCampaigns, campaign.name);
  bump(day.utmTerms, campaign.term);
  bump(day.utmContent, campaign.content);
  if (campaign.source || campaign.medium) {
    bump(day.sourceMediums, `${campaign.source || "(none)"} / ${campaign.medium || "(none)"}`);
  }
  if (campaign.clickId) bump(day.clickIds, `${campaign.clickId.param} (${campaign.clickId.network})`);
}

function fold(day, e, ownHost, geo) {
  day.requests++;
  day.bandwidth += e["sc-bytes"];

  const hourNum = Number(String(e.time ?? "").slice(0, 2));
  const hour = day.hourly[Number.isFinite(hourNum) && hourNum >= 0 && hourNum < 24 ? hourNum : 0];
  hour.requests++;

  const ip = getRealClientIP(e["c-ip"], e["x-forwarded-for"]);
  if (ip) day._uniqueIps.add(ip);

  // Cache outcome. RefreshHit served from the edge too; only a real trip to the
  // origin is a miss, which for this site means S3 was actually read.
  const rt = String(e["x-edge-result-type"] ?? "");
  if (rt === "Hit" || rt === "RefreshHit") { day.hits++; hour.hits++; }
  else if (rt === "Miss" || rt === "LimitExceeded" || rt === "CapacityExceeded") { day.misses++; hour.misses++; }

  bump(day.edgeLocations, e["x-edge-location"]);
  bump(day.hosts, e["cs-host"]);

  const status = e["sc-status"];
  bump(day.statuses, String(status));
  if (status >= 400) { day.errors++; hour.errors++; }

  const ua = e["cs-user-agent"];
  const uri = e["cs-uri-stem"] ?? "";
  if (status === 404) bump(day.error404Paths, uri);
  if (status === 403) bump(day.error403Paths, uri);

  const country = requestCountry(e);
  const loc = geo.available && ip
    ? { ...geo.lookup(ip), country: country.precise ? country.code : (geo.lookup(ip).country || country.code) }
    : { country: country.code, countryName: getCountryName(country.code), city: "", region: "", lat: null, lng: null };
  if (loc.city) day._geoResolved++;

  // The admin plane is not the publication, and it is checked before anything
  // else. Editing an article should not read as 23 people visiting, and
  // /api/articles is not a page view -- it only looked like one because
  // isPageRequest treats extensionless paths as pages, which is right for
  // an extensionless page URL and wrong for /api/health.
  //
  // This used to sit *below* the probe check, which produced a genuinely funny
  // result: saving an article whose slug contained the word "wordpress" logged
  // the author as a scanner from Oregon.
  if (uri === "/admin" || uri.startsWith("/admin/") || uri.startsWith("/api/")) {
    day.internal++;
    return;
  }

  // Probes are their own world: they never touch the real-traffic tables.
  //
  // A request the origin actually served is never a probe, whatever the path
  // looks like. Behind CloudFront and an Origin Access Control, a 200 means the
  // key exists in our own bucket, which means we put it there.
  //
  // That guard has to sit here rather than inside the pattern check, because
  // isLegitimateRequest consults detectProbePattern itself: an article at
  // /2026-09-04-every-scanner-assumes-you-run-wordpress.html is a .html file in
  // the site root and still comes back illegitimate, purely for what it is
  // called. A publication about wp-config and .env files will keep tripping
  // every pattern in the list; the status code is the thing that cannot lie.
  const served = status === 200 || status === 206 || status === 304;
  const patternHit = detectProbePattern(uri);
  if (!served && (patternHit || !isLegitimateRequest(uri))) {
    const pattern = patternHit ?? "other";
    day.probes++;
    hour.probes++;
    bump(day.probePatterns, pattern);
    bump(day.scannerCountries, loc.country);
    accumulateRegion(day._scannerRegions, loc);
    accumulateCity(day._scannerCities, loc);
    accumulateIp(day._scannerIps, ip, loc);
    // A rolling tail of individual attempts. This is the table an article
    // quotes: the actual paths, in order, with the address that asked.
    day._probeLog.push({
      t: e.timestamp ?? "", ip: ip ?? "", path: uri.slice(0, 200), status,
      pattern, country: loc.country, city: loc.city,
    });
    if (day._probeLog.length > PROBE_LOG_CAP * 2) day._probeLog = day._probeLog.slice(-PROBE_LOG_CAP);
    return;
  }

  const bot = parseBotIdentity(ua);
  if (bot) {
    day.bots++;
    hour.bots++;
    bump(day.botNames, bot.name);
    bump(day.botCategories, bot.category);
    accumulateBot(day._bots, bot, uri, ua);
    // Bots still count as requests and bandwidth (they cost money), but they
    // are not visitors and must not reach the browser/session tables.
    return;
  }

  if (country.precise) day._preciseGeo++; else day._coarseGeo++;
  bump(day.countries, loc.country);
  accumulateRegion(day._regions, loc);
  accumulateCity(day._cities, loc);
  accumulateIp(day._clientIps, ip, loc);

  bump(day.browsers, detectBrowser(ua));
  const device = detectDevice(ua);
  bump(day.devices, device);
  bump(day.deviceCategories, `${device} / ${detectOS(ua)}`);
  bump(day.os, detectOS(ua));

  const rawRef = e["cs-referer"];
  const ref = referrerHost(rawRef);
  const external = ref && ref !== ownHost && !ref.endsWith(`.${ownHost}`) ? ref : null;
  if (external) {
    bump(day.referrers, external);
    if (rawRef) bump(day.referrerUrls, String(rawRef).slice(0, 300));
  }

  const params = parseQueryParams(e["cs-uri-query"]);
  const campaign = extractCampaign(params);
  foldAcquisition(day, params, campaign);

  if (status !== 200 && status !== 206 && status !== 304) return;

  if (isPageRequest(uri)) {
    day.pages[uri] = (day.pages[uri] ?? 0) + 1;
    hour.pageViews++;
    // Collect for sessionization. Fingerprint is IP + UA: no cookie, and it
    // never leaves this function -- sealDay collapses it to counts.
    const fp = `${ip}|${ua}`;
    const list = day._events.get(fp) ?? [];
    list.push({
      ts: e.ts, path: uri, referrer: external,
      channel: classifyChannel(campaign, external),
      campaign: campaign?.name ?? null,
    });
    day._events.set(fp, list);
  } else if (/\.(mp3|m4a|wav|ogg|opus|webm)$/i.test(uri)) {
    day.audio[uri] = (day.audio[uri] ?? 0) + 1;
    if (ip) {
      const key = `${ip}|${uri}`;
      const s = (day._audioSessions[key] ??= { file: uri, ip, maxByte: 0, fileSize: 0, requests: 0 });
      s.requests++;
      const rangeEnd = e["sc-range-end"];
      if (rangeEnd > s.maxByte) s.maxByte = rangeEnd;
      const len = e["sc-content-len"];
      if (status === 200 && len > s.fileSize) s.fileSize = len;
      if (rangeEnd > s.fileSize) s.fileSize = Math.max(s.fileSize, rangeEnd);
    }
  } else {
    day.assets[uri] = (day.assets[uri] ?? 0) + 1;
  }
}

/** Completion per audio file, from reconstructed range-request sessions.
 *  A play is over 10% of the file; finished is 90% or more. */
export function audioListenStats(sessions) {
  const byFile = {};
  for (const s of sessions) {
    const f = (byFile[s.file] ??= { file: s.file, plays: 0, completes: 0, listeners: new Set(), pcts: [] });
    f.listeners.add(s.ip);
    let pct = 0;
    if (s.fileSize > 0 && s.maxByte > 0) pct = Math.min(100, (s.maxByte / s.fileSize) * 100);
    else if (s.requests > 0) pct = Math.min(100, s.requests * 5); // no content-length seen
    if (pct > 10) {
      f.plays++;
      f.pcts.push(pct);
      if (pct >= 90) f.completes++;
    }
  }
  return Object.values(byFile).map((f) => ({
    file: f.file, plays: f.plays, completes: f.completes,
    uniqueListeners: f.listeners.size,
    completionRate: f.plays ? Math.round((f.completes / f.plays) * 100) : 0,
    avgCompletion: f.pcts.length ? Math.round(f.pcts.reduce((a, b) => a + b, 0) / f.pcts.length) : 0,
  })).filter((f) => f.plays > 0).sort((a, b) => b.plays - a.plays).slice(0, 30);
}

const cityRows = (map, n) => [...map.values()].sort((a, b) => b.count - a.count).slice(0, n);
const regionRows = (map, n) => [...map.values()].sort((a, b) => b.count - a.count).slice(0, n)
  .map(({ _latSum, _lngSum, _llCount, ...r }) => ({
    ...r,
    lat: _llCount ? +(_latSum / _llCount).toFixed(4) : null,
    lng: _llCount ? +(_lngSum / _llCount).toFixed(4) : null,
  }));

function botRows(map, known, n) {
  return [...map.values()].filter((b) => b.known === known)
    .sort((a, b) => b.count - a.count).slice(0, n)
    .map((b) => ({
      key: b.name, name: b.name, category: b.category, count: b.count,
      objectsCrawled: Object.keys(b.paths).length,
      topPaths: topN(b.paths, 25),
      ...(known ? {} : { sampleUA: b.sampleUA }),
    }));
}

/**
 * Collapse a working day into what gets stored.
 *
 * Returns two objects. `summary` goes in daily.json and is what the rolled-up
 * window reads. `detail` is the drill-down, written per date.
 */
function sealDay(day) {
  const sessions = sessionize(day._events);
  const stats = sessions.map(sessionStats);
  const bounced = stats.filter((s) => s.bounced).length;
  const totalPageViews = stats.reduce((n, s) => n + s.pageViews, 0);
  const totalDuration = stats.reduce((n, s) => n + s.durationSec, 0);

  const channels = {}, entryPages = {}, exitPages = {}, landings = {}, campaignVisits = {};
  const channelDetail = {};
  for (const s of sessions) {
    const st = sessionStats(s);
    bump(channels, s.channel);
    bump(entryPages, s.entry);
    bump(exitPages, s.exit);
    bump(landings, `${s.channel} -> ${s.entry}`);
    if (s.campaign) bump(campaignVisits, s.campaign);
    const c = (channelDetail[s.channel] ??= { key: s.channel, count: 0, bounces: 0, pageViews: 0, seconds: 0 });
    c.count++;
    if (st.bounced) c.bounces++;
    c.pageViews += st.pageViews;
    c.seconds += st.durationSec;
  }

  const summary = {
    date: day.date,
    requests: day.requests,
    internal: day.internal,
    bandwidth: day.bandwidth,
    errors: day.errors,
    bots: day.bots,
    probes: day.probes,
    hits: day.hits,
    misses: day.misses,
    uniqueVisitors: day._uniqueIps.size,
    pageViews: totalPageViews,
    sessions: sessions.length,
    bouncedSessions: bounced,
    sessionSeconds: totalDuration,
    geoPrecise: day._preciseGeo,
    geoCoarse: day._coarseGeo,
    geoResolved: day._geoResolved,
    channels: topN(channels, 12),
    entryPages: topN(entryPages, 15),
    exitPages: topN(exitPages, 15),
    browsers: topN(day.browsers, 10),
    devices: topN(day.devices, 6),
    os: topN(day.os, 8),
    countries: topN(day.countries, 20),
    pages: topN(day.pages, 25),
    assets: topN(day.assets, 15),
    audio: topN(day.audio, 15),
    referrers: topN(day.referrers, 20),
    statuses: topN(day.statuses, 10),
    botNames: topN(day.botNames, 20),
    botCategories: topN(day.botCategories, 8),
    scannerCountries: topN(day.scannerCountries, 10),
    probePatterns: topN(day.probePatterns, 10),
    audioListens: audioListenStats(Object.values(day._audioSessions)),
  };

  const cacheable = day.hits + day.misses;
  const detail = {
    date: day.date,
    generatedAt: new Date().toISOString(),
    summary: {
      ...Object.fromEntries(Object.entries(summary).filter(([, v]) => !Array.isArray(v))),
      cacheHitRate: cacheable ? +((day.hits / cacheable) * 100).toFixed(1) : null,
    },
    hourly: day.hourly,
    content: {
      pages: topN(day.pages, 50),
      assets: topN(day.assets, 30),
      audio: topN(day.audio, 20),
      hosts: topN(day.hosts, 20),
      statuses: topN(day.statuses, 20),
      edgeLocations: topN(day.edgeLocations, 25),
    },
    audience: {
      browsers: topN(day.browsers, 20),
      devices: topN(day.devices, 10),
      deviceCategories: topN(day.deviceCategories, 20),
      os: topN(day.os, 15),
    },
    geo: {
      countries: topN(day.countries, 30).map((r) => ({ ...r, label: getCountryName(r.key) })),
      regions: regionRows(day._regions, 60),
      cities: cityRows(day._cities, 60),
      scannerCountries: topN(day.scannerCountries, 30).map((r) => ({ ...r, label: getCountryName(r.key) })),
      scannerRegions: regionRows(day._scannerRegions, 60),
      scannerCities: cityRows(day._scannerCities, 60),
    },
    ips: {
      clients: [...day._clientIps.values()].sort((a, b) => b.count - a.count).slice(0, 30),
      scanners: [...day._scannerIps.values()].sort((a, b) => b.count - a.count).slice(0, 30),
    },
    bots: {
      known: botRows(day._bots, true, 50),
      unknown: botRows(day._bots, false, 30),
      categories: topN(day.botCategories, 15),
    },
    acquisition: {
      channels: Object.values(channelDetail).sort((a, b) => b.count - a.count),
      campaigns: topN(day.utmCampaigns, 25),
      campaignVisits: topN(campaignVisits, 25),
      sources: topN(day.utmSources, 25),
      mediums: topN(day.utmMediums, 25),
      sourceMediums: topN(day.sourceMediums, 25),
      terms: topN(day.utmTerms, 25),
      content: topN(day.utmContent, 25),
      clickIds: topN(day.clickIds, 15),
      queryKeys: topN(day.queryKeys, 25),
      referrers: topN(day.referrers, 30),
      referrerUrls: topN(day.referrerUrls, 30),
      landings: topN(landings, 25),
    },
    visits: {
      entryPages: topN(entryPages, 25),
      exitPages: topN(exitPages, 25),
    },
    security: {
      probePatterns: topN(day.probePatterns, 25),
      probePaths: topN(
        day._probeLog.reduce((acc, p) => { acc[p.path] = (acc[p.path] ?? 0) + 1; return acc; }, {}), 40),
      probeLog: day._probeLog.slice(-PROBE_LOG_CAP).reverse(),
      top404Paths: topN(day.error404Paths, 30),
      top403Paths: topN(day.error403Paths, 30),
    },
    audioListens: summary.audioListens,
  };

  return { summary, detail };
}

/**
 * Fold a list of parsed log entries into one day and seal it. The whole
 * accumulator without any S3, which is what makes the pipeline testable.
 */
export function buildDay(date, entries, ownHost, geo = GeoLookup.none()) {
  const day = emptyDay(date);
  for (const e of entries) fold(day, e, ownHost, geo);
  return sealDay(day);
}

function mergeAudioListens(lists) {
  const m = {};
  for (const s of lists.flatMap((l) => l ?? [])) {
    const f = (m[s.file] ??= { file: s.file, plays: 0, completes: 0, uniqueListeners: 0, _w: 0, _sum: 0 });
    f.plays += s.plays;
    f.completes += s.completes;
    f.uniqueListeners += s.uniqueListeners;
    f._sum += (s.avgCompletion ?? 0) * s.plays;
    f._w += s.plays;
  }
  return Object.values(m).map((f) => ({
    file: f.file, plays: f.plays, completes: f.completes,
    uniqueListeners: f.uniqueListeners,
    completionRate: f.plays ? Math.round((f.completes / f.plays) * 100) : 0,
    avgCompletion: f._w ? Math.round(f._sum / f._w) : 0,
  })).sort((a, b) => b.plays - a.plays).slice(0, 30);
}

const SUM_FIELDS = ["requests", "internal", "bandwidth", "errors", "bots", "probes", "pageViews",
  "sessions", "bouncedSessions", "sessionSeconds", "geoPrecise", "geoCoarse", "geoResolved",
  "uniqueVisitors", "hits", "misses"];
const LIST_FIELDS = {
  channels: 12, entryPages: 15, exitPages: 15, browsers: 10, devices: 6, os: 8,
  countries: 20, pages: 25, assets: 15, audio: 15, referrers: 20, statuses: 10,
  botNames: 20, botCategories: 8, scannerCountries: 10, probePatterns: 10,
};

function mergeDay(a, b) {
  const out = { date: a.date };
  // uniqueVisitors is additive because the IP sets are gone by now. It
  // overstates when the same reader spans two processing runs; the alternative
  // is keeping every address forever, which the top-N table does not do.
  for (const f of SUM_FIELDS) out[f] = (a[f] ?? 0) + (b[f] ?? 0);
  for (const [f, n] of Object.entries(LIST_FIELDS)) out[f] = mergeCounts([a[f], b[f]], n);
  out.audioListens = mergeAudioListens([a.audioListens, b.audioListens]);
  return out;
}

/** Merge two detail objects for the same date. Shapes must match sealDay's. */
export function mergeDetail(a, b) {
  if (!a) return b;
  const pair = (sel) => [sel(a), sel(b)];
  const sumHours = () => Array.from({ length: 24 }, (_, h) => {
    const x = a.hourly?.[h] ?? emptyHour(h);
    const y = b.hourly?.[h] ?? emptyHour(h);
    const o = emptyHour(h);
    for (const k of Object.keys(o)) if (k !== "hour") o[k] = (x[k] ?? 0) + (y[k] ?? 0);
    return o;
  });

  const sumSummary = {};
  for (const k of new Set([...Object.keys(a.summary ?? {}), ...Object.keys(b.summary ?? {})])) {
    if (k === "date") { sumSummary[k] = b.summary?.[k] ?? a.summary?.[k]; continue; }
    if (k === "cacheHitRate") continue;
    const x = a.summary?.[k], y = b.summary?.[k];
    sumSummary[k] = typeof x === "number" || typeof y === "number" ? (x ?? 0) + (y ?? 0) : (y ?? x);
  }
  const cacheable = (sumSummary.hits ?? 0) + (sumSummary.misses ?? 0);
  sumSummary.cacheHitRate = cacheable ? +(((sumSummary.hits ?? 0) / cacheable) * 100).toFixed(1) : null;

  const c = (sel, n) => mergeCounts(pair(sel), n);
  const labelled = (sel, n) => c(sel, n).map((r) => ({ ...r, label: getCountryName(r.key) }));

  return {
    date: b.date ?? a.date,
    generatedAt: new Date().toISOString(),
    summary: sumSummary,
    hourly: sumHours(),
    content: {
      pages: c((d) => d.content?.pages, 50),
      assets: c((d) => d.content?.assets, 30),
      audio: c((d) => d.content?.audio, 20),
      hosts: c((d) => d.content?.hosts, 20),
      statuses: c((d) => d.content?.statuses, 20),
      edgeLocations: c((d) => d.content?.edgeLocations, 25),
    },
    audience: {
      browsers: c((d) => d.audience?.browsers, 20),
      devices: c((d) => d.audience?.devices, 10),
      deviceCategories: c((d) => d.audience?.deviceCategories, 20),
      os: c((d) => d.audience?.os, 15),
    },
    geo: {
      countries: labelled((d) => d.geo?.countries, 30),
      regions: mergeRows(pair((d) => d.geo?.regions), "key", 60),
      cities: mergeRows(pair((d) => d.geo?.cities), "key", 60),
      scannerCountries: labelled((d) => d.geo?.scannerCountries, 30),
      scannerRegions: mergeRows(pair((d) => d.geo?.scannerRegions), "key", 60),
      scannerCities: mergeRows(pair((d) => d.geo?.scannerCities), "key", 60),
    },
    ips: {
      clients: mergeRows(pair((d) => d.ips?.clients), "ip", 30),
      scanners: mergeRows(pair((d) => d.ips?.scanners), "ip", 30),
    },
    bots: {
      known: mergeRows(pair((d) => d.bots?.known), "key", 50, { nested: ["topPaths"] }),
      unknown: mergeRows(pair((d) => d.bots?.unknown), "key", 30, { nested: ["topPaths"] }),
      categories: c((d) => d.bots?.categories, 15),
    },
    acquisition: {
      channels: mergeRows(pair((d) => d.acquisition?.channels), "key", 12),
      campaigns: c((d) => d.acquisition?.campaigns, 25),
      campaignVisits: c((d) => d.acquisition?.campaignVisits, 25),
      sources: c((d) => d.acquisition?.sources, 25),
      mediums: c((d) => d.acquisition?.mediums, 25),
      sourceMediums: c((d) => d.acquisition?.sourceMediums, 25),
      terms: c((d) => d.acquisition?.terms, 25),
      content: c((d) => d.acquisition?.content, 25),
      clickIds: c((d) => d.acquisition?.clickIds, 15),
      queryKeys: c((d) => d.acquisition?.queryKeys, 25),
      referrers: c((d) => d.acquisition?.referrers, 30),
      referrerUrls: c((d) => d.acquisition?.referrerUrls, 30),
      landings: c((d) => d.acquisition?.landings, 25),
    },
    visits: {
      entryPages: c((d) => d.visits?.entryPages, 25),
      exitPages: c((d) => d.visits?.exitPages, 25),
    },
    security: {
      probePatterns: c((d) => d.security?.probePatterns, 25),
      probePaths: c((d) => d.security?.probePaths, 40),
      probeLog: [...(b.security?.probeLog ?? []), ...(a.security?.probeLog ?? [])].slice(0, PROBE_LOG_CAP),
      top404Paths: c((d) => d.security?.top404Paths, 30),
      top403Paths: c((d) => d.security?.top403Paths, 30),
    },
    audioListens: mergeAudioListens(pair((d) => d.audioListens)),
  };
}

/**
 * Load the geo database from object storage into memory, once per container.
 *
 * It lives in the staging bucket rather than the deployment package: 127MB
 * unpacked would triple the Lambda upload for a file that changes monthly and
 * that no other code path needs. Absent, everything still works and geography
 * degrades to CloudFront's country code -- which is what `available` reports so
 * the UI can say so instead of quietly showing an empty map.
 */
let geoPromise = null;
export function loadGeo(store, key = "_internal/geo/dbip-city-lite.mmdb.gz") {
  if (!geoPromise) {
    geoPromise = (async () => {
      const { gunzipSync } = await import("node:zlib");
      const { MMDBReader } = await import("./mmdb.mjs");
      // Absent is a legitimate state and getBuffer says so with null. A file
      // that is present but unreadable is not: that throws, because a stats run
      // that silently drops to country-only geography would look identical to
      // one that never had a database, and you would never go looking.
      const buf = await store.getBuffer(key);
      if (!buf) return GeoLookup.none();
      const raw = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
      return new GeoLookup(new MMDBReader(raw));
    })();
  }
  return geoPromise;
}

/**
 * Fold new log objects into the stored daily report.
 * Returns { processed, skipped, days, truncated, geo }.
 */
export async function processLogs({ s3, logBucket, store, ownHost, maxFiles = MAX_FILES_PER_RUN, force = false }) {
  const { GetObjectCommand, ListObjectsV2Command } = await import("@aws-sdk/client-s3");

  const meta = await store.getJson(META_KEY, { processed: [], lastRun: null });
  // force re-reads every log object still in the bucket and rebuilds the report
  // from nothing. Needed whenever this file learns a new dimension: days that
  // were already folded in would otherwise keep their old, thinner shape
  // forever, because their log files are marked done.
  const done = force ? new Set() : new Set(meta.processed);

  const objects = [];
  let token;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: logBucket, ContinuationToken: token }));
    for (const o of res.Contents ?? []) if (o.Size > 0 && !done.has(o.Key)) objects.push(o.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  objects.sort();
  const truncated = objects.length > maxFiles;
  const batch = objects.slice(0, maxFiles);

  const geo = batch.length ? await loadGeo(store) : GeoLookup.none();
  const stored = force ? { days: {} } : await store.getJson(REPORT_KEY, { days: {} });
  const working = {};

  for (const key of batch) {
    const res = await s3.send(new GetObjectCommand({ Bucket: logBucket, Key: key }));
    const chunks = [];
    for await (const c of res.Body) chunks.push(c);
    for (const e of await parseLogBuffer(Buffer.concat(chunks))) {
      if (!e.date) continue;
      fold((working[e.date] ??= emptyDay(e.date)), e, ownHost, geo);
    }
    done.add(key);
  }

  const days = { ...stored.days };
  for (const [date, day] of Object.entries(working)) {
    const { summary, detail } = sealDay(day);
    days[date] = days[date] ? mergeDay(days[date], summary) : summary;
    const prior = force ? null : await store.getJson(dayKey(date), null);
    await store.putJson(dayKey(date), mergeDetail(prior, detail));
  }

  await store.putJson(REPORT_KEY, { days, updatedAt: new Date().toISOString() });
  await store.putJson(META_KEY, {
    processed: [...done].slice(-5000), // bounded; old keys expire from the bucket
    lastRun: new Date().toISOString(),
  });

  return {
    processed: batch.length, skipped: objects.length - batch.length,
    days: Object.keys(working).length, truncated, geo: geo.available,
  };
}

/** Read the stored report, narrowed to the last N days. */
export async function readReport(store, days = 30) {
  const stored = await store.getJson(REPORT_KEY, { days: {} });
  const meta = await store.getJson(META_KEY, { lastRun: null });
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const list = Object.values(stored.days).filter((d) => d.date >= cutoff)
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const totals = {};
  for (const f of SUM_FIELDS) totals[f] = list.reduce((n, d) => n + (d[f] ?? 0), 0);

  const roll = (field, n) => mergeCounts(list.map((d) => d[field] ?? []), n);
  const named = (rows) => rows.map((r) => ({ ...r, label: getCountryName(r.key) }));
  const cacheable = totals.hits + totals.misses;

  return {
    lastRun: meta.lastRun,
    windowDays: days,
    dates: list.map((d) => d.date),
    totals: {
      ...totals,
      bounceRate: totals.sessions ? Math.round((totals.bouncedSessions / totals.sessions) * 100) : 0,
      pagesPerSession: totals.sessions ? Number((totals.pageViews / totals.sessions).toFixed(1)) : 0,
      avgSessionSec: totals.sessions ? Math.round(totals.sessionSeconds / totals.sessions) : 0,
      cacheHitRate: cacheable ? Math.round((totals.hits / cacheable) * 100) : null,
    },
    // Says plainly whether countries came from CloudFront or from an edge guess.
    geoQuality: {
      precise: totals.geoPrecise,
      coarse: totals.geoCoarse,
      resolved: totals.geoResolved,
      note: totals.geoResolved
        ? "Cities and regions resolved from DB-IP City Lite; countries from CloudFront."
        : totals.geoCoarse
          ? "Some rows predate c-country and fall back to the nearest CDN edge."
          : "From CloudFront c-country. No city database loaded.",
    },
    daily: list.map((d) => ({
      date: d.date, requests: d.requests, pageViews: d.pageViews ?? 0,
      sessions: d.sessions ?? 0, uniqueVisitors: d.uniqueVisitors,
      bandwidth: d.bandwidth, errors: d.errors, bots: d.bots, probes: d.probes,
    })),
    channels: roll("channels", 12),
    pages: roll("pages", 25),
    entryPages: roll("entryPages", 15),
    exitPages: roll("exitPages", 15),
    referrers: roll("referrers", 20),
    countries: named(roll("countries", 20)),
    browsers: roll("browsers", 10),
    devices: roll("devices", 6),
    os: roll("os", 8),
    statuses: roll("statuses", 10),
    botNames: roll("botNames", 20),
    botCategories: roll("botCategories", 8),
    probePatterns: roll("probePatterns", 10),
    scannerCountries: named(roll("scannerCountries", 10)),
    audioListens: mergeAudioListens(list.map((d) => d.audioListens ?? [])),
  };
}

/** Full detail for one date, or null when that day was never processed. */
export async function readDay(store, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) return null;
  return store.getJson(dayKey(date), null);
}

/**
 * Roll several days of detail into one object with the same shape, so the tabs
 * can show a window rather than forcing a date choice.
 */
export async function readDetailWindow(store, dates) {
  let acc = null;
  for (const date of dates) {
    const d = await readDay(store, date);
    if (d) acc = mergeDetail(acc, d);
  }
  return acc;
}
