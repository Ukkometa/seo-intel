/**
 * lib/concurrency.js — bounded parallel map.
 *
 * The `--live` audit modes fetch one URL per page. Run serially that is a long
 * wall-clock stall on a large site; run unbounded it is a burst of requests at
 * someone's origin. This keeps a fixed number of workers in flight and returns
 * results in input order, so output stays deterministic.
 */

/**
 * @template T, R
 * @param {T[]} items
 * @param {number} limit   Maximum requests in flight.
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>} Results, in the same order as `items`.
 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Default in-flight requests for `--live` audits. */
export const LIVE_CONCURRENCY = 4;
