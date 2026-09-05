// CloudFront access log parser.
//
// Reads both delivery formats: the JSON line format of standard logging v2, and
// the legacy tab-separated W3C format. Supporting only one of them means a
// distribution configured the other way yields zero rows and looks like a site
// with no traffic, which is a maddening thing to debug.
//
// Everything here is pure. No S3, no network, no state.

import zlib from "node:zlib";
import { promisify } from "node:util";

const gunzip = promisify(zlib.gunzip);

// Legacy W3C column order. Only used when a log file is not JSON lines.
const W3C_FIELDS = [
  "date", "time", "x-edge-location", "sc-bytes", "c-ip", "cs-method",
  "cs-host", "cs-uri-stem", "sc-status", "cs-referer", "cs-user-agent",
  "cs-uri-query", "cs-cookie", "x-edge-result-type", "x-edge-request-id",
  "x-host-header", "cs-protocol", "cs-bytes", "time-taken",
  "x-forwarded-for", "ssl-protocol", "ssl-cipher", "x-edge-response-result-type",
  "cs-protocol-version", "fle-status", "fle-encrypted-fields", "c-port",
  "time-to-first-byte", "x-edge-detailed-result-type", "sc-content-type",
  "sc-content-len", "sc-range-start", "sc-range-end",
];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const dash = (v) => (v === "-" || v === undefined ? "" : v);

// CloudFront JSON logs use cs(Header) where W3C uses cs-header.
function normalize(e) {
  const out = {
    date: e.date,
    time: e.time,
    "x-edge-location": e["x-edge-location"],
    "sc-bytes": num(e["sc-bytes"]),
    "c-ip": e["c-ip"],
    // c-country was added to the log delivery after the first run. It is
    // CloudFront's own geolocation -- more accurate than an IP database and
    // free, which is why signal's geoip-lite (~100MB) was not brought across.
    "c-country": dash(e["c-country"]),
    "x-forwarded-for": dash(e["x-forwarded-for"]),
    "cs-uri-query": dash(e["cs-uri-query"]),
    "cs-method": e["cs-method"],
    "cs-host": e["cs(Host)"] ?? e["cs-host"],
    "cs-uri-stem": e["cs-uri-stem"],
    "sc-status": num(e["sc-status"]),
    "cs-referer": dash(e["cs(Referer)"] ?? e["cs-referer"]),
    "cs-user-agent": decodeURIComponent(dash(e["cs(User-Agent)"] ?? e["cs-user-agent"])),
    "x-edge-result-type": e["x-edge-result-type"],
    "sc-content-len": num(e["sc-content-len"]),
    "sc-range-end": num(e["sc-range-end"]),
    "time-taken": num(e["time-taken"]),
  };
  if (out.date && out.time) out.timestamp = `${out.date}T${out.time}Z`;
  // timestamp(ms) is exact when the delivery includes it; otherwise rebuild
  // from date+time, which is second-resolution and ample for a 30 minute gap.
  const ms = Number(e["timestamp(ms)"]);
  out.ts = Number.isFinite(ms) && ms > 0
    ? ms
    : (out.date && out.time ? Date.parse(`${out.date}T${out.time}Z`) : 0);
  return out;
}

/** Decompress and parse one log object. Handles both formats. */
export async function parseLogBuffer(buf) {
  const isGz = buf[0] === 0x1f && buf[1] === 0x8b;
  const text = (isGz ? await gunzip(buf) : buf).toString("utf8");
  return parseLogText(text);
}

export function parseLogText(text) {
  const entries = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue; // W3C header lines

    if (line.startsWith("{")) {
      try {
        entries.push(normalize(JSON.parse(line)));
      } catch {
        continue; // a truncated final line is normal in a rotating log
      }
      continue;
    }

    // Legacy tab-separated fallback.
    const parts = line.split("\t");
    // 9 gets us through sc-status, which is the last field anything here needs
    // to classify a request. Real logs carry all 33; a stricter floor would
    // silently drop a truncated or trimmed file instead of using what it has.
    if (parts.length < 9) continue;
    const rec = {};
    W3C_FIELDS.forEach((f, i) => { rec[f] = parts[i]; });
    entries.push(normalize(rec));
  }
  return entries;
}

