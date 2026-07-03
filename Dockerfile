# Combined production image (linux/amd64, built by .github/workflows/build.yml):
# FastAPI backend serving the built SvelteKit SPA same-origin.
#
#   docker build -t tasks:local .
#
# Layout mirrors the repo so backend/tasks_api/app.py finds ../frontend/build:
# /app/backend (API + venv) + /app/frontend/build (adapter-static output).

# --- Stage: web — build the SvelteKit SPA (adapter-static → frontend/build) ---
FROM node:22 AS web

WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
# --include=dev: the build toolchain lives in devDependencies; a NODE_ENV=production
# environment would otherwise silently skip it (bit us on the devvm).
RUN npm ci --include=dev

COPY frontend/ ./
RUN npm run build

# --- Stage: builder — install the backend into an in-project venv ---
FROM python:3.12-slim AS builder

# poetry 2.1.3 (not the fleet's 1.8.4): poetry.lock is lock-version 2.1,
# which poetry 1.8 cannot read.
ENV POETRY_VERSION=2.1.3 \
    POETRY_VIRTUALENVS_IN_PROJECT=true \
    PIP_NO_CACHE_DIR=1

RUN pip install --no-cache-dir "poetry==${POETRY_VERSION}"

WORKDIR /app/backend
COPY backend/pyproject.toml backend/poetry.lock ./
RUN poetry install --only main --no-root

COPY backend/tasks_api ./tasks_api
COPY backend/alembic ./alembic
COPY backend/alembic.ini ./alembic.ini
RUN poetry install --only main

# --- Stage: app — runtime (non-root uid 10001) with the SPA baked in ---
FROM python:3.12-slim

WORKDIR /app/backend

RUN useradd --system --uid 10001 --home /app --shell /usr/sbin/nologin tasks

COPY --from=builder --chown=tasks:tasks /app/backend /app/backend
COPY --from=web --chown=tasks:tasks /web/build /app/frontend/build

ENV PATH="/app/backend/.venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1

USER tasks

EXPOSE 8000
CMD ["uvicorn", "tasks_api.app:app", "--host", "0.0.0.0", "--port", "8000"]
