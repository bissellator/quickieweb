// The hourly stats run's loop, kept apart from server.mjs so it can be tested
// without the AWS SDK. server.mjs's processAllStats gathers the sites and hands
// each one's work here as a function.
//
// Launch, do whatever log files are still waiting, stop. A run with nothing new
// reads each site's listing and writes nothing; a run is idempotent because each
// site records the log files it has folded in (processLogs' `processed`).
//
// Sites run concurrently, CONCURRENCY at a time: each writes only its own stats
// keys, so they cannot step on each other. A batch is at most 300 log files; a
// site with more waiting (`truncated`) goes to the back of the queue, so one
// big backlog never holds up the other sites. Least recently processed first.
//
// One site failing does not stop the others; the run still ends in an error
// naming every failure, so it shows in the function's Errors metric and logs.
// No batch starts in the last stretch of the timeout, which is sized to outlast
// one batch (300 files took ~40s). Whatever is left is picked up next hour.

export const STOP_STARTING_MS = 90_000;
export const CONCURRENCY = 4;

/**
 * @param {{ siteId: string, lastRun: string|null, run: () => Promise<object> }[]} jobs
 * @param {{ remainingMs?: () => number, log?: Console, concurrency?: number }} opts
 * @returns {{ done: string[], deferred: string[], behind: string[] }}
 *   done: sites that ran at least once; deferred: sites never started;
 *   behind: sites that ran but still have files waiting. Throws if any site failed.
 */
export async function runStatsJobs(jobs, { remainingMs = () => Infinity, log = console, concurrency = CONCURRENCY } = {}) {
  const queue = [...jobs].sort((a, b) => (a.lastRun ?? "").localeCompare(b.lastRun ?? ""));
  const done = new Set(), failed = [], deferred = [], behind = [];
  const batches = new Map();

  const worker = async () => {
    for (let job; (job = queue.shift()); ) {
      if (remainingMs() < STOP_STARTING_MS) {
        (done.has(job.siteId) ? behind : deferred).push(job.siteId);
        continue;
      }
      const n = (batches.get(job.siteId) ?? 0) + 1;
      batches.set(job.siteId, n);
      try {
        const r = await job.run();
        done.add(job.siteId);
        log.log(`[stats] ${job.siteId} (batch ${n}): ${r.processed} file(s), ${r.foreign ?? 0} foreign` +
          (r.truncated ? ", more waiting" : ""));
        if (r.truncated) queue.push(job);
      } catch (err) {
        failed.push(job.siteId);
        log.error(`[stats] ${job.siteId} failed:`, err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));

  if (deferred.length) log.log(`[stats] out of time, not started: ${deferred.join(", ")}`);
  if (behind.length) log.log(`[stats] out of time, still catching up: ${behind.join(", ")}`);
  if (failed.length) {
    throw new Error(`Scheduled stats failed for: ${failed.join(", ")} (done: ${done.size})`);
  }
  return { done: [...done], deferred, behind };
}
