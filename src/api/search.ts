/**
 * Cribl Search job lifecycle.
 *
 * The volume panel reads long-retention internal metrics from the `cribl_metrics`
 * dataset through Cribl Search, rather than the short-retention live metrics store
 * (`/system/metrics/query`), whose ~2-day horizon truncated every long range. Search
 * is asynchronous: submit a job, poll until it finishes, then page the results. All
 * of it goes through the same platform proxy the rest of the app uses, and every
 * search endpoint is addressed under the `default_search` group id — the platform
 * guide requires that exact group for `/search/...` calls.
 */

import { criblRequest, CriblApiError } from './criblFetch.ts';

/** Search endpoints are always addressed under this group id (platform rule). */
const JOBS_PATH = '/m/default_search/search/jobs';

/** One result row: an open bag of fields, the same shape a metrics event has. */
export type SearchRow = Record<string, unknown>;

export type SearchRequest = {
  /** A Cribl Search (Kusto/KQL) query string. */
  query: string;
  /** Unix **seconds**, or a relative expression (`-24h`) the platform resolves. */
  earliest: number | string;
  latest: number | string;
};

/** How often to ask the job whether it has finished. */
const POLL_INTERVAL_MS = 700;
/**
 * A job can outlive a single 30s proxied request because polling is many short
 * requests, not one long one — but it must still not poll forever, so the whole
 * lifecycle is capped here. A 30-day `cribl_metrics` aggregation is expected to
 * finish well inside this; hitting it is a real failure worth surfacing.
 */
const MAX_JOB_MS = 90_000;
/** Result page size. Aggregated rows are few, so one page is usually enough. */
const RESULTS_PAGE = 1000;

const DONE = /^(completed|complete|done|finished|success|succeeded)$/i;
const FAILED = /^(failed|fail|error|errored|canceled|cancelled)$/i;

/**
 * The created job's id. The response is `{ items: [job] }`; the job carries the id
 * used for every follow-up call. Read defensively — the exact envelope is only
 * confirmed against the live platform, not the bundled OpenAPI.
 */
function jobIdFrom(response: unknown): string | undefined {
  const items = (response as { items?: Array<{ id?: unknown }> } | null)?.items;
  const id = Array.isArray(items) ? items[0]?.id : undefined;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * The job's lifecycle state, normalised to a lowercase word. Cribl reports it either
 * as a bare string or nested in a `status` object, so both are unwrapped here.
 */
function jobState(response: unknown): string {
  const job = (response as { items?: Array<Record<string, unknown>> } | null)?.items?.[0];
  if (!job) return '';
  const raw = job.status ?? job.state;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const nested = (raw as { state?: unknown; status?: unknown }).state ?? (raw as { status?: unknown }).status;
    if (typeof nested === 'string') return nested;
  }
  return '';
}

/** One parsed results page: the data rows, plus the page's own summary metadata. */
type ResultsPage = {
  rows: SearchRow[];
  /** The job says it will produce no further pages (a completed job). */
  isFinished: boolean;
  /** Total rows the query matched, when the summary line reports it. */
  totalEventCount?: number;
  /** The body exactly as it came off the wire, for diagnostics. */
  raw: string;
};

/** An object with an events array under one of the keys a JSON envelope might use. */
function arrayField(rec: Record<string, unknown>): SearchRow[] | undefined {
  for (const key of ['results', 'items', 'events'] as const) {
    const value = rec[key];
    if (Array.isArray(value)) return value as SearchRow[];
  }
  return undefined;
}

/**
 * The summary line, not a data row.
 *
 * `/results` is `application/x-ndjson`: one JSON object per line, where one line is a
 * `SearchJobResults` summary (`isFinished`, `job`, the counts) and the rest are the
 * matched rows. The summary is told apart by its `isFinished` boolean — a
 * `cribl_metrics` bucket never carries one.
 */
function isSummaryLine(rec: Record<string, unknown>): boolean {
  return (
    typeof rec.isFinished === 'boolean' &&
    ('job' in rec || 'totalEventCount' in rec || 'persistedEventCount' in rec)
  );
}

/**
 * Parses one results page.
 *
 * Handles both the NDJSON stream the live platform returns and a single JSON object
 * wrapping the rows under `results`/`items`/`events` (what the dev mock and some
 * proxies answer with), so the two paths read identically.
 */