// ------------------------------------------------------------- classification
export function detectBrowser(ua) {
  if (!ua) return "Unknown";
  const s = ua.toLowerCase();
  if (s.includes("edg/")) return "Edge";
  if (s.includes("chrome/") && !s.includes("edg/")) return "Chrome";
  if (s.includes("firefox/")) return "Firefox";
  if (s.includes("safari/") && !s.includes("chrome/")) return "Safari";
  if (s.includes("opera/") || s.includes("opr/")) return "Opera";
  if (s.includes("msie") || s.includes("trident/")) return "Internet Explorer";
  return "Other";
}

export function detectDevice(ua) {
  if (!ua) return "Unknown";
  const s = ua.toLowerCase();
  if (s.includes("tablet") || s.includes("ipad")) return "Tablet";
  if (s.includes("mobile") || s.includes("android") || s.includes("iphone")) return "Mobile";
  return "Desktop";
}

export function detectOS(ua) {
  if (!ua) return "Unknown";
  const s = ua.toLowerCase();
  if (s.includes("android")) return "Android";
  if (s.includes("iphone") || s.includes("ipad")) return "iOS";
  if (s.includes("windows")) return "Windows";
  if (s.includes("mac os")) return "macOS";
  if (s.includes("linux")) return "Linux";
  return "Other";
}

const BOT_PATTERNS = [
  "bot", "crawler", "spider", "scraper", "crawl", "slurp", "bingpreview",
  "googlebot", "baiduspider", "yandex", "facebookexternalhit", "gptbot",
  "claudebot", "perplexitybot", "ccbot", "bytespider", "ahrefs", "semrush",
  "feedfetcher", "rss", "curl/", "wget", "python-requests", "headlesschrome",
];

export function isBot(ua) {
  if (!ua) return false;
  const s = ua.toLowerCase();
  return BOT_PATTERNS.some((p) => s.includes(p));
}

