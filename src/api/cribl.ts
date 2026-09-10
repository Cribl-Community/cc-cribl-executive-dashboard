/**
 * Typed Cribl endpoint reads.
 *
 * Group-scoped endpoints take the `/m/:gid` prefix; everything else is global.
 * Collection reads pass a generous `limit`/`offset` page because the defaults
 * paginate at 20 and an executive view needs the whole inventory, not page one.
 */

import { criblRequest } from './criblFetch.ts';
import type {
  ConfigGroup,
  EntityConfig,
  EntityStatus,
  Paginated,
  SystemInfo,
  UsageMetrics,
  WorkerNode,
} from './types.ts';

/**
 * One page big enough to hold a whole deployment's inventory.
 *
 * `offset` is not optional decoration: the API rejects a `limit` without one with
 * `400 missing 'offset' parameter`, so the two always travel together.
 */
const PAGE_QUERY = { limit: 1000, offset: 0 } as const;

function group(groupId: string, path: string): string {
  return `/m/${encodeURIComponent(groupId)}${path}`;
}

/** Stream Worker Groups. Search/Lake/Edge groups are excluded by the caller. */
export async function listGroups(signal?: AbortSignal): Promise<ConfigGroup[]> {
  const response = await criblRequest<Paginated<ConfigGroup>>('/master/groups', {
    signal,
    query: { product: 'stream', ...PAGE_QUERY },
  });
  return response.items ?? [];
}

/** Worker Nodes across all groups, with connection state and last heartbeat. */
export async function listWorkerNodes(signal?: AbortSignal): Promise<WorkerNode[]> {
  const response = await criblRequest<Paginated<WorkerNode>>('/products/stream/workers', {
    signal,
    query: { ...PAGE_QUERY },
  });
  return response.items ?? [];
}

export async function listInputs(groupId: string, signal?: AbortSignal): Promise<EntityConfig[]> {
  const response = await criblRequest<Paginated<EntityConfig>>(group(groupId, '/system/inputs'), {
    signal,
    query: { ...PAGE_QUERY },
  });
  return response.items ?? [];
}

export async function listOutputs(groupId: string, signal?: AbortSignal): Promise<EntityConfig[]> {
  const response = await criblRequest<Paginated<EntityConfig>>(group(groupId, '/system/outputs'), {
    signal,
    query: { ...PAGE_QUERY },
  });
  return response.items ?? [];
}

export async function inputStatus(groupId: string, signal?: AbortSignal): Promise<EntityStatus[]> {
  const response = await criblRequest<Paginated<EntityStatus>>(
    group(groupId, '/system/status/inputs'),
    // No `type: true`: that prefixes each id with its type, which would no longer
    // match the plain ids from /system/inputs. The type arrives as its own field.
    { signal, query: { ...PAGE_QUERY } },
  );
  return response.items ?? [];
}

export async function outputStatus(groupId: string, signal?: AbortSignal): Promise<EntityStatus[]> {
  const response = await criblRequest<Paginated<EntityStatus>>(
    group(groupId, '/system/status/outputs'),
    // No `type: true`: that prefixes each id with its type, which would no longer
    // match the plain ids from /system/inputs. The type arrives as its own field.
    { signal, query: { ...PAGE_QUERY } },
  );
  return response.items ?? [];
}

export async function systemInfo(signal?: AbortSignal): Promise<SystemInfo | undefined> {
  const response = await criblRequest<Paginated<SystemInfo>>('/system/info', { signal });
  return response.items?.[0];
}

/**
 * License usage totals. Unavailable on Cribl.Cloud (403) and on deployments whose
 * plan restricts license APIs, so callers treat absence as normal.
 */
export async function licenseUsage(signal?: AbortSignal): Promise<UsageMetrics | undefined> {
  const response = await criblRequest<{ items?: UsageMetrics[] }>('/system/licenses/usage', {
    signal,
  });
  return response.items?.[0];
}
