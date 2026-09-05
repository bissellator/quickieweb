// Request classification: who visited, how they got here, and what they did.
//
// Covers sessionization, campaign and channel attribution, curated bot
// identities with a fingerprint fallback, page-vs-asset classification that
// understands directory-style URLs, and real-client-IP extraction.
//
// NOT brought across: geoip-lite. It is roughly 100MB and this bundle already
// carries sharp. The CloudFront log delivery was reconfigured to include the
// `c-country` field instead, which is more accurate than an IP database and
// costs nothing. See requestCountry().
//
// cfparser.mjs turns log bytes into records. This turns records into meaning.
// Both are pure: no S3, no network, no state.

import { isBot, detectProbePattern, parseEdgeLocation } from "./cfparser.mjs";

// --------------------------------------------------------------- bot identity
const KNOWN_BOTS = [
  // AI crawlers first. For a publication about AI infrastructure, which model
  // vendors are reading it is the most interesting line in the whole report.
  { re: /ClaudeBot/i, name: "ClaudeBot", category: "AI" },
  { re: /Claude-Web/i, name: "Claude-Web", category: "AI" },
  { re: /anthropic-ai/i, name: "anthropic-ai", category: "AI" },
  { re: /GPTBot/i, name: "GPTBot", category: "AI" },
  { re: /ChatGPT-User/i, name: "ChatGPT-User", category: "AI" },
  { re: /OAI-SearchBot/i, name: "OAI-SearchBot", category: "AI" },
  { re: /PerplexityBot/i, name: "PerplexityBot", category: "AI" },
  { re: /Perplexity-User/i, name: "Perplexity-User", category: "AI" },
  { re: /Bytespider/i, name: "Bytespider", category: "AI" },
  { re: /CCBot/i, name: "CCBot (Common Crawl)", category: "AI" },
  { re: /Amazonbot/i, name: "Amazonbot", category: "AI" },
  { re: /Meta-ExternalAgent/i, name: "Meta-ExternalAgent", category: "AI" },
  { re: /Meta-ExternalFetcher/i, name: "Meta-ExternalFetcher", category: "AI" },
  { re: /cohere-ai/i, name: "cohere-ai", category: "AI" },
  { re: /MistralAI/i, name: "MistralAI", category: "AI" },
  { re: /YouBot/i, name: "YouBot", category: "AI" },
  { re: /Diffbot/i, name: "Diffbot", category: "AI" },
  { re: /Omgili|webmeup/i, name: "Omgili", category: "AI" },

  { re: /Google-InspectionTool/i, name: "Google-InspectionTool", category: "Search" },
  { re: /GoogleOther/i, name: "GoogleOther", category: "Search" },
  { re: /AdsBot-Google/i, name: "AdsBot-Google", category: "Search" },
  { re: /APIs-Google/i, name: "APIs-Google", category: "Search" },
  { re: /Feedfetcher-Google/i, name: "Feedfetcher-Google", category: "Search" },
  { re: /Googlebot/i, name: "Googlebot", category: "Search" },
  { re: /BingPreview/i, name: "BingPreview", category: "Search" },
  { re: /bingbot/i, name: "Bingbot", category: "Search" },
  { re: /DuckDuckBot|DuckDuckGo-Favicons-Bot/i, name: "DuckDuckBot", category: "Search" },
  { re: /YandexBot/i, name: "YandexBot", category: "Search" },
  { re: /Baiduspider/i, name: "Baiduspider", category: "Search" },
  { re: /Applebot/i, name: "Applebot", category: "Search" },
  { re: /SeznamBot/i, name: "Seznam", category: "Search" },
  { re: /MojeekBot/i, name: "Mojeek", category: "Search" },

  { re: /facebookexternalhit/i, name: "facebookexternalhit", category: "Social" },
  { re: /Twitterbot/i, name: "Twitterbot", category: "Social" },
  { re: /LinkedInBot/i, name: "LinkedInBot", category: "Social" },
  { re: /Slackbot/i, name: "Slackbot", category: "Social" },
  { re: /Discordbot/i, name: "Discordbot", category: "Social" },
  { re: /TelegramBot/i, name: "TelegramBot", category: "Social" },
  { re: /WhatsApp/i, name: "WhatsApp", category: "Social" },
  { re: /redditbot/i, name: "redditbot", category: "Social" },

  { re: /SemrushBot/i, name: "SemrushBot", category: "SEO" },
  { re: /AhrefsBot/i, name: "AhrefsBot", category: "SEO" },
  { re: /MJ12bot/i, name: "MJ12bot", category: "SEO" },
  { re: /DotBot/i, name: "DotBot", category: "SEO" },
  { re: /BLEXBot/i, name: "BLEXBot", category: "SEO" },
  { re: /barkrowler/i, name: "Barkrowler", category: "SEO" },

  { re: /UptimeRobot/i, name: "UptimeRobot", category: "Monitoring" },
  { re: /Pingdom/i, name: "Pingdom", category: "Monitoring" },
  { re: /Better Uptime|BetterStack/i, name: "BetterStack", category: "Monitoring" },
  { re: /Lighthouse/i, name: "Lighthouse", category: "Monitoring" },
  { re: /PageSpeed/i, name: "PageSpeed", category: "Monitoring" },
  { re: /Datadog/i, name: "Datadog", category: "Monitoring" },

  { re: /^curl\//i, name: "curl", category: "Tool" },
  { re: /^Wget/i, name: "Wget", category: "Tool" },
  { re: /python-requests|python-urllib|aiohttp|httpx/i, name: "Python client", category: "Tool" },
  { re: /node-fetch|axios|undici/i, name: "Node client", category: "Tool" },
  { re: /Go-http-client/i, name: "Go client", category: "Tool" },
  { re: /HeadlessChrome|Puppeteer|Playwright|Selenium/i, name: "Headless browser", category: "Tool" },
];

const UA_CHAFF_TOKENS = new Set([
  "mozilla", "applewebkit", "khtml", "gecko", "chrome", "safari", "version",
  "mobile", "like", "macintosh", "windows", "linux", "x11", "android", "ipad",
  "iphone", "ipod", "wow64", "win64", "win32", "cros", "webkit",
]);

/**
 * Roll an unmatched bot UA up to a short label so every crawler variant does
 * not become its own row. Take the first Token/Version pair that is not browser
 * chaff, then the first interesting token inside (compatible; X; ...).
 */
export function botFingerprint(ua) {
  if (!ua || ua === "-") return "Unknown";
  for (const t of [...ua.matchAll(/([A-Za-z][\w.+-]*)\/[\w.+-]+/g)].map((m) => m[1])) {
    if (!UA_CHAFF_TOKENS.has(t.toLowerCase())) return t;
  }
  const paren = ua.match(/\(([^)]+)\)/);
  if (paren) {
    for (const part of paren[1].split(/[;,]/).map((x) => x.trim())) {
      const first = part.split(/\s+/)[0];
      if (first && !UA_CHAFF_TOKENS.has(first.toLowerCase()) && /^[A-Za-z]/.test(first)) {
        return first.slice(0, 40);
      }
    }
  }
  return (ua.split(/\s/)[0] || "Unknown").slice(0, 40);
}

