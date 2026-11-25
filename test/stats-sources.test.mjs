// Per-site log sources: which access logs a site's Stats tab reads.
//
// The hosted platform logs every tenant on the shared distribution into one
// folder. The failure these tests exist for is one tenant's Stats counting
// another tenant's traffic -- the shape processLogs had before it took sources,
// when it read the whole log bucket unfiltered.

import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

import { processLogs, entryBelongs } from "../admin/lib/stats.mjs";
import { parseLogText } from "../admin/lib/cfparser.mjs";
import { logSourcesFor, logPrefixFor } from "../shared/site.mjs";

const line = (host, uri = "/", date = "2026-11-13") => JSON.stringify({
  date, time: "12:00:00", "x-edge-location": "SEA19-C1", "sc-bytes": "1000",
  "c-ip": "203.0.113.7", "cs-method": "GET", "cs(Host)": "d19wnv47n55d38.cloudfront.net",
  "cs-uri-stem": uri, "sc-status": "200", "cs(Referer)": "-",
  "cs(User-Agent)": "Mozilla/5.0%20(Windows%20NT%2010.0)%20Chrome/130.0",
  "x-edge-result-type": "Hit", "x-host-header": host,
});

test("parser keeps the viewer Host header, lowercased", () => {
  const [e] = parseLogText(line("JeffSeats.QuickieWeb.com"));
  assert.equal(e["x-host-header"], "jeffseats.quickieweb.com");
  assert.equal(e["cs-host"], "d19wnv47n55d38.cloudfront.net");
});

test("entryBelongs: unfiltered source takes everything", () => {
  assert.equal(entryBelongs({ "x-host-header": "anything.example" }, null), true);
});

test("entryBelongs: shared source takes only the site's hosts", () => {
  const hosts = ["jeffseats.quickieweb.com"];
  assert.equal(entryBelongs({ "x-host-header": "jeffseats.quickieweb.com" }, hosts), true);
  assert.equal(entryBelongs({ "x-host-header": "jeffseats.quickieweb.com:443" }, hosts), true);
  assert.equal(entryBelongs({ "x-host-header": "testme.quickieweb.com" }, hosts), false);
  // no Host header on a shared source is someone's traffic, not necessarily ours
  assert.equal(entryBelongs({ "x-host-header": "" }, hosts), false);
});

const hostedSite = (over = {}) => ({
  siteId: "stuckinawoman",
  site: { domain: "www.stuckinawoman.com" },
  storage: {
    driver: "prefix", distributionId: "E3FDL9P88XA2K7",
    mirrorDistributionIds: ["E1IVLQSMM1AGFH"], ...over,
  },
});

test("logSourcesFor: hosted site reads shared folder filtered, mirror whole", () => {
  assert.deepEqual(logSourcesFor(hostedSite(), { hostedDomain: "quickieweb.com" }), [
    { prefix: "cf/E3FDL9P88XA2K7/", hosts: ["stuckinawoman.quickieweb.com", "www.stuckinawoman.com"] },
    { prefix: "cf/E1IVLQSMM1AGFH/", hosts: null },
  ]);
});

test("logSourcesFor: subdomain-only site has one host", () => {
  const site = { siteId: "jeffseats", site: { domain: "jeffseats.quickieweb.com" },
    storage: { driver: "prefix", distributionId: "E3FDL9P88XA2K7" } };
  assert.deepEqual(logSourcesFor(site, { hostedDomain: "quickieweb.com" }), [
    { prefix: "cf/E3FDL9P88XA2K7/", hosts: ["jeffseats.quickieweb.com"] },
  ]);
});

test("logSourcesFor: marketing site counts www.<apex> too", () => {
  const site = { siteId: "www", site: { domain: "quickieweb.com" },
    storage: { driver: "prefix", distributionId: "E3FDL9P88XA2K7" } };
  assert.deepEqual(logSourcesFor(site, { hostedDomain: "quickieweb.com" })[0].hosts,
    ["quickieweb.com", "www.quickieweb.com"]);
});

test("logSourcesFor: self-hosted reads the whole bucket", () => {
  assert.deepEqual(logSourcesFor({ siteId: "x", storage: { driver: "buckets" } }),
    [{ prefix: "", hosts: null }]);
});

// ---------------------------------------------------------------- processLogs
class List { constructor(i) { this.input = i; } }
class Get { constructor(i) { this.input = i; } }

function fakeS3(objects) {
  const calls = [];
  return {
    calls,
    async send(cmd) {
      calls.push(cmd);
      if (cmd instanceof List) {
        const p = cmd.input.Prefix ?? "";
        return { Contents: Object.keys(objects).filter((k) => k.startsWith(p))
          .map((Key) => ({ Key, Size: objects[Key].length })) };
      }
      if (cmd instanceof Get) {
        return { Body: [objects[cmd.input.Key]] };
      }
      throw new Error("unexpected command");
    },
  };
}

function fakeStore() {
  const data = {};
  return {
    data,
    async getJson(k, d) { return k in data ? structuredClone(data[k]) : d; },
    async putJson(k, v) { data[k] = structuredClone(v); },
    async getBuffer() { return null; },
  };
}

const gz = (...lines) => gzipSync(lines.join("\n"));

