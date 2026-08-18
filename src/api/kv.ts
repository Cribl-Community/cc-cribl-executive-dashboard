/**
 * App-scoped key-value store.
 *
 * Browser storage is unreliable inside the sandboxed iframe, so every persisted
 * preference goes here. The proxy scopes these paths to this app automatically.
 */

import { criblRequest, CriblApiError, isUnreadableBody } from './criblFetch.ts';

const PREFIX = 'cc-cribl-executive-dashboard';

export function kvPath(key: string): string {
  return `/kvstore/${PREFIX}/${key}`;
}

/** Keys under a prefix, app-scoped. Used to tell "absent" from "unreadable". */
export async function kvList(prefix: string, signal?: AbortSignal): Promise<string[]> {
  const response = await criblRequest<unknown>('/kvstore/keys', {
    method: 'POST',
    body: { prefix: `${PREFIX}/${prefix}` },
    signal,
  });
  // The list response shape is not in openapi.json, so it is read defensively: a
  // bare array or a wrapper around one both mean the same thing here.
  const container = response as { items?: unknown; keys?: unknown } | null;
  const raw = Array.isArray(response)
    ? response
    : Array.isArray(container?.items)
      ? container.items
      : Array.isArray(container?.keys)
        ? container.keys
        : [];
  return raw
    .map((entry) =>
      typeof entry === 'string' ? entry : String((entry as { key?: unknown })?.key ?? ''),
    )
    .filter(Boolean);
}

/**
 * Reads a key, returning `undefined` when it has never been written.
 *
 * A missing key is the normal first-run state rather than an error worth
 * surfacing, and the platform signals it two ways: a clean 404, or a rejection
 * from the proxy because there was no body to deserialize (`isUnreadableBody`).
 * The second is ambiguous — a stored value that genuinely cannot be read looks
 * identical — so it is settled by listing the keys. If the key is absent this is a
 * first run and defaults are correct; if it *is* there, the read really did fail,
 * and the caller must hear about it rather than quietly run on defaults and
 * overwrite the stored value on the next save.
 */
export async function kvGet<T>(key: string, signal?: AbortSignal): Promise<T | undefined> {
  try {
    return await criblRequest<T>(kvPath(key), { signal });
  } catch (error) {
    if (error instanceof CriblApiError && error.status === 404) return undefined;
    if (!isUnreadableBody(error)) throw error;
    // A failure to list is itself a real failure, so it propagates: better the
    // original read error than an assumption that nothing was ever saved.
    const keys = await kvList(key, signal);
    const exists = keys.some(
      (entry) => entry === `${PREFIX}/${key}` || entry === key || entry.endsWith(`/${key}`),
    );
    if (exists) throw error;
    return undefined;
  }
}

export async function kvSet<T>(key: string, value: T, signal?: AbortSignal): Promise<void> {
  await criblRequest<unknown>(kvPath(key), { method: 'PUT', body: value, signal });
}
