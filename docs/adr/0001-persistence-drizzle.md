# ADR 0001: Persistence with Drizzle and Postgres

Status: accepted

## Context

can_server stores an append-only event log and projections built from it. We want plain SQL migrations that contributors can read in review, typed queries, and no ORM runtime magic.

## Decision

- Postgres 16 is the only datastore. Local dev runs it through docker compose on host port 5433.
- Drizzle ORM (node-postgres driver) for queries; drizzle-kit generates SQL migrations from `src/db/schema.ts` into `drizzle/`, which is committed.
- The `pg` Pool is created lazily, so building the app for OpenAPI generation needs no database.
- `src/domain/` never imports Drizzle, pg or Nest. The `events` table mirrors `DomainEvent` and is written append-only.
- Migrations are applied with `npm run db:migrate`. Never edit a committed migration; add a new one.

## Consequences

- Schema changes are a two step flow: edit schema.ts, run `npm run db:generate`, commit the new SQL.
- Swapping the driver or ORM later only touches `src/db/`.