/**
 * { name, category, known } for a bot UA, or null for a non-bot.
 * `known` separates the curated list from fingerprinted unknowns, so the UI can
 * show the ones that mean something and keep the long tail behind a toggle.
 */
export function parseBotIdentity(ua) {
  if (!isBot(ua)) return null;
  for (const { re, name, category } of KNOWN_BOTS) {
    if (re.test(ua)) return { name, category, known: true };
  }
  return { name: botFingerprint(ua), category: "Other", known: false };
}

// ------------------------------------------------------------ request classes
const ASSET_EXT = new Set([
  ".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
  ".woff", ".woff2", ".ttf", ".eot", ".map", ".json", ".xml",
]);
const PAGE_EXT = new Set([".html", ".htm", ".md"]);
const LEGIT_DIRS = ["/assets/", "/media/", "/admin/", "/api/", "/img/", "/css/", "/js/"];
const LEGIT_EXT = [
  ".html", ".htm", ".css", ".js", ".json", ".jpg", ".jpeg", ".png", ".gif",
  ".svg", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".mp3", ".m4a", ".wav",
  ".ogg", ".opus", ".xml", ".txt", ".pdf",
];

export function isAssetPath(path) {
  if (!path) return false;
  const dot = path.lastIndexOf(".");
  return dot >= 0 && ASSET_EXT.has(path.slice(dot).toLowerCase());
}