// Scanners hammering /wp-login.php would otherwise dominate the country and
// path stats. They get counted separately rather than thrown away.
const PROBE_PATTERNS = [
  { pattern: "php", regex: /\.(php|phtml)/i },
  { pattern: "wordpress", regex: /wp-admin|wp-login|wp-content|wordpress|xmlrpc/i },
  { pattern: "env", regex: /\.env|\.git\/|\.aws\/|credentials/i },
  { pattern: "config", regex: /config\.(php|xml|json|yml|yaml)|\.ssh/i },
  { pattern: "shell", regex: /shell|cmd\.exe|eval\(|\/bin\/|backdoor/i },
  { pattern: "admin-probe", regex: /phpmyadmin|adminer|manager\/html|solr|jenkins/i },
  { pattern: "vuln", regex: /\.\.\/|%2e%2e|union\+select|<script/i },
];

export function detectProbePattern(uriPath) {
  if (!uriPath) return null;
  for (const p of PROBE_PATTERNS) {
    if (p.regex.test(uriPath)) return p.pattern;
  }
  return null;
}

// CloudFront edge codes are IATA airport codes. This is a coarse proxy for where
// the reader is: it is the nearest edge, not their actual country. Good enough
// to see "mostly US, some EU", not good enough to claim precision.
const EDGE_LOCATIONS = {
  IAD: ["US", "US East (Virginia)"], DCA: ["US", "US East (Virginia)"],
  ATL: ["US", "US East (Georgia)"], MIA: ["US", "US East (Florida)"],
  EWR: ["US", "US East (New Jersey)"], BOS: ["US", "US East (Massachusetts)"],
  JFK: ["US", "US East (New York)"], PHL: ["US", "US East (Pennsylvania)"],
  DFW: ["US", "US Central (Texas)"], ORD: ["US", "US Central (Illinois)"],
  IAH: ["US", "US Central (Texas)"], MCI: ["US", "US Central (Missouri)"],
  MSP: ["US", "US Central (Minnesota)"], DEN: ["US", "US West (Colorado)"],
  SEA: ["US", "US West (Washington)"], SFO: ["US", "US West (California)"],
  LAX: ["US", "US West (California)"], PDX: ["US", "US West (Oregon)"],
  PHX: ["US", "US West (Arizona)"], SLC: ["US", "US West (Utah)"],
  LAS: ["US", "US West (Nevada)"], SAN: ["US", "US West (California)"],
  // Added after the first real run: HIO (Hillsboro, Oregon) was the single
  // largest edge in the logs and fell through to "Unknown", which quietly put
  // the biggest slice of real traffic in the bucket labelled no-idea.
  HIO: ["US", "US West (Oregon)"], CMH: ["US", "US Central (Ohio)"],
  PDK: ["US", "US East (Georgia)"], TPA: ["US", "US East (Florida)"],
  CLT: ["US", "US East (North Carolina)"], RIC: ["US", "US East (Virginia)"],
  IND: ["US", "US Central (Indiana)"], STL: ["US", "US Central (Missouri)"],
  OMA: ["US", "US Central (Nebraska)"], NAS: ["US", "US Central (Tennessee)"],
  AUS: ["US", "US Central (Texas)"], SAT: ["US", "US Central (Texas)"],
  MSN: ["US", "US Central (Wisconsin)"], BNA: ["US", "US Central (Tennessee)"],
  PIT: ["US", "US East (Pennsylvania)"], DTW: ["US", "US Central (Michigan)"],
  HNL: ["US", "US West (Hawaii)"], ANC: ["US", "US West (Alaska)"],
  YVR: ["CA", "Canada (Vancouver)"], YUL: ["CA", "Canada (Montreal)"],
  YYZ: ["CA", "Canada (Toronto)"], YWG: ["CA", "Canada (Winnipeg)"],
  LHR: ["GB", "UK (London)"], MAN: ["GB", "UK (Manchester)"],
  CDG: ["FR", "France (Paris)"], MRS: ["FR", "France (Marseille)"],
  FRA: ["DE", "Germany (Frankfurt)"], MUC: ["DE", "Germany (Munich)"],
  DUS: ["DE", "Germany (Dusseldorf)"], HAM: ["DE", "Germany (Hamburg)"],
  AMS: ["NL", "Netherlands (Amsterdam)"], MAD: ["ES", "Spain (Madrid)"],
  BCN: ["ES", "Spain (Barcelona)"], MXP: ["IT", "Italy (Milan)"],
  FCO: ["IT", "Italy (Rome)"], ARN: ["SE", "Sweden (Stockholm)"],
  DUB: ["IE", "Ireland (Dublin)"], VIE: ["AT", "Austria (Vienna)"],
  ZRH: ["CH", "Switzerland (Zurich)"], OSL: ["NO", "Norway (Oslo)"],
  CPH: ["DK", "Denmark (Copenhagen)"], HEL: ["FI", "Finland (Helsinki)"],
  WAW: ["PL", "Poland (Warsaw)"], PRG: ["CZ", "Czechia (Prague)"],
  LIS: ["PT", "Portugal (Lisbon)"], ATH: ["GR", "Greece (Athens)"],
  NRT: ["JP", "Japan (Tokyo)"], KIX: ["JP", "Japan (Osaka)"],
  ICN: ["KR", "South Korea (Seoul)"], SIN: ["SG", "Singapore"],
  HKG: ["HK", "Hong Kong"], TPE: ["TW", "Taiwan (Taipei)"],
  BOM: ["IN", "India (Mumbai)"], DEL: ["IN", "India (Delhi)"],
  MAA: ["IN", "India (Chennai)"], BLR: ["IN", "India (Bangalore)"],
  SYD: ["AU", "Australia (Sydney)"], MEL: ["AU", "Australia (Melbourne)"],
  PER: ["AU", "Australia (Perth)"], AKL: ["NZ", "New Zealand (Auckland)"],
  GRU: ["BR", "Brazil (Sao Paulo)"], GIG: ["BR", "Brazil (Rio)"],
  EZE: ["AR", "Argentina (Buenos Aires)"], SCL: ["CL", "Chile (Santiago)"],
  BOG: ["CO", "Colombia (Bogota)"], MEX: ["MX", "Mexico (Mexico City)"],
  QRO: ["MX", "Mexico (Queretaro)"], TLV: ["IL", "Israel (Tel Aviv)"],
  DXB: ["AE", "UAE (Dubai)"], FJR: ["AE", "UAE (Fujairah)"],
  BAH: ["BH", "Bahrain"], CPT: ["ZA", "South Africa (Cape Town)"],
  JNB: ["ZA", "South Africa (Johannesburg)"], NBO: ["KE", "Kenya (Nairobi)"],
  LOS: ["NG", "Nigeria (Lagos)"], CMN: ["MA", "Morocco (Casablanca)"],
};

export function parseEdgeLocation(edge) {
  if (!edge || edge.length < 3) return { country: "Unknown", region: "Unknown" };
  const hit = EDGE_LOCATIONS[edge.slice(0, 3).toUpperCase()];
  return hit ? { country: hit[0], region: hit[1] } : { country: "Unknown", region: edge };
}

/** Referrer host, with our own domain filtered out by the caller. */
export function referrerHost(ref) {
  if (!ref || ref === "-") return null;
  try {
    return new URL(ref).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}
