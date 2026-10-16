# tasks

Self-hosted, Reminders-style tasks PWA for the household, served at
`tasks.viktorbarzin.me`. Nextcloud CalDAV stays the source of truth; the PWA is
offline-first (full IndexedDB Replica + Op Queue) and speaks only the JSON
delta-sync API, while the server speaks CalDAV. Built with TanStack Start on
Bun and Postgres, with its own OIDC sign-in against Authentik, per
`~/code/docs/adr/0001-default-app-stack.md`.

Start with [AGENTS.md](AGENTS.md): conventions, commands, tests, database and
image. Domain language is in [CONTEXT.md](CONTEXT.md); the design and API
contract are in [`docs/2026-07-03-tasks-pwa-design.md`](docs/2026-07-03-tasks-pwa-design.md),
the contract deltas beside it, and `docs/adr/`.

```sh
bun install --frozen-lockfile
bun run check && bun run typecheck && bun run test && bun run build
DEV_USER=me DATABASE_URL=postgres://... bun run start
```

CI/CD: `.github/workflows/build.yml` lints, tests and builds
`ghcr.io/viktorbarzin/tasks` on GitHub Actions, then triggers
`.woodpecker/deploy.yml`, which sets the image on Deployment `tasks` in
namespace `tasks` (infra ADR-0002).