/**
 * A request a person would call "a page", as opposed to an asset that page
 * pulled in. Sessions count these and nothing else, so one visit to one page is
 * one page view rather than one plus its stylesheet and its favicon.
 * Extensionless paths count: directory-style URLs are how most sites read.
 */
export function isPageRequest(path) {
  if (!path) return false;
  if (path === "/" || path === "") return true;
  const file = path.slice(path.lastIndexOf("/") + 1);
  if (!file) return true;
  const dot = file.lastIndexOf(".");
  if (dot < 0) return true;
  return PAGE_EXT.has(file.slice(dot).toLowerCase());
}

export function isLegitimateRequest(path) {
  if (!path) return false;
  const p = path.toLowerCase();
  const clean = () => !detectProbePattern(p);
  if (p === "/" || p === "") return true;
  if (LEGIT_DIRS.some((d) => p.startsWith(d))) return clean();
  if (LEGIT_EXT.some((e) => p.endsWith(e))) return clean();
  if (p === "/favicon.ico" || p === "/robots.txt" || p.includes("sitemap")) return true;

  // Directory-style page URLs carry no extension and match nothing above.
  // Without this branch the stylesheet under /docs/ counts as legitimate while
  // the page that loaded it does not, and the reader gets filed as a scanner.
  // An unrecognised extension stays excluded: far likelier a probe than a page.
  const file = p.slice(p.lastIndexOf("/") + 1);
  if (!file || !file.includes(".")) return clean();
  return false;
}

/** CloudFront reports the edge's peer; X-Forwarded-For holds the real client. */
export function getRealClientIP(cIp, xff) {
  if (xff && xff !== "-") {
    const first = xff.split(",")[0].trim();
    if (first && first !== "-") return first;
  }
  return cIp;
}

// ------------------------------------------------------------------ campaigns
function decodeParam(s) {
  let v = s.replace(/\+/g, " ");
  for (let pass = 0; pass < 2; pass++) {
    if (!v.includes("%")) break;
    let next;
    try { next = decodeURIComponent(v); } catch { break; }
    if (next === v) break;
    v = next;
  }
  return v.trim();
}

/** First occurrence of a key wins: repeated params are a tagging mistake, and
 *  choosing deterministically beats letting the last one silently overwrite. */
export function parseQueryParams(query) {
  const out = new Map();
  if (!query || query === "-") return out;
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = decodeParam(eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
    if (!key || out.has(key)) continue;
    out.set(key, decodeParam(eq < 0 ? "" : pair.slice(eq + 1)));
  }
  return out;
}

// `channel: null` means the identifier proves where a click came from but not
// that it was paid: Facebook and Instagram append theirs to organic shares too,
// so those fall through to referrer classification rather than inflating paid.
const CLICK_ID_PARAMS = [
  { param: "gclid", network: "Google Ads", channel: "Paid search" },
  { param: "gbraid", network: "Google Ads", channel: "Paid search" },
  { param: "wbraid", network: "Google Ads", channel: "Paid search" },
  { param: "msclkid", network: "Microsoft Ads", channel: "Paid search" },
  { param: "dclid", network: "Google Display", channel: "Display" },
  { param: "ttclid", network: "TikTok Ads", channel: "Paid social" },
  { param: "twclid", network: "X Ads", channel: "Paid social" },
  { param: "li_fat_id", network: "LinkedIn Ads", channel: "Paid social" },
  { param: "fbclid", network: "Facebook", channel: null },
  { param: "igshid", network: "Instagram", channel: null },
];

const CAMPAIGN_VALUE_MAX = 120;

export function extractCampaign(params) {
  if (!params || params.size === 0) return null;
  const get = (k) => {
    const v = params.get(k);
    return v ? v.slice(0, CAMPAIGN_VALUE_MAX) : null;
  };
  const c = {
    source: get("utm_source"), medium: get("utm_medium"), name: get("utm_campaign"),
    term: get("utm_term"), content: get("utm_content"), id: get("utm_id"),
    clickId: CLICK_ID_PARAMS.find((x) => params.has(x.param)) || null,
  };
  const tagged = c.source || c.medium || c.name || c.term || c.content || c.id || c.clickId;
  return tagged ? c : null;
}

