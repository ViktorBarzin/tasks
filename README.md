# tasks (TypeScript build)

The TanStack Start port of `tasks`, per `~/code/docs/adr/0001-default-app-stack.md`.
It is not deployed yet; the live app is `../backend` + `../frontend`.

Start with [AGENTS.md](AGENTS.md): conventions, commands, tests, database and image.

```sh
bun install --frozen-lockfile
bun run check && bun run typecheck && bun run test && bun run build
DEV_USER=me DATABASE_URL=postgres://... bun run start
```
