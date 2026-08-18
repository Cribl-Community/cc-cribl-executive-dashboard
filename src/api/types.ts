/** Shapes returned by the Cribl REST API, narrowed to the fields this app reads. */

declare global {
  interface Window {
    CRIBL_API_URL: string;
    CRIBL_BASE_PATH: string;
    getCriblUser?: () => Promise<CriblUser>;
  }
}

export type CriblUser = {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  initials?: string;
};

/** Paginated envelope used by most collection endpoints. */
export type Paginated<T> = {
  items: T[];
  count: number;
  offset?: number;
  limit?: number;
  totalCount?: number;
};

export type Health = 'Green' | 'Yellow' | 'Red' | 'Unknown';

export type HealthCounts = Partial<Record<Health, number>>;

export type StatusError = {
  message?: string;
  time?: number;
  [key: string]: unknown;
};

export type AggregatedStatus = {
  health: Health;
  /** Per-Worker-Process health tally. Only non-zero statuses are included. */
  healthCounts: HealthCounts;
  /** Unix ms of the last status update. */
  timestamp: number;
  error?: StatusError;
  metrics?: Record<string, unknown>;
  pq?: Record<string, unknown>;
};

/** `GET /m/:gid/system/status/{inputs,outputs}` item. */
export type EntityStatus = {
  id: string;
  type?: string;
  status: AggregatedStatus;
};

/** `GET /m/:gid/system/{inputs,outputs}` item, narrowed. */
export type EntityConfig = {
  id: string;
  type?: string;
  disabled?: boolean;
  environment?: string;
  [key: string]: unknown;
};

/** `GET /master/groups` item, narrowed. */
export type ConfigGroup = {
  id: string;
  name?: string;
  description?: string;
  type?: string;
  isFleet?: boolean;
  isSearch?: boolean;
  onPrem?: boolean;
  workerCount?: number;
  incompatibleWorkerCount?: number;
  deployingWorkerCount?: number;
  estimatedIngestRate?: number;
};

/** `GET /products/stream/workers` item, narrowed. */
export type WorkerNode = {
  id: string;
  group: string;
  status?: string;
  disconnected?: boolean;
  workerProcesses?: number;
  /** Unix ms when the Leader last heard from this node. */
  lastMsgTime?: number;
  firstMsgTime?: number;
  info?: {
    hostname?: string;
    cribl?: { version?: string; distMode?: string };
    [key: string]: unknown;
  };
};

/** `POST /system/metrics/query` response. Leader-scoped: metrics are not group-scoped. */
export type MetricsQueryResponse = {
  results?: MetricsQueryEvent[];
};

/**
 * One aggregation result row. `_time` is Unix *seconds*; split-by dimensions and
 * `.as()` aliases land as sibling fields, so the shape is open by design.
 */
export type MetricsQueryEvent = {
  _time?: number;
  _raw?: string;
  [field: string]: unknown;
};

export type MetricsQueryRequest = {
  earliest?: string | number;
  latest?: string | number;
  where?: string;
  namespace?: string;
  alwaysBounds?: boolean;
  aggs: {
    aggregations: string[];
    splitBys?: string[];
    timeWindowSeconds?: number;
    cumulative?: boolean;
  };
};

/** `POST /system/metrics/enum` response — used by the diagnostics panel. */
export type MetricsEnumResponse = {
  count?: number;
  items?: Array<{
    name: string;
    dims: Array<{ name: string; count: number; values: string[] }>;
  }>;
};

/** `GET /system/licenses/usage` item (on-prem only). */
export type UsageMetrics = {
  startTime: number;
  endTime: number;
  inBytes: number;
  outBytes: number;
  inEvents: number;
  outEvents: number;
  exemptedLicenseInBytes?: number;
  droppedBytes?: number;
};

/** `GET /system/info` item, narrowed. */
export type SystemInfo = {
  distMode?: string;
  version?: string;
  license?: { type?: string; isRegistered?: boolean };
  conf?: { inputs?: number; outputs?: number };
  [key: string]: unknown;
};