// utm_medium is free text, so these are conventional spellings rather than a
// closed set. Anything tagged but unrecognised lands in "Other campaign", which
// is a prompt to fix the tagging, not a bucket to ignore.
const PAID_SEARCH_MEDIUMS = new Set(["cpc", "ppc", "paidsearch", "paid-search", "paid_search", "sem", "adwords"]);
const PAID_SOCIAL_MEDIUMS = new Set(["paidsocial", "paid-social", "paid_social", "social-paid"]);
const DISPLAY_MEDIUMS = new Set(["display", "banner", "cpm", "retargeting", "remarketing"]);
const EMAIL_MEDIUMS = new Set(["email", "e-mail", "newsletter", "mail"]);
const SOCIAL_MEDIUMS = new Set(["social", "social-organic", "social_organic", "sm"]);

// Checked before the search list on purpose: an assistant that happens to live
// on a search engine domain (gemini.google.com) is an assistant referral, not
// an organic search result.
const AI_ASSISTANT_HOSTS = [
  /(^|\.)chatgpt\.com$/, /(^|\.)chat\.openai\.com$/, /(^|\.)openai\.com$/,
  /(^|\.)claude\.ai$/, /(^|\.)perplexity\.ai$/, /(^|\.)gemini\.google\.com$/,
  /(^|\.)copilot\.microsoft\.com$/, /(^|\.)you\.com$/, /(^|\.)phind\.com$/,
  /(^|\.)poe\.com$/, /(^|\.)mistral\.ai$/,
];

const SEARCH_HOSTS = [
  /(^|\.)google\.[a-z.]+$/, /(^|\.)bing\.com$/, /(^|\.)duckduckgo\.com$/,
  /(^|\.)search\.yahoo\.[a-z.]+$/, /(^|\.)yandex\.[a-z.]+$/, /(^|\.)baidu\.com$/,
  /(^|\.)ecosia\.org$/, /(^|\.)startpage\.com$/, /(^|\.)qwant\.com$/,
  /(^|\.)search\.brave\.com$/, /(^|\.)mojeek\.com$/,
];

const SOCIAL_HOSTS = [
  /(^|\.)facebook\.com$/, /(^|\.)instagram\.com$/, /(^|\.)linkedin\.com$/,
  /(^|\.)lnkd\.in$/, /(^|\.)twitter\.com$/, /(^|\.)x\.com$/, /^t\.co$/,
  /(^|\.)reddit\.com$/, /(^|\.)news\.ycombinator\.com$/, /(^|\.)lobste\.rs$/,
  /(^|\.)youtube\.com$/, /(^|\.)tiktok\.com$/, /(^|\.)bsky\.app$/,
  /(^|\.)mastodon\.[a-z.]+$/, /(^|\.)threads\.net$/, /(^|\.)substack\.com$/,
  /(^|\.)medium\.com$/, /(^|\.)slack\.com$/, /(^|\.)discord\.com$/,
];

function classifyKnownHost(host) {
  if (!host) return null;
  if (AI_ASSISTANT_HOSTS.some((re) => re.test(host))) return "AI assistant";
  if (SEARCH_HOSTS.some((re) => re.test(host))) return "Organic search";
  if (SOCIAL_HOSTS.some((re) => re.test(host))) return "Social";
  return null;
}

/**
 * Where a visit came from, in the vocabulary a person reports in.
 *
 * Campaign tags outrank the referrer -- they are the deliberate signal, and a
 * tagged link clicked from a search results page is still that campaign. But a
 * tag with NO medium does not outrank it: ChatGPT appends utm_source=chatgpt.com
 * and nothing else, and burying that under "Other campaign" while the referrer
 * sitting beside it says plainly where the visit came from would be worse than
 * useless.
 */
