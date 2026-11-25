// The Stats window and day filter (readReport in admin/lib/stats.mjs): "last 7
// days" is today and the six before it, not eight dates, and ?date= narrows the
// summary the Overview reads to that one day.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readReport, windowStart, detailWithoutOwnReferrers } from "../admin/lib/stats.mjs";

const NOW = Date.parse("2026-11-24T15:00:00Z");
const day = (date, sessions) => ({ date, requests: sessions * 3, sessions, pageViews: sessions * 2 });

function storeWith(days) {
  const data = {
    "_internal/stats/daily.json": { days: Object.fromEntries(days.map((d) => [d.date, d])) },
  };
  return { async getJson(key, fallback) { return data[key] ?? fallback; } };
}

const store = storeWith([
  day("2026-11-24", 1), day("2026-11-23", 2), day("2026-11-18", 4), day("2026-11-17", 8),
]);

test("a window of N days ends today and holds N dates", () => {
  assert.equal(windowStart(1, NOW), "2026-11-24");
  assert.equal(windowStart(7, NOW), "2026-11-18");
});

test("last 7 days leaves out the eighth day back", async () => {
  const r = await readReport(store, 7, { now: NOW });
  assert.deepEqual(r.dates, ["2026-11-24", "2026-11-23", "2026-11-18"]);
  assert.equal(r.totals.sessions, 7);
});

test("date narrows every total to that one day", async () => {
  const r = await readReport(store, 30, { date: "2026-11-23", now: NOW });
  assert.deepEqual(r.dates, ["2026-11-23"]);
  assert.equal(r.totals.sessions, 2);
  assert.equal(r.totals.requests, 6);
  assert.equal(r.windowDays, 1);
  assert.equal(r.date, "2026-11-23");
});

// Days folded before the own-host filter knew every name the site answers at
// have the site itself stored as a referrer. Reading hides it, no rebuild.
test("stored self-referrers are dropped on read", async () => {
  const OWN = ["www.stuckinawoman.com", "stuckinawoman.com", "stuckinawoman.quickieweb.com"];
  const s = storeWith([{ ...day("2026-11-24", 5), referrers: [
    { key: "stuckinawoman.com", count: 40 },
    { key: "stuckinawoman.quickieweb.com", count: 9 },
    { key: "facebook.com", count: 3 },
  ] }]);
  const r = await readReport(s, 7, { now: NOW, ownHost: OWN });
  assert.deepEqual(r.referrers, [{ key: "facebook.com", count: 3 }]);
  // without hosts, nothing is filtered
  assert.equal((await readReport(s, 7, { now: NOW })).referrers.length, 3);

  const detail = detailWithoutOwnReferrers({ date: "2026-11-24", acquisition: {
    channels: [{ key: "Referral", count: 5 }],
    referrers: [{ key: "stuckinawoman.com", count: 40 }, { key: "facebook.com", count: 3 }],
    referrerUrls: [
      { key: "https://www.stuckinawoman.com/a.html", count: 30 },
      { key: "https://stuckinawoman.quickieweb.com/", count: 9 },
      { key: "https://www.facebook.com/", count: 3 },
    ],
  } }, OWN);
  assert.deepEqual(detail.acquisition.referrers, [{ key: "facebook.com", count: 3 }]);
  assert.deepEqual(detail.acquisition.referrerUrls, [{ key: "https://www.facebook.com/", count: 3 }]);
  assert.deepEqual(detail.acquisition.channels, [{ key: "Referral", count: 5 }], "other fields untouched");
});
