// The hourly stats run (admin/lib/stats-schedule.mjs): every site with logs is
// processed, one site's failure neither stops the rest nor goes unreported, and
// a run near its timeout stops starting sites instead of being killed mid-site.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runStatsJobs, STOP_STARTING_MS } from "../admin/lib/stats-schedule.mjs";

const quiet = { log() {}, error() {} };
const job = (siteId, lastRun, ran, result = { processed: 1 }) =>
  ({ siteId, lastRun, run: async () => { ran.push(siteId); return result; } });

test("least recently processed site goes first; never-run sites before all", async () => {
  const ran = [];
  const out = await runStatsJobs([
    job("b", "2026-11-14T10:00:00Z", ran), job("new", null, ran), job("a", "2026-11-14T09:00:00Z", ran),
  ], { log: quiet });
  assert.deepEqual(ran, ["new", "a", "b"]);
  assert.deepEqual(out, { done: ["new", "a", "b"], deferred: [], behind: [] });
});

test("one failing site does not stop the others, and the run still fails loudly", async () => {
  const ran = [];
  const jobs = [
    job("a", "1", ran),
    { siteId: "broken", lastRun: "2", run: async () => { throw new Error("AccessDenied"); } },
    job("c", "3", ran),
  ];
  await assert.rejects(runStatsJobs(jobs, { log: quiet }), /failed for: broken \(done: 2\)/);
  assert.deepEqual(ran, ["a", "c"]);
});

test("near the timeout, no new site is started; leftovers are reported as deferred", async () => {
  const ran = [];
  let left = STOP_STARTING_MS + 5_000;
  const jobs = ["a", "b", "c"].map((id, i) => ({
    siteId: id, lastRun: String(i),
    run: async () => { ran.push(id); left -= 10_000; return { processed: 0 }; },
  }));
  const out = await runStatsJobs(jobs, { remainingMs: () => left, log: quiet });
  assert.deepEqual(ran, ["a"]);
  assert.deepEqual(out.deferred, ["b", "c"]);
});

test("a backlogged site goes to the back of the queue, behind sites still waiting", async () => {
  const ran = [];
  let backlog = 2;   // "big" needs three batches
  const jobs = [
    { siteId: "big", lastRun: "1", run: async () => { ran.push("big"); return { processed: 300, truncated: backlog-- > 0 }; } },
    job("small", "2", ran),
  ];
  const out = await runStatsJobs(jobs, { log: quiet, concurrency: 1 });
  assert.deepEqual(ran, ["big", "small", "big", "big"]);
  assert.deepEqual(out, { done: ["big", "small"], deferred: [], behind: [] });
});

test("a site still catching up when time runs short is reported as behind, not deferred", async () => {
  let left = STOP_STARTING_MS + 5_000;
  const jobs = [{ siteId: "big", lastRun: "1",
    run: async () => { left -= 10_000; return { processed: 300, truncated: true }; } }];
  const out = await runStatsJobs(jobs, { remainingMs: () => left, log: quiet });
  assert.deepEqual(out, { done: ["big"], deferred: [], behind: ["big"] });
});

test("sites run side by side, up to the concurrency limit", async () => {
  let active = 0, peak = 0;
  const jobs = ["a", "b", "c", "d", "e", "f"].map((id, i) => ({ siteId: id, lastRun: String(i),
    run: async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { processed: 1 };
    } }));
  const out = await runStatsJobs(jobs, { log: quiet, concurrency: 4 });
  assert.equal(peak, 4);
  assert.equal(out.done.length, 6);
});
