// Tests for request classification: which hits are readers, which are scanners.
// Run: node test/classify.test.mjs
import assert from "node:assert/strict";
import {
  parseBotIdentity, classifyChannel, extractCampaign, parseQueryParams,
  sessionize, sessionStats, isPageRequest, isLegitimateRequest,
  getRealClientIP, requestCountry,
} from "../admin/lib/classify.mjs";
import { referrerHost } from "../admin/lib/cfparser.mjs";

let n = 0;
const t = (label, got, want) => {
  n++;
  assert.deepEqual(got, want, `${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

t("ClaudeBot", parseBotIdentity("Mozilla/5.0 ClaudeBot/1.0"), { name: "ClaudeBot", category: "AI", known: true });
t("GPTBot is AI", parseBotIdentity("GPTBot/1.2").category, "AI");
t("Googlebot is Search", parseBotIdentity("Googlebot/2.1").category, "Search");
t("curl is a Tool", parseBotIdentity("curl/8.18.0").name, "curl");
t("unknown bot fingerprints", parseBotIdentity("Mozilla/5.0 (compatible; WeirdBot/9)").name, "WeirdBot");
t("browser is not a bot", parseBotIdentity("Mozilla/5.0 (Macintosh) Chrome/120 Safari/537"), null);

const ch = (ref, q) => classifyChannel(extractCampaign(parseQueryParams(q)), referrerHost(ref));
t("no referrer is Direct", ch("-", "-"), "Direct");
t("HN is Social", ch("https://news.ycombinator.com/", "-"), "Social");
t("Google is Organic search", ch("https://www.google.com/search?q=x", "-"), "Organic search");
t("ChatGPT is AI assistant", ch("https://chatgpt.com/", "-"), "AI assistant");
t("Claude is AI assistant", ch("https://claude.ai/chat/1", "-"), "AI assistant");
// An assistant on a search engine domain is an assistant, not organic search.
t("gemini outranks google", ch("https://gemini.google.com/", "-"), "AI assistant");
t("utm cpc is Paid search", ch("-", "utm_source=g&utm_medium=cpc"), "Paid search");
t("gclid is Paid search", ch("-", "gclid=abc123"), "Paid search");
// ChatGPT tags with utm_source and no medium; it must not fall to Other campaign.
t("utm_source only still resolves", ch("-", "utm_source=chatgpt.com"), "AI assistant");
t("unknown host is Referral", ch("https://someblog.example/", "-"), "Referral");

t("/ is a page", isPageRequest("/"), true);
t("directory URL is a page", isPageRequest("/docs/"), true);
t("extensionless is a page", isPageRequest("/about"), true);
t("css is not a page", isPageRequest("/assets/style.css"), false);
t("probe is not legitimate", isLegitimateRequest("/.env.backup"), false);
t("wp-login is not legitimate", isLegitimateRequest("/wp-login.php"), false);
t("real page is legitimate", isLegitimateRequest("/about.html"), true);

t("xff wins over c-ip", getRealClientIP("1.1.1.1", "9.9.9.9, 2.2.2.2"), "9.9.9.9");
t("no xff falls back", getRealClientIP("1.1.1.1", "-"), "1.1.1.1");
t("c-country is precise", requestCountry({ "c-country": "DE", "x-edge-location": "SEA19" }), { code: "DE", precise: true });
t("edge is the fallback", requestCountry({ "c-country": "", "x-edge-location": "HIO52-P5" }), { code: "US", precise: false });

const M = 60000;
const sessions = sessionize(new Map([["fp1", [
  { ts: 0, path: "/", channel: "Social", referrer: "news.ycombinator.com" },
  { ts: 5 * M, path: "/a.html", channel: "Social" },
  { ts: 90 * M, path: "/b.html", channel: "Direct" },
]]]));
t("a 30min gap splits sessions", sessions.length, 2);
t("entry page", sessions[0].entry, "/");
t("exit page", sessions[0].exit, "/a.html");
t("channel comes from entry", sessions[0].channel, "Social");
t("two pages is not a bounce", sessionStats(sessions[0]).bounced, false);
t("one page is a bounce", sessionStats(sessions[1]).bounced, true);
t("duration in seconds", sessionStats(sessions[0]).durationSec, 300);

console.log(`all ${n} classification tests passed`);
