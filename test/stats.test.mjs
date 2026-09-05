// Regression tests for the stats pipeline.
//
// Run: node test/stats.test.mjs
//
// The original bug these exist for: mergeCounts was binary (a, b, n) but callers
// spread N days into it. One day of data crashed with "a is not iterable"; three
// or more silently dropped everything past the second. Both shapes are asserted
// below, now against the real exports rather than copies -- stats.mjs used to
// import the AWS SDK at module load, which made it unloadable on a laptop, so
// this file re-declared the functions it was checking. The SDK import moved
// inside processLogs and that workaround is gone.

import assert from "node:assert/strict";
import {
  mergeCounts, mergeRows, mergeDetail, buildDay, topN,
} from "../admin/lib/stats.mjs";
import { parseLogText } from "../admin/lib/cfparser.mjs";

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ${name.padEnd(30)} ok`); }
  catch (e) { failures++; console.error(`  ${name.padEnd(30)} FAIL  ${e.message}`); }
};

const day = (k, c) => [{ key: k, count: c }];

// ------------------------------------------------------------- mergeCounts
check("mergeCounts 1 day", () => {
  assert.deepEqual(mergeCounts([day("/a", 3)], 10), [{ key: "/a", count: 3 }]);
});
check("mergeCounts 2 days", () => {
  assert.deepEqual(mergeCounts([day("/a", 3), day("/a", 2)], 10), [{ key: "/a", count: 5 }]);
});
check("mergeCounts 5 days", () => {
  const five = mergeCounts([day("/a", 1), day("/a", 1), day("/a", 1), day("/a", 1), day("/a", 1)], 10);
  assert.deepEqual(five, [{ key: "/a", count: 5 }], "every day must be counted, not just the first two");
});
check("mergeCounts empty/holes", () => {
  assert.deepEqual(mergeCounts([], 10), []);
  assert.deepEqual(mergeCounts([undefined, null, day("/a", 1)], 10), [{ key: "/a", count: 1 }]);
});
check("mergeCounts cap honored", () => {
  const capped = mergeCounts([day("/a", 5), day("/b", 4), day("/c", 3)], 2);
  assert.equal(capped.length, 2);
  assert.equal(capped[0].key, "/a");
});

// --------------------------------------------------------------- mergeRows
check("mergeRows sums counts", () => {
  const out = mergeRows([
    [{ ip: "1.1.1.1", count: 3, country: "AU" }],
    [{ ip: "1.1.1.1", count: 2, country: "AU" }, { ip: "2.2.2.2", count: 9, country: "US" }],
  ], "ip", 10);
  assert.equal(out.length, 2);
  assert.equal(out[0].ip, "2.2.2.2");
  assert.equal(out[0].count, 9);
  assert.equal(out.find((r) => r.ip === "1.1.1.1").count, 5);
});

check("mergeRows keeps learned fields", () => {
  // A day that resolved a city must not have it erased by a day that did not.
  const out = mergeRows([
    [{ ip: "1.1.1.1", count: 1, city: "", country: "AU" }],
    [{ ip: "1.1.1.1", count: 1, city: "Sydney", country: "AU" }],
  ], "ip", 10);
  assert.equal(out[0].city, "Sydney");
});

check("mergeRows nested paths", () => {
  const out = mergeRows([
    [{ key: "Googlebot", count: 2, topPaths: day("/a", 2) }],
    [{ key: "Googlebot", count: 3, topPaths: [...day("/a", 1), ...day("/b", 3)] }],
  ], "key", 10, { nested: ["topPaths"] });
  assert.equal(out[0].count, 5);
  // /a and /b both total 3; topN's sort is stable, so insertion order breaks the tie.
  assert.deepEqual(out[0].topPaths, [{ key: "/a", count: 3 }, { key: "/b", count: 3 }]);
});

check("mergeRows drops blank ids", () => {
  const out = mergeRows([[{ ip: "", count: 5 }, { ip: "1.1.1.1", count: 1 }]], "ip", 10);
  assert.equal(out.length, 1);
});

// ---------------------------------------------------------- log -> day
const LOG = [
  "#Version: 1.0",
  "#Fields: date time x-edge-location sc-bytes c-ip cs-method cs-host cs-uri-stem sc-status cs-referer cs-user-agent cs-uri-query",
  // a reader: two pages, an asset, one with a campaign tag
  ["2026-09-03", "10:15:00", "SEA19-C1", "5120", "8.8.8.8", "GET", "example.com", "/", "200", "https://news.ycombinator.com/", "Mozilla/5.0%20(Macintosh;%20Intel%20Mac%20OS%20X)%20AppleWebKit/537.36%20(KHTML,%20like%20Gecko)%20Chrome/131.0%20Safari/537.36", "utm_source=hn&utm_medium=social&utm_campaign=launch"].join("\t"),
  ["2026-09-03", "10:16:30", "SEA19-C1", "4096", "8.8.8.8", "GET", "example.com", "/about.html", "200", "https://example.com/", "Mozilla/5.0%20(Macintosh;%20Intel%20Mac%20OS%20X)%20AppleWebKit/537.36%20(KHTML,%20like%20Gecko)%20Chrome/131.0%20Safari/537.36", "-"].join("\t"),
  ["2026-09-03", "10:16:31", "SEA19-C1", "800", "8.8.8.8", "GET", "example.com", "/assets/style.css", "200", "-", "Mozilla/5.0%20(Macintosh;%20Intel%20Mac%20OS%20X)%20AppleWebKit/537.36%20(KHTML,%20like%20Gecko)%20Chrome/131.0%20Safari/537.36", "-"].join("\t"),
  // a scanner, twice, in a different hour
  ["2026-09-03", "19:49:57", "SEA19-C1", "512", "119.93.116.116", "GET", "example.com", "/.env", "404", "-", "Mozilla/5.0%20zgrab/0.x", "-"].join("\t"),
  ["2026-09-03", "19:50:12", "SEA19-C1", "512", "119.93.116.116", "GET", "example.com", "/wp-config.php.bak", "404", "-", "Mozilla/5.0%20zgrab/0.x", "-"].join("\t"),
  // a named bot
  ["2026-09-03", "11:00:00", "SEA19-C1", "3000", "66.249.66.1", "GET", "example.com", "/", "200", "-", "Mozilla/5.0%20(compatible;%20Googlebot/2.1;%20+http://www.google.com/bot.html)", "-"].join("\t"),
  // the admin plane
  ["2026-09-03", "12:00:00", "SEA19-C1", "900", "8.8.8.8", "GET", "example.com", "/api/articles", "200", "-", "Mozilla/5.0%20(Macintosh;%20Intel%20Mac%20OS%20X)%20AppleWebKit/537.36%20(KHTML,%20like%20Gecko)%20Chrome/131.0%20Safari/537.36", "-"].join("\t"),
].join("\n");

const entries = parseLogText(LOG);
const { summary, detail } = buildDay("2026-09-03", entries, "example.com");

check("parses every line", () => {
  assert.equal(entries.length, 7);
});

check("traffic classes separated", () => {
  assert.equal(summary.requests, 7, "everything counts as a request");
  assert.equal(summary.probes, 2, "two scanner hits");
  assert.equal(summary.bots, 1, "Googlebot");
  assert.equal(summary.internal, 1, "/api/ is the admin plane, not a visit");
  assert.equal(summary.errors, 2, "the two 404s");
});

check("probes stay out of readership", () => {
  // The whole reason probes are tracked apart: 119.93.116.116 must not make
  // the Philippines the top country for readers.
  const countries = detail.geo.countries.map((c) => c.key);
  assert.ok(!countries.includes("PH"), `readers should not include PH: ${countries}`);
  assert.ok(detail.geo.scannerCountries.length >= 0);
  assert.equal(detail.security.probeLog.length, 2);
  assert.equal(detail.security.probeLog[0].path, "/wp-config.php.bak", "newest first");
  assert.ok(detail.security.probePatterns.some((p) => p.key === "env"),
    `expected an env probe pattern, got ${JSON.stringify(detail.security.probePatterns)}`);
});

check("our own words are not probes", () => {
  // The publication writes about wp-config and .env files. Its own article
  // slugs and its own admin traffic trip every probe pattern in the list, and
  // used to be filed as scanning from Oregon.
  const lines = [
    // an admin save of an article whose slug says "wordpress"
    ["2026-09-04", "01:49:01", "SEA19-C1", "900", "8.8.8.8", "PUT", "example.com",
      "/api/articles/2026-09-04-every-scanner-assumes-you-run-wordpress", "200", "-", "Mozilla/5.0%20Chrome/131.0", "-"].join("\t"),
    // a reader opening that same article
    ["2026-09-04", "02:00:00", "SEA19-C1", "9000", "1.1.1.1", "GET", "example.com",
      "/2026-09-04-every-scanner-assumes-you-run-wordpress.html", "200", "-", "Mozilla/5.0%20Chrome/131.0", "-"].join("\t"),
    // an actual scanner, which does not get a 200
    ["2026-09-04", "02:00:05", "SEA19-C1", "512", "61.111.250.85", "GET", "example.com",
      "/wp-config.php.bak", "404", "-", "curl/8.0", "-"].join("\t"),
  ].join("\n");
  const r = buildDay("2026-09-04", parseLogText(lines), "example.com");
  assert.equal(r.summary.internal, 1, "the admin save is internal, not a probe");
  assert.equal(r.summary.probes, 1, "only the 404 on wp-config.php.bak is a probe");
  assert.ok(r.detail.content.pages.some((p) => p.key.includes("wordpress")),
    "the article must still count as a page view");
  const logged = r.detail.security.probeLog.map((p) => p.path);
  assert.deepEqual(logged, ["/wp-config.php.bak"], `probe log should hold only the scanner: ${logged}`);
});

check("bots kept out of sessions", () => {
  assert.equal(summary.sessions, 1, "one human visit");
  assert.equal(summary.pageViews, 2, "two pages, the stylesheet is not one");
  assert.ok(detail.bots.known.some((b) => b.name === "Googlebot"), "Googlebot must be named");
  const g = detail.bots.known.find((b) => b.name === "Googlebot");
  assert.equal(g.objectsCrawled, 1);
  assert.deepEqual(g.topPaths, [{ key: "/", count: 1 }]);
  assert.ok(!detail.audience.browsers.some((b) => b.key === "Chrome" && b.count > 4),
    "bot requests must not reach the browser table");
});

check("hourly buckets", () => {
  assert.equal(detail.hourly.length, 24);
  assert.equal(detail.hourly[10].requests, 3, "three requests in the 10:00 hour");
  assert.equal(detail.hourly[10].pageViews, 2);
  assert.equal(detail.hourly[19].probes, 2, "both probes landed in the 19:00 hour");
  assert.equal(detail.hourly[11].bots, 1);
  assert.equal(detail.hourly.reduce((n, h) => n + h.requests, 0), summary.requests);
});

check("acquisition", () => {
  const keys = detail.acquisition.queryKeys.map((k) => k.key);
  assert.ok(keys.includes("utm_source"), `query keys should include utm_source: ${keys}`);
  assert.ok(detail.acquisition.campaigns.some((c) => c.key === "launch"));
  assert.ok(detail.acquisition.sources.some((c) => c.key === "hn"));
  assert.ok(detail.acquisition.sourceMediums.some((c) => c.key === "hn / social"));
});

check("referrers exclude self", () => {
  const hosts = detail.acquisition.referrers.map((r) => r.key);
  assert.ok(hosts.includes("news.ycombinator.com"));
  assert.ok(!hosts.includes("example.com"), "own host is not a referrer");
});

check("content and edges", () => {
  assert.ok(detail.content.pages.some((p) => p.key === "/about.html"));
  assert.ok(detail.content.assets.some((p) => p.key === "/assets/style.css"));
  assert.ok(detail.content.edgeLocations.some((p) => p.key === "SEA19-C1"));
  assert.ok(detail.security.top404Paths.some((p) => p.key === "/.env"));
});

// ------------------------------------------------------------- mergeDetail
check("mergeDetail sums hours and totals", () => {
  const b = buildDay("2026-09-03", entries, "example.com").detail;
  const merged = mergeDetail(detail, b);
  assert.equal(merged.summary.requests, summary.requests * 2);
  assert.equal(merged.hourly[10].requests, 6);
  assert.equal(merged.hourly.length, 24);
  assert.equal(merged.security.probeLog.length, 4);
  assert.ok(merged.acquisition.queryKeys.some((k) => k.key === "utm_source" && k.count === 2));
});

check("mergeDetail with no prior", () => {
  const merged = mergeDetail(null, detail);
  assert.equal(merged, detail, "a first write must pass straight through");
});

check("mergeDetail recomputes cache rate", () => {
  const a = { date: "d", summary: { hits: 3, misses: 1 }, hourly: [] };
  const b = { date: "d", summary: { hits: 1, misses: 5 }, hourly: [] };
  const m = mergeDetail(a, b);
  assert.equal(m.summary.hits, 4);
  assert.equal(m.summary.misses, 6);
  assert.equal(m.summary.cacheHitRate, 40, "rate must be recomputed, not averaged");
});

check("topN respects n", () => {
  assert.deepEqual(topN({ a: 1, b: 5, c: 3 }, 2), [{ key: "b", count: 5 }, { key: "c", count: 3 }]);
});

if (failures) {
  console.error(`\n${failures} stats test(s) failed`);
  process.exit(1);
}
console.log("\nall stats tests passed");
