/**
 * A short-lived, app-scoped cache for Cribl Search results.
 *
 * Cribl Search bills by data scanned, and this dashboard reloads on every filter or
 * range change (and on a wall monitor, on a human pressing refresh). Without a cache,
 * a 30-day query re-scans the dataset each time. Results are cached in the app KV
 * store — shared across every user and session of the app, which is the point: the
 * queries carry no per-user parameters (Worker Group scoping is applied client-side),
 * so one cached result set serves everyone and the scan happens once per TTL.
 *
 * The cache is best-effort. A read or write failure never fails the load; it just
 * means a live search, so a broken cache degrades to the uncached behaviour.
 */

import { isAbort } from './criblFetch.ts';
import { kvGet, kvSet } from './kv.ts';
import { runSearch, type SearchRequest, type SearchRow } from './search.ts';

const CACHE_PREFIX = 'cache/search';
/** How long a cached result set stays fresh. */
const TTL_MS = 5 * 60 * 1000;

type CacheEntry = { fetchedAt: number; rows: SearchRow[] };

/**
 * A short, path-safe key from an arbitrary string (djb2). The cache key is the
 * *logical* request — the query text plus the relative range — so `-7d`/`now`
 * resolves to the same key on every load even though the absolute window shifts.
 */
function hash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 33) ^ input.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

/**
 * Runs a search, returning a cached result set when one is fresh.
 *
 * `cacheKey` must capture everything that changes the result — the query already
 * encodes the metric, split-bys, and bucket size, so the relative range is all that
 * needs adding. `force` skips the read (not the write), so a manual refresh always
 * re-scans and then repopulates the cache for the next automatic load.
 */
export async function cachedSearch(
  cacheKey: string,
  request: SearchRequest,
  force: boolean,
  signal?: AbortSignal,
): Promise<SearchRow[]> {
  const key = `${CACHE_PREFIX}/${hash(cacheKey)}`;

  if (!force) {
    try {
      const entry = await kvGet<CacheEntry>(key, signal);
      if (entry && Array.isArray(entry.rows) && Date.now() - entry.fetchedAt < TTL_MS) {
        return entry.rows;
      }
    } catch (error) {
      if (isAbort(error)) throw error;
      // A cache miss or unreadable entry is not a failure — fall through to a live search.
    }
  }

  const rows = await runSearch(request, signal);

  try {
    await kvSet<CacheEntry>(key, { fetchedAt: Date.now(), rows }, signal);
  } catch (error) {
    if (isAbort(error)) throw error;
    // Best-effort: a write failure only costs the next load a cache hit.
  }

  return rows;
}
