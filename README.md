# tasks

Self-hosted, Reminders-style tasks PWA for the household, served at
`tasks.viktorbarzin.me`. Nextcloud CalDAV stays the source of truth; the PWA is
offline-first (full IndexedDB Replica + Op Queue) and speaks only the JSON
delta-sync API — the FastAPI backend alone speaks CalDAV.

Authoritative docs: [`CONTEXT.md`](CONTEXT.md) (domain language),
[`docs/2026-07-03-tasks-pwa-design.md`](docs/2026-07-03-tasks-pwa-design.md)
(locked design + API contract), `docs/adr/`.

## Layout

- `backend/` — FastAPI (python 3.12, poetry). `/healthz`, `/metrics`, `/api/*`
  per the contract; serves the built SPA from `frontend/build` when present.
- `frontend/` — SvelteKit + TypeScript static SPA (adapter-static,
  vite-plugin-pwa autoUpdate).
- `Dockerfile` — multi-stage: node builds the SPA, python image runs uvicorn
  serving API + SPA (one container, linux/amd64).
- CI/CD — `.github/workflows/build.yml` (lint/test → ghcr.io/viktorbarzin/tasks)
  → `.woodpecker/deploy.yml` (kubectl set image, ns `tasks`), per infra ADR-0002.

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
```
