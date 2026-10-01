# can_server

NestJS server for a Community Action Network node. It keeps an append-only event log in Postgres and serves a REST API described by a committed OpenAPI contract. The mobile client (can_app) is generated from that contract.

## Prerequisites

- Node 24 or newer
- Docker (for Postgres and Mailpit)

## Quick start

```sh
npm install
cp .env.example .env
docker compose up -d --wait
npm run db:migrate
npm run start:dev
```

Then open http://localhost:4000/health and the Swagger UI at http://localhost:4000/docs. Mailpit UI is at http://localhost:8025. Postgres listens on host port 5433 (user, password and database are all `can`).

## Scripts

| Script | What it does |
| --- | --- |
| `npm run start:dev` | Run with watch mode |
| `npm run build` | Compile to `dist/` |
| `npm run lint` | oxlint |
| `npm test` | Unit tests (Vitest, `*.spec.ts`) |
| `npm run test:e2e` | e2e tests (`test/*.e2e-spec.ts`), needs compose Postgres |
| `npm run db:generate` | Generate a SQL migration from `src/db/schema.ts` into `drizzle/` |
| `npm run db:migrate` | Apply migrations |
| `npm run openapi` | Write `openapi/openapi.json` (no database needed) |
| `npm run verify` | Everything CI cares about: compose up, migrate, lint, build, tests, openapi, and a diff check that the committed contract is current |

## Layout

```
src/domain/   framework-light core: protocol version, ids, DomainEvent
src/db/       Drizzle schema and the Nest DB module
src/health/   GET /health
src/config.ts environment config (see .env.example)
drizzle/      generated, committed SQL migrations
openapi/      generated, committed API contract
docs/adr/     architecture decision records
```

## Rule: src/domain stays framework-light

Nothing under `src/domain/` may import Nest, Drizzle, pg or any I/O library. It holds pure types and functions so it can be tested without a container and reused anywhere.

## Changing the API contract

1. Change controllers or DTOs.
2. Run `npm run openapi` and commit the updated `openapi/openapi.json` in the same commit.
3. can_app then runs its `gen:api` script to regenerate its client from the committed file.

Never hand-edit `openapi/openapi.json` or committed files in `drizzle/`.

## Contributing

See [../CONTRIBUTING.md](../CONTRIBUTING.md).