function parseResultsPage(text: string): ResultsPage {
  const rows: SearchRow[] = [];
  let isFinished = false;
  let totalEventCount: number | undefined;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A partial or non-JSON line is skipped rather than failing the whole page.
      continue;
    }
    if (Array.isArray(parsed)) {
      rows.push(...(parsed as SearchRow[]));
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const rec = parsed as Record<string, unknown>;

    const wrapped = arrayField(rec);
    if (wrapped) {
      rows.push(...wrapped);
      if (typeof rec.isFinished === 'boolean') isFinished = rec.isFinished;
      if (typeof rec.totalEventCount === 'number') totalEventCount = rec.totalEventCount;
      continue;
    }
    if (isSummaryLine(rec)) {
      isFinished = rec.isFinished === true;
      if (typeof rec.totalEventCount === 'number') totalEventCount = rec.totalEventCount;
      continue;
    }
    rows.push(rec);
  }

  return { rows, isFinished, totalEventCount, raw: text };
}

/** A cancellable delay that rejects the moment the caller aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

async function pollUntilDone(id: string, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + MAX_JOB_MS;
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const status = await criblRequest<unknown>(`${JOBS_PATH}/${encodeURIComponent(id)}`, { signal });
    const state = jobState(status);
    if (DONE.test(state)) return;
    if (FAILED.test(state)) {
      throw new CriblApiError(`Search job ${state || 'failed'}`, JOBS_PATH, 0);
    }
    if (Date.now() > deadline) {
      throw new CriblApiError('Search job did not finish in time', JOBS_PATH, 408);
    }
    await delay(POLL_INTERVAL_MS, signal);
  }
}

/**
 * Hard cap on pages to fetch, so a backend that never returns a short page cannot
 * spin forever. Aggregated `cribl_metrics` rows are few, so this is far above need.
 */
const MAX_RESULT_PAGES = 200;

/** The rows of a search, plus the first page's raw body for diagnostics. */
type CollectedResults = { rows: SearchRow[]; rawFirstPage: string };

async function collectResults(id: string, signal?: AbortSignal): Promise<CollectedResults> {
  const rows: SearchRow[] = [];
  let rawFirstPage = '';
  let offset = 0;
  for (let page = 0; page < MAX_RESULT_PAGES; page += 1) {
    const text = await criblRequest<string>(`${JOBS_PATH}/${encodeURIComponent(id)}/results`, {
      // `limit` requires `offset` on the real API, so both always go together.
      query: { limit: RESULTS_PAGE, offset },
      responseType: 'text',
      signal,
    });
    const parsed = parseResultsPage(text ?? '');
    if (page === 0) rawFirstPage = parsed.raw;
    rows.push(...parsed.rows);
    // Stop on a short or empty page — offset paging is done. `isFinished` is not a
    // stop signal on its own: a completed job reports it on the very first page even
    // when more rows remain to be paged through by offset.
    if (parsed.rows.length < RESULTS_PAGE) break;
    offset += parsed.rows.length;
  }
  return { rows, rawFirstPage };
}

/** Best-effort cleanup of an abandoned job; failure to cancel is not worth raising. */
function cancelJob(id: string): void {
  void criblRequest<unknown>(`${JOBS_PATH}/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  }).catch(() => undefined);
}

/** A completed search: its rows and the first results page verbatim. */
export type SearchOutcome = { rows: SearchRow[]; rawFirstPage: string };

/**
 * Runs one search to completion, returning the rows and the raw first page.
 *
 * `earliest`/`latest` go on the wire as the API documents them — a relative string
 * (`-24h`) or **Unix seconds**, never milliseconds: the field is read as seconds, so
 * a millisecond value lands tens of thousands of years in the future and the job
 * scans an empty window. Callers resolve the range to seconds before handing it here.
 */
export async function runSearchDetailed(
  request: SearchRequest,
  signal?: AbortSignal,
): Promise<SearchOutcome> {
  const created = await criblRequest<unknown>(JOBS_PATH, {
    method: 'POST',
    body: { query: request.query, earliest: request.earliest, latest: request.latest },
    signal,
  });
  const id = jobIdFrom(created);
  if (!id) {
    throw new CriblApiError(
      'Search job was not created',
      JOBS_PATH,
      0,
      JSON.stringify(created).slice(0, 300),
    );
  }
  try {
    await pollUntilDone(id, signal);
    return await collectResults(id, signal);
  } catch (error) {
    // A cancelled load leaves a running job behind; free it. A finished job needs no
    // cleanup, so only cancel on the abort path.
    if (signal?.aborted) cancelJob(id);
    throw error;
  }
}

/** Runs one search to completion and returns every result row. */
export async function runSearch(request: SearchRequest, signal?: AbortSignal): Promise<SearchRow[]> {
  return (await runSearchDetailed(request, signal)).rows;
}
