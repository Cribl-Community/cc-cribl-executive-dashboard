# Cribl Executive Dashboard

A Cribl App Platform app: one screen answering "is the deployment healthy, is volume normal, and
are we on track against our credit commit?" for an executive audience. Dark-only, built for a wall
monitor.

The app cannot run outside Cribl — the platform injects `window.CRIBL_API_URL` and proxies every
`fetch()` — so there are two ways to develop it, below.

## Develop against the mock

```sh
npm run dev
open 'http://localhost:5173/?init=/dev/mock-api.js'
```

`dev/mock-api.js` stands in for the platform. It is injected by the `?init=` hook in
`vite.config.ts`, which is the only place allowed to touch the platform globals; it is never
imported by the app and never lands in `dist`. Its KV store is in-memory per page load, so a
reload discards anything you saved.

Append a URL hash to preview a specific state or failure:

| Hash | What it does |
|---|---|
| `#seed` | Pre-seeded settings: Worker Group aliases, an excluded source, a live credit term |
| `#dark` | Adds `.dark` to `<html>` (Cloud does this for you) |
| `#kvunreadable` | Settings key exists but cannot be read — exercises the Diagnostics warning |
| `#kv404` | KV answers a missing key with a clean 404 instead of the proxy's JSON error |
| `#nodata` | Every metrics query returns an empty 200 |
| `#norelative` | Only *relative* time ranges (`-1h`) return empty — the real bug that produced 0 B |
| `#noalias` | Metrics return the aggregate under the expression name, not the `bytes` alias |
| `#nogroupdim` | Omits the `__worker_group` dimension, to see the attribution fallback |

## Verify in Cribl Cloud

The mock is a fixture, not a spec — most real bugs in this app (a 400 on `/master/groups`, a 404 on
`system/metrics/query`, unreadable KV settings, 0 B volume totals) only appeared against a live
Leader. So verify there before shipping:

1. `npm run dev` — it must be on **port 5173**; that is where the Cloud app registration points.
2. Load the app in Cribl Cloud. Cloud fetches it from `http://localhost:5173` and appends its own
   `?init=…/init.js?apiUrl=…`, which supplies the real API URL and auth.
3. Watch the **Diagnostics** panel — every request the dashboard made, grouped by Worker Group,
   with the failures verbatim. That is the first place to look when a figure is empty.

`vite.config.ts` caches the **first** `init` URL it sees in module scope, so one server cannot
serve both Cloud and a second browser. For your own screenshots or automation, leave 5173 alone and
start a second server:

```sh
npx vite --port 5174 --strictPort
```

## Check and ship

```sh
npx tsc -b            # types
npx oxlint src dev    # lint
npx vite build        # production build
npm run package       # build + archive, for upload to Cloud
```

`npm run package` **bumps the version** — patch by default, so `1.0.1` → `1.0.2`. Use
`-- --minor`, `-- --major`, or `-- --version X.Y.Z` to control it. The archive lands in `build/`.

## Code map

| Path | What lives there |
|---|---|
| `src/api/` | The Cribl API surface: `criblFetch` (28 s budget, error text), `cribl` (deployment, health), `metrics`, `kv` |
| `src/domain/` | Pure logic, no React: `health`, `volume`, `credits`, `filters`, `settings`, `time`, `format`, `status` |
| `src/hooks/useDashboardData.ts` | Fetch orchestration: deployment once, then per-Worker-Group fan-out with partial success |
| `src/components/` | Reusable controls — `FilterBar`, `MultiSelect`, `TimeRangePicker`, `DataTable`, `StatTile` |
| `src/charts/` | Hand-built SVG (Capra has no chart component): `LineChart`, `Sparkline`, `HealthMeter`, `DeviationBars` |
| `src/panels/` | The screen: `HealthPanel`, `VolumePanel`, `CreditsPanel`, `DiagnosticsPanel`, `SettingsDrawer`, the drill-downs |
| `src/styles/` | `theme.css` (palette + Capra retheme) → `viz.css` (chart marks) → `app.css` (layout). Imported in that order by `main.tsx`, so a later same-specificity rule wins |

## Ground rules

`AGENTS.md` is the platform guide and is authoritative. The ones easiest to break:

- **Never** define, assign, or polyfill `window.CRIBL_API_URL` / `window.CRIBL_BASE_PATH` in app
  code, Vite config, or env files. Only `dev/mock-api.js` touches them.
- **No browser storage** — no `localStorage`, `sessionStorage`, `IndexedDB`, or cookies. All
  persistence goes through the app-scoped KV store, at `cc-cribl-executive-dashboard/settings/v1`.
- **Confirm before any volatile write.** `DELETE`, and `PUT`/`POST`/`PATCH` that overwrite existing
  config, need the user's say-so and must never fire on load, render, or a timer.
  `POST /system/metrics/query` and `/system/metrics/enum` are read-only queries despite the verb.
- Proxied requests time out at **30 s**; the app budgets 28 s.
- In CSS use the `token()` function, never a raw CSS variable — except in `theme.css`, whose header
  documents why the palette is literal there. Never write a selector that depends on a Capra class
  name or its internal DOM.

## Known limits

- The **Worker Node filter narrows node-level figures only.** Source and destination health is
  reported per Worker Group by the API, and the volume queries carry no host dimension, so those
  numbers do not respond to it. The Health card and the drill-down say so rather than looking
  broken; per-node source health needs a different data source.
- Volume attribution depends on the `__worker_group` dimension. When a deployment names it
  something else the totals still work, but the per-group split falls back — Diagnostics flags it.
