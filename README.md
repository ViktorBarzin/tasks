# tasks

Self-hosted, Reminders-style tasks PWA for the household, served at
`tasks.viktorbarzin.me`. Nextcloud CalDAV stays the source of truth; the PWA is
offline-first (full IndexedDB Replica + Op Queue) and speaks only the JSON
delta-sync API — the backend alone speaks CalDAV.

The domain is served by the TypeScript build in `app/` (see
[`app/AGENTS.md`](app/AGENTS.md)). The Python/Svelte build below still builds
and runs in the cluster, without a route, as the rollback target.

Authoritative docs: [`CONTEXT.md`](CONTEXT.md) (domain language),
[`docs/2026-07-03-tasks-pwa-design.md`](docs/2026-07-03-tasks-pwa-design.md)
(locked design + API contract), `docs/adr/`.

## Layout

- `app/` — the TypeScript build (TanStack Start, Bun, Postgres, own OIDC
  sign-in). Built by `.github/workflows/build-ts.yml` into
  ghcr.io/viktorbarzin/tasks-ts and deployed to Deployment `tasks-next`.
- `backend/` — FastAPI (python 3.12, poetry). `/healthz`, `/metrics`, `/api/*`
  per the contract; serves the built SPA from `frontend/build` when present.
- `frontend/` — SvelteKit + TypeScript static SPA (adapter-static,
  vite-plugin-pwa autoUpdate).
- `Dockerfile` — multi-stage: node builds the SPA, python image runs uvicorn
  serving API + SPA (one container, linux/amd64).
- CI/CD — `.github/workflows/build.yml` (lint/test → ghcr.io/viktorbarzin/tasks,
  skipped for `app/`-only changes) and `build-ts.yml` (→ tasks-ts) both trigger
  `.woodpecker/deploy.yml`, which sets the image on Deployment `tasks` or
  `tasks-next` in ns `tasks` by image name, per infra ADR-0002.

## Dev

```sh
# backend (env: TASKS_DB_DSN, TASKS_FERNET_KEY, DEV_USER for header-less dev)
cd backend && poetry install
poetry run uvicorn tasks_api.app:app --reload   # http://localhost:8000
poetry run pytest && poetry run ruff check tasks_api tests alembic && poetry run mypy tasks_api tests

# frontend (--include=dev: NODE_ENV=production environments, e.g. the devvm,
# otherwise skip devDependencies — and the whole toolchain lives there)
cd frontend && npm install --include=dev
npm run dev        # http://localhost:5173
npm run check && npm test

# e2e: gesture suites (service workers blocked), then the service-worker suite
# (§H offline cold-start + §I re-login, against a Traefik→Authentik stand-in).
# Both are timing-sensitive — on a loaded devvm pass --workers=2.
npm run test:e2e && npm run test:e2e:sw
```
