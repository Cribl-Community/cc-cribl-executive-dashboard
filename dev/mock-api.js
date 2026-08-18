/*
 * DEV HARNESS ONLY — never imported by the app and never shipped in `dist`.
 *
 * The app cannot run outside Cribl, so this file stands in for the platform while
 * developing: it is injected by the sanctioned `?init=` hook in vite.config.ts,
 * which is the one place allowed to touch the platform globals. Run it with:
 *
 *   npm run dev
 *   open http://localhost:5173/?init=/dev/mock-api.js
 *
 * Add `#dark` to the URL to preview dark mode. Every response shape here mirrors
 * the Cribl API as documented; it is a fixture, not a spec.
 */
(function () {
  var API = 'https://mock.cribl.local/api/v1';
  window.CRIBL_API_URL = API;
  window.CRIBL_BASE_PATH = '/';

  var DAY = 86400000;
  var now = Date.now();

  if (location.hash.indexOf('dark') !== -1) document.documentElement.classList.add('dark');

  var GROUPS = [
    { id: 'default', name: 'Default Stream group' },
    { id: 'prod-edge', name: 'Production edge' },
    { id: 'eu-west', name: 'EU West' },
  ];

  var WORKERS = [
    { id: 'w-1', group: 'default', workerProcesses: 4, lastMsgTime: now - 4000, info: { hostname: 'stream-01', cribl: { version: '4.9.2' } } },
    { id: 'w-2', group: 'default', workerProcesses: 4, lastMsgTime: now - 6000, info: { hostname: 'stream-02', cribl: { version: '4.9.2' } } },
    { id: 'w-3', group: 'prod-edge', workerProcesses: 8, lastMsgTime: now - 3000, info: { hostname: 'edge-01', cribl: { version: '4.9.2' } } },
    { id: 'w-4', group: 'eu-west', workerProcesses: 2, lastMsgTime: now - 3 * 3600000, disconnected: true, info: { hostname: 'eu-01', cribl: { version: '4.8.1' } } },
  ];

  var SOURCES = {
    default: ['in_syslog', 'in_http', 'in_splunk_tcp', 'in_datagen'],
    'prod-edge': ['in_kafka', 'in_otel', 'in_syslog'],
    'eu-west': ['in_s3', 'in_azure_blob'],
  };

  var DESTINATIONS = {
    default: ['out_splunk', 'out_s3_archive', 'out_devnull'],
    'prod-edge': ['out_elastic', 'out_s3_archive'],
    'eu-west': ['out_snowflake'],
  };

  // Green everywhere except these: partially green, all red, or reporting nothing.
  var DEGRADED = { in_datagen: 'partial', out_elastic: 'red', in_azure_blob: 'none', out_snowflake: 'partial' };
  var DISABLED = { in_splunk_tcp: true };

  function statusFor(id, processes) {
    var mode = DEGRADED[id];
    if (mode === 'none') return undefined;
    if (mode === 'red') {
      return { health: 'Red', healthCounts: { Red: processes }, timestamp: now - 42 * 60000, error: { message: 'Connection refused by upstream' } };
    }
    if (mode === 'partial') {
      return { health: 'Yellow', healthCounts: { Green: processes - 1, Yellow: 1 }, timestamp: now - 90000 };
    }
    return { health: 'Green', healthCounts: { Green: processes }, timestamp: now - 15000 };
  }

  function entityConfigs(ids) {
    return ids.map(function (id) {
      return { id: id, type: id.split('_')[1] || 'unknown', disabled: DISABLED[id] === true };
    });
  }

  function entityStatuses(groupId, ids) {
    var processes = groupId === 'prod-edge' ? 8 : 4;
    return ids
      .map(function (id) {
        var status = statusFor(id, processes);
        return status ? { id: id, type: id.split('_')[1] || 'unknown', status: status } : null;
      })
      .filter(Boolean);
  }

  /** Traffic at one instant: a daily cycle, peaking mid-afternoon. */
  function wave(at) {
    return 0.6 + 0.4 * Math.sin(((new Date(at).getHours() - 3) / 24) * 2 * Math.PI);
  }

  /**
   * Mean traffic across a bucket, sampled hourly.
   *
   * A real metrics backend sums what happened inside the bucket, so a daily bucket
   * and 24 hourly buckets describe the same day. Sampling the curve once per bucket
   * would instead make every daily figure differ from the same day in hourly form,
   * which shows up as a fake deviation from the 7-day baseline.
   */
  function meanWave(t, step) {
    var samples = Math.max(1, Math.min(24, Math.round(step / 3600000)));
    var total = 0;
    for (var s = 0; s < samples; s += 1) total += wave(t + (step * s) / samples);
    return total / samples;
  }

  /** A slow per-entity drift, so some entities sit above their baseline and some below. */
  function drift(index, t) {
    return 1 + 0.3 * Math.sin(Math.floor(t / DAY) * 0.9 + index * 2.1);
  }

  /**
   * Buckets shaped like real traffic: a daily cycle, per-entity scale, slow drift.
   *
   * Rows carry `__worker_group` because the real metrics store is Leader-wide, not
   * group-scoped: one query returns every group's traffic and the app attributes it
   * from this dimension.
   */
  function series(entries, earliest, latest, bucketSeconds, dimension, scale) {
    var start = typeof earliest === 'number' ? earliest : now + parseRelative(earliest);
    var end = typeof latest === 'number' ? latest : now;
    var step = bucketSeconds * 1000;
    var results = [];
    for (var t = Math.floor(start / step) * step; t <= end; t += step) {
      var level = meanWave(t, step);
      for (var i = 0; i < entries.length; i += 1) {
        var event = {
          _time: Math.floor(t / 1000),
          bytes: Math.round(scale * level * drift(i, t) * (i + 1) * (bucketSeconds / 60)),
        };
        if (dimension) event[dimension] = entries[i].id + ':' + entries[i].id + ':tcp';
        // Omit the dimension with `#nogroupdim` in the URL, to preview the app's
        // fallback when a deployment names it something else.
        if (location.hash.indexOf('nogroupdim') === -1) event.__worker_group = entries[i].group;
        results.push(event);
      }
    }
    return results;
  }

  /**
   * With `#noalias` in the URL, returns the aggregated number under the expression
   * name instead of the `.as("bytes")` alias — the shape that produced "every
   * request succeeded, every figure 0 B" in a real deployment.
   */
  function renameValue(results, expression) {
    if (location.hash.indexOf('noalias') === -1) return results;
    var field = expression.replace(/\.as\([^)]*\)$/, '').replace(/"/g, '');
    return results.map(function (event) {
      var copy = {};
      Object.keys(event).forEach(function (key) {
        if (key === 'bytes') copy[field] = event[key];
        else copy[key] = event[key];
      });
      return copy;
    });
  }

  /** Every source or destination in the deployment, tagged with its group. */
  function allEntities(byGroup) {
    var entries = [];
    Object.keys(byGroup).forEach(function (groupId) {
      byGroup[groupId].forEach(function (id) {
        entries.push({ id: id, group: groupId });
      });
    });
    return entries;
  }

  function parseRelative(expression) {
    var match = /^-(\d+)([mhd])$/.exec(String(expression));
    if (!match) return -DAY;
    var value = Number(match[1]);
    var unit = { m: 60000, h: 3600000, d: DAY }[match[2]];
    return -value * unit;
  }

  // Starts empty, so the app's own defaults are what renders. Add `#seed` to the URL
  // to preview the configured state — aliases, exclusions, and a live credit term.
  var kv = {};
  // `#kvunreadable`: a key that exists but cannot be read, to prove the app tells
  // that apart from a first run and says so instead of silently using defaults.
  if (location.hash.indexOf('kvunreadable') !== -1) {
    kv['/kvstore/cc-cribl-executive-dashboard/settings/v1'] = { deviationThreshold: 0.25 };
  }

  if (location.hash.indexOf('seed') !== -1) {
    kv['/kvstore/cc-cribl-executive-dashboard/settings/v1'] = {
      groupAliases: { default: 'Core Platform', 'prod-edge': 'Retail Edge' },
      excludedSourceIds: ['in_datagen'],
      excludedDestinationIds: [],
      deviationThreshold: 0.2,
      creditModel: {
        committedCredits: 40000,
        creditsPerGb: 1,
        termStart: now - 200 * DAY,
        termEnd: now + 165 * DAY,
      },
      metricNames: {
        inBytes: 'total.in_bytes',
        outBytes: 'total.out_bytes',
        inputDim: 'input',
        outputDim: 'output',
      },
    };
  }

  function json(body, status) {
    return new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function route(path, method, body) {
    var groupMatch = /^\/m\/([^/]+)(\/.*)$/.exec(path);
    var groupId = groupMatch ? decodeURIComponent(groupMatch[1]) : undefined;
    var rest = groupMatch ? groupMatch[2] : path;

    if (path === '/master/groups') return json({ items: GROUPS, count: GROUPS.length });
    if (path === '/products/stream/workers') return json({ items: WORKERS, count: WORKERS.length });

    if (groupId && rest === '/system/inputs') return json({ items: entityConfigs(SOURCES[groupId] || []) });
    if (groupId && rest === '/system/outputs') return json({ items: entityConfigs(DESTINATIONS[groupId] || []) });
    if (groupId && rest === '/system/status/inputs') {
      // One group always fails, to exercise the partial-success path.
      if (groupId === 'eu-west') return json({ message: 'Worker Group is unreachable' }, 503);
      return json({ items: entityStatuses(groupId, SOURCES[groupId] || []) });
    }
    if (groupId && rest === '/system/status/outputs') return json({ items: entityStatuses(groupId, DESTINATIONS[groupId] || []) });

    // Metrics are Leader-level. A group-prefixed path is what the real API rejects,
    // so it is rejected here too — with the same 404 body Cribl returns.
    if (groupId && rest.indexOf('/system/metrics/') === 0) {
      return new Response(
        '<!DOCTYPE html><html><body><pre>Cannot POST /api/v1' + rest + '</pre></body></html>',
        { status: 404, headers: { 'Content-Type': 'text/html' } },
      );
    }

    if (path === '/system/metrics/query') {
      var aggs = (body && body.aggs) || {};
      var splitBys = aggs.splitBys || [];
      var expression = String((aggs.aggregations && aggs.aggregations[0]) || '');
      var isIngress = expression.indexOf('in_bytes') !== -1;
      // The Worker Group split is always present; an entity split may not be.
      var dimension = splitBys.filter(function (dim) { return dim !== '__worker_group'; })[0] || '';
      // `#norelative` answers a relative time range with an empty 200, the way a
      // deployment that does not resolve `-1h` would; `#nodata` empties every query.
      var relative = typeof body.earliest === 'string' || typeof body.latest === 'string';
      if (location.hash.indexOf('nodata') !== -1) return json({ results: [] });
      if (relative && location.hash.indexOf('norelative') !== -1) return json({ results: [] });
      var entries = allEntities(isIngress ? SOURCES : DESTINATIONS);
      var results = series(entries, body.earliest, body.latest, aggs.timeWindowSeconds || 3600, dimension, isIngress ? 90e6 : 70e6);
      return json({ results: renameValue(results, expression) });
    }

    if (path === '/system/metrics/enum') {
      var groupDim = { name: '__worker_group', count: GROUPS.length, values: GROUPS.map(function (g) { return g.id; }) };
      var sourceDim = { name: 'input', count: 9, values: allEntities(SOURCES).map(function (e) { return e.id; }) };
      var destDim = { name: 'output', count: 6, values: allEntities(DESTINATIONS).map(function (e) { return e.id; }) };
      var items = [
        { name: 'total.in_bytes', dims: [sourceDim, groupDim] },
        { name: 'total.out_bytes', dims: [destDim, groupDim] },
        { name: 'total.in_events', dims: [sourceDim, groupDim] },
      ];
      // The real endpoint treats `metricNameFilter` as a regular expression.
      if (body && typeof body.metricNameFilter === 'string') {
        var pattern = new RegExp(body.metricNameFilter);
        items = items.filter(function (item) { return pattern.test(item.name); });
      }
      return json({ items: items });
    }

    if (path === '/kvstore/keys') {
      var prefix = '/kvstore/' + ((body && body.prefix) || '');
      return json({
        items: Object.keys(kv)
          .filter(function (stored) { return stored.indexOf(prefix) === 0; })
          .map(function (stored) { return stored.slice('/kvstore/'.length); }),
      });
    }

    if (path.indexOf('/kvstore/') === 0) {
      if (method === 'PUT') {
        kv[path] = body;
        return json({ status: 'ok' });
      }
      if (method === 'DELETE') {
        delete kv[path];
        return json({ status: 'ok' });
      }
      // Reading a key that was never written is what the platform's proxy cannot
      // deserialize, so the mock reproduces that rejection verbatim rather than the
      // clean 404 it used to return — otherwise the first-run path only breaks in
      // Cribl. `#kv404` restores the 404, for the deployments that answer that way.
      if (kv[path] === undefined || location.hash.indexOf('kvunreadable') !== -1) {
        if (location.hash.indexOf('kv404') !== -1) return json({ message: 'not found' }, 404);
        throw new Error(
          'Failed to execute \'close\' on \'ReadableStreamDefaultController\': "[object Object]" is not valid JSON',
        );
      }
      return json(kv[path]);
    }

    return json({ message: 'mock: no route for ' + method + ' ' + path }, 404);
  }

  var nativeFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input.url;
    if (url.indexOf(API) !== 0) return nativeFetch(input, init);
    var withoutBase = url.slice(API.length);
    var path = withoutBase.split('?')[0];
    var query = new URLSearchParams(withoutBase.split('?')[1] || '');
    var method = (init && init.method) || 'GET';

    // The real API enforces this pair, and only rejecting it here catches the
    // mistake in dev rather than after a deploy.
    if (query.has('limit') && !query.has('offset')) {
      return Promise.resolve(
        json({ message: "missing 'offset' parameter, 'offset' is required when 'limit' is provided" }, 400),
      );
    }

    var body = init && init.body ? JSON.parse(init.body) : undefined;
    var signal = init && init.signal;
    // A small delay so loading states are actually visible.
    return new Promise(function (resolve, reject) {
      // Cancellation is rejected the way the platform's proxied fetch rejects it —
      // a plain `Error('Aborted')`, not an `AbortError`. Honouring the signal here
      // is what makes a missed `isAbort` guard visible in dev, where React's
      // StrictMode cancels the first run of every effect.
      var fail = function () { reject(new Error('Aborted')); };
      if (signal && signal.aborted) return fail();
      if (signal) signal.addEventListener('abort', fail, { once: true });
      setTimeout(function () {
        if (signal && signal.aborted) return;
        // A route may throw to imitate a proxy that rejects instead of responding.
        try {
          resolve(route(path, method, body));
        } catch (error) {
          reject(error);
        }
      }, 120);
    });
  };

  console.info('[mock-api] Cribl API mocked at', API);
})();