test("processLogs counts only this site's traffic from a shared folder", async () => {
  const objects = {
    "cf/E3FDL9P88XA2K7/a.gz": gz(line("stuckinawoman.quickieweb.com"), line("jeffseats.quickieweb.com"),
      line("testme.quickieweb.com")),
    "cf/E1IVLQSMM1AGFH/b.gz": gz(line("www.stuckinawoman.com"), line("www.stuckinawoman.com", "/x.html")),
    "cf/EOTHERDIST0000/c.gz": gz(line("www.stuckinawoman.com")),
  };
  const s3 = fakeS3(objects);
  const store = fakeStore();
  const result = await processLogs({
    s3, logBucket: "logs", store, ownHost: "www.stuckinawoman.com",
    sources: logSourcesFor(hostedSite(), { hostedDomain: "quickieweb.com" }),
    sdk: { ListObjectsV2Command: List, GetObjectCommand: Get },
  });
  assert.equal(result.processed, 2, "the unrelated distribution's folder is never read");
  assert.equal(result.foreign, 2, "jeffseats + testme dropped");
  const report = store.data["_internal/stats/daily.json"];
  assert.equal(report.days["2026-11-13"].requests, 3);

  // second run: nothing new
  const again = await processLogs({
    s3, logBucket: "logs", store, ownHost: "www.stuckinawoman.com",
    sources: logSourcesFor(hostedSite(), { hostedDomain: "quickieweb.com" }),
    sdk: { ListObjectsV2Command: List, GetObjectCommand: Get },
  });
  assert.equal(again.processed, 0);
  assert.equal(store.data["_internal/stats/daily.json"].days["2026-11-13"].requests, 3);
});

test("processLogs forgets a processed key only once its object has expired", async () => {
  const objects = { "cf/D/a.gz": gz(line("h.example")), "cf/D/b.gz": gz(line("h.example")) };
  const s3 = fakeS3(objects);
  const store = fakeStore();
  const run = () => processLogs({ s3, logBucket: "logs", store, ownHost: "h.example",
    sources: [{ prefix: "cf/D/", hosts: null }], sdk: { ListObjectsV2Command: List, GetObjectCommand: Get } });
  await run();
  assert.deepEqual(store.data["_internal/stats/metadata.json"].processed.sort(), ["cf/D/a.gz", "cf/D/b.gz"]);
  delete objects["cf/D/a.gz"]; // lifecycle expiry
  await run();
  assert.deepEqual(store.data["_internal/stats/metadata.json"].processed, ["cf/D/b.gz"]);
  assert.equal(store.data["_internal/stats/daily.json"].days["2026-11-13"].requests, 2, "nothing counted twice");
});

test("processLogs refuses a site with no sources rather than reading nothing quietly", async () => {
  await assert.rejects(processLogs({ s3: fakeS3({}), logBucket: "logs", store: fakeStore(),
    ownHost: "h", sources: [], sdk: { ListObjectsV2Command: List, GetObjectCommand: Get } }), /no log sources/);
});

test("log prefix convention", () => {
  assert.equal(logPrefixFor("E1IVLQSMM1AGFH"), "cf/E1IVLQSMM1AGFH/");
});

// ------------------------------------------------------------------- geo
import { loadGeo } from "../admin/lib/stats.mjs";

test("loadGeo: a missing database is looked for again, not cached as missing", async () => {
  let lookups = 0;
  const store = { async getBuffer() { return null; } };
  const fallback = async () => { lookups++; return null; };
  assert.equal((await loadGeo(store, { fallback })).available, false);
  assert.equal((await loadGeo(store, { fallback })).available, false);
  assert.equal(lookups, 2, "second run must try again -- the database may have been uploaded since");
});

test("loadGeo: the site's own database wins; the shared one is only a fallback", async () => {
  let fellBack = false;
  const store = { async getBuffer() { return null; } };
  await loadGeo(store, { fallback: async () => { fellBack = true; return null; } });
  assert.equal(fellBack, true);
});

// Every name the site answers at is "us" in Stats, including its own mirror
// distribution's *.cloudfront.net name (seen as a referrer on stuckinawoman).
test("siteOwnHosts lists every name a hosted site answers at", async () => {
  const { siteOwnHosts, normalizeSite } = await import("../shared/site.mjs");
  const site = normalizeSite({
    siteId: "stuckinawoman",
    site: { title: "S", baseUrl: "https://www.stuckinawoman.com", domain: "www.stuckinawoman.com" },
    storage: {
      driver: "prefix", prefix: "sites/stuckinawoman/", distributionDomain: "d19wnv47n55d38.cloudfront.net",
      mirrorDistributionIds: ["E1IVLQSMM1AGFH"], mirrorDistributionDomains: ["d1s6xp4lvx5dqg.cloudfront.net", "evil.example.com"],
    },
  });
  assert.deepEqual(site.storage.mirrorDistributionDomains, ["d1s6xp4lvx5dqg.cloudfront.net"], "only cloudfront names are kept");
  assert.deepEqual(siteOwnHosts(site, { hostedDomain: "quickieweb.com" }), [
    "www.stuckinawoman.com", "stuckinawoman.quickieweb.com", "d1s6xp4lvx5dqg.cloudfront.net",
  ], "the shared distribution's name is every tenant's, so it is not listed");
});