export function classifyChannel(campaign, host) {
  const medium = campaign ? (campaign.medium || "").toLowerCase() : "";
  if (campaign) {
    if (PAID_SEARCH_MEDIUMS.has(medium)) return "Paid search";
    if (PAID_SOCIAL_MEDIUMS.has(medium)) return "Paid social";
    if (DISPLAY_MEDIUMS.has(medium)) return "Display";
    if (EMAIL_MEDIUMS.has(medium)) return "Email";
    if (SOCIAL_MEDIUMS.has(medium)) return "Social";
    if (medium === "organic") return "Organic search";
    if (medium === "referral") return "Referral";
    if (campaign.clickId?.channel) return campaign.clickId.channel;
  }

  const known = classifyKnownHost(host);
  if (known) return known;

  if (campaign) {
    // No usable referrer either, so utm_source names the origin: read it as one.
    const fromSource = classifyKnownHost((campaign.source || "").toLowerCase());
    if (fromSource) return fromSource;
    if (campaign.source || campaign.name || medium) return "Other campaign";
  }
  return host ? "Referral" : "Direct";
}

// -------------------------------------------------------------- sessionization
export const SESSION_GAP_MS = 30 * 60 * 1000;

/**
 * Groups page requests into visits without a cookie, the way log analyzers
 * always have: same client fingerprint, no more than a 30 minute gap. The first
 * page of a visit is the entry, the last is the exit.
 *
 * A session's channel comes from its entry request, the only one that can carry
 * a campaign tag or an external referrer -- every later request in the visit is
 * referred by us.
 *
 * Events arrive out of order because log objects are parsed in whatever order
 * they list, so each fingerprint is sorted before splitting.
 */
export function sessionize(eventsByFp, gapMs = SESSION_GAP_MS) {
  const sessions = [];
  for (const [fp, events] of eventsByFp) {
    let current = null;
    for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
      if (!current || e.ts - current.end > gapMs) {
        current = {
          fp, start: e.ts, end: e.ts, entry: e.path, exit: e.path,
          channel: e.channel, referrer: e.referrer ?? null, views: [e.path],
        };
        sessions.push(current);
        continue;
      }
      current.end = e.ts;
      current.exit = e.path;
      current.views.push(e.path);
    }
  }
  return sessions;
}

/** A visit that saw one distinct page bounced. Distinct rather than raw views,
 *  so a reload or a re-render does not read as engagement. */
export function sessionStats(session) {
  const distinct = new Set(session.views).size;
  return {
    pageViews: session.views.length,
    distinctPages: distinct,
    bounced: distinct === 1,
    durationSec: Math.round((session.end - session.start) / 1000),
  };
}

// ---------------------------------------------------------------- geolocation
const COUNTRY_NAMES = {
  US: "United States", CA: "Canada", GB: "United Kingdom", FR: "France",
  DE: "Germany", NL: "Netherlands", ES: "Spain", IT: "Italy", SE: "Sweden",
  IE: "Ireland", AT: "Austria", CH: "Switzerland", NO: "Norway", DK: "Denmark",
  FI: "Finland", PL: "Poland", CZ: "Czechia", PT: "Portugal", GR: "Greece",
  JP: "Japan", KR: "South Korea", SG: "Singapore", HK: "Hong Kong",
  TW: "Taiwan", IN: "India", AU: "Australia", NZ: "New Zealand", BR: "Brazil",
  AR: "Argentina", CL: "Chile", MX: "Mexico", IL: "Israel", AE: "UAE",
  ZA: "South Africa", KE: "Kenya", NG: "Nigeria", CN: "China", RU: "Russia",
  UA: "Ukraine", TR: "Turkey", VN: "Vietnam", BE: "Belgium", TH: "Thailand",
  MY: "Malaysia", ID: "Indonesia", PH: "Philippines", RO: "Romania",
  HU: "Hungary", BG: "Bulgaria", SA: "Saudi Arabia", EG: "Egypt", MA: "Morocco",
};

export const getCountryName = (code) => COUNTRY_NAMES[code] ?? code ?? "Unknown";

/**
 * Country for a request. CloudFront's own c-country is authoritative and is
 * used whenever present. The edge code is a coarse fallback for logs delivered
 * before that field was enabled: it is the nearest edge, not a location, and
 * `precise` tells the caller which one it got.
 */
export function requestCountry(e) {
  const c = (e["c-country"] || "").trim().toUpperCase();
  if (c && c.length === 2 && c !== "-") return { code: c, precise: true };
  const loc = parseEdgeLocation(e["x-edge-location"]);
  return { code: loc.country, precise: false };
}
