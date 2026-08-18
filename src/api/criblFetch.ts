/**
 * Low-level Cribl API access.
 *
 * The platform intercepts `fetch()` calls to `CRIBL_API_URL` and proxies them
 * through the parent window, injecting auth. We never handle tokens here — we
 * only build URLs, normalise errors, and keep every request cancellable.
 */

export class CriblApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly detail?: string;

  constructor(message: string, path: string, status: number, detail?: string) {
    super(message);
    this.name = 'CriblApiError';
    this.path = path;
    this.status = status;
    this.detail = detail;
  }

  /** True when the failure is a permission problem the admin has to fix. */
  get isAuthz(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** Proxied requests are dropped by the platform after 30s; stay just inside that. */
const REQUEST_TIMEOUT_MS = 28_000;

function apiBase(): string {
  const base = window.CRIBL_API_URL;
  if (!base) {
    throw new CriblApiError(
      'CRIBL_API_URL is not available. This app must run inside Cribl.',
      '',
      0,
    );
  }
  return base.replace(/\/$/, '');
}

type RequestOptions = {
  signal?: AbortSignal;
  method?: 'GET' | 'POST' | 'PUT';
  body?: unknown;
  /** Query parameters; `undefined` values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
};

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${apiBase()}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/**
 * Reads the most useful message out of an error response. Cribl returns
 * `{ status, message }` on most failures but plain text on some.
 */
async function readErrorDetail(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    if (!text) return undefined;
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      return parsed.message ?? parsed.error ?? text.slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return undefined;
  }
}

export async function criblRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { signal, method = 'GET', body, query } = options;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  const signals = signal ? [signal, timeout.signal] : [timeout.signal];

  try {
    const response = await fetch(buildUrl(path, query), {
      method,
      signal: AbortSignal.any(signals),
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new CriblApiError(
        `${method} ${path} failed (${response.status})`,
        path,
        response.status,
        detail,
      );
    }

    if (response.status === 204) return undefined as T;
    // Parsed from text rather than `response.json()`: an empty body is a valid
    // "nothing here" for the KV store, and a body that is not JSON names itself in
    // the error instead of surfacing as a stream failure with no path attached.
    const text = await response.text();
    if (text === '') return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CriblApiError(
        `${method} ${path} returned a body that is not JSON`,
        path,
        response.status,
        text.slice(0, 300),
      );
    }
  } catch (error) {
    if (error instanceof CriblApiError) throw error;
    // The platform's proxied `fetch` rejects a cancelled request with a plain
    // `Error('Aborted')` rather than an `AbortError`, so cancellation is normalised
    // to the standard shape here. Otherwise every caller's `isAbort` guard misses
    // it and a request the app itself cancelled — a StrictMode remount, a changed
    // filter — is reported to the user as a failure.
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (timeout.signal.aborted) {
      throw new CriblApiError(`${method} ${path} timed out`, path, 408);
    }
    throw new CriblApiError(
      `${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      path,
      0,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True when a rejection is just a cancelled request and should be ignored.
 *
 * The bare-message case covers cancellations that reach a caller without passing
 * through `criblRequest` — the platform names them only in the message.
 */
export function isAbort(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' || /^abort(ed)?$/i.test(error.message);
}

/**
 * True when the platform's proxy could not hand back a readable response body.
 *
 * Inside Cribl, reading a KV key that was never written fails this way rather than
 * with a 404: the proxy tries to deserialize a body it never received and rejects
 * with `Failed to execute 'close' on 'ReadableStreamDefaultController': "[object
 * Object]" is not valid JSON`. It says nothing about whether a value exists, so
 * callers that can check existence another way should do that before reporting it.
 */
export function isUnreadableBody(error: unknown): boolean {
  const message =
    error instanceof CriblApiError
      ? `${error.message} ${error.detail ?? ''}`
      : error instanceof Error
        ? error.message
        : '';
  return /is not valid JSON|ReadableStream/i.test(message);
}

/**
 * Runs the same read against many Worker Groups, keeping partial success.
 *
 * Group-scoped endpoints fail independently — one group mid-upgrade should not
 * blank the whole dashboard — so failures are collected, not thrown.
 */
export async function perGroup<T>(
  groupIds: string[],
  read: (groupId: string) => Promise<T>,
): Promise<{ values: Array<{ groupId: string; value: T }>; errors: Array<{ groupId: string; error: unknown }> }> {
  const settled = await Promise.allSettled(groupIds.map((groupId) => read(groupId)));
  const values: Array<{ groupId: string; value: T }> = [];
  const errors: Array<{ groupId: string; error: unknown }> = [];

  settled.forEach((result, index) => {
    const groupId = groupIds[index];
    if (result.status === 'fulfilled') {
      values.push({ groupId, value: result.value });
    } else if (!isAbort(result.reason)) {
      errors.push({ groupId, error: result.reason });
    }
  });

  return { values, errors };
}

/** Human-readable form of any thrown value, for error surfaces. */
export function describeError(error: unknown): string {
  if (error instanceof CriblApiError) {
    if (error.isAuthz) {
      return `${error.message}. The app may be missing an API policy, or your role lacks access.${
        error.detail ? ` (${error.detail})` : ''
      }`;
    }
    return error.detail ? `${error.message}: ${error.detail}` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
