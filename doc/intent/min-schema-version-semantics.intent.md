# Intent: MIN_SCHEMA_VERSION Semantics + `--migrations-package` Discovery

**Status:** Active (since Pre-Era-1.6, 2026-05-30)
**Parent PRD:** `~/dev/projects/doc/prd/pre-era-1.6-centralize-ddl-and-foundation-cleanup.prd.md`

## What changed in Pre-Era-1.6

Before Pre-Era-1.6, `MIN_SCHEMA_VERSION` was a **count** — a positive integer
interpreted as "the max `id` in the `pgmigrations` table." `verifyMinSchemaVersion`
did `SELECT MAX(id) FROM pgmigrations` and compared as numbers.

After Pre-Era-1.6, `MIN_SCHEMA_VERSION` is a **timestamp string** — the
filename of the largest migration the consumer's code depends on (without
extension), as stored in the `pgmigrations.name` column.

## Why timestamps instead of counts

- **Migrations land out of order across Eras.** Counts implicitly assume an
  ordered sequence; once an Era branches and lands two migrations in
  different orders on different envs, the count is no longer a stable
  reference. The filename timestamp is the canonical ordering authority.
- **Counts force every consumer to rebuild on every migration.** If
  worker-A's MIN_SCHEMA_VERSION=2 and worker-B's MIN_SCHEMA_VERSION=2, then a
  new migration bumping the chain to 3 forces both workers to re-evaluate
  their constants — even if neither's code actually depends on the new
  schema. Timestamps decouple this: each consumer's constant tracks the
  schema state IT requires, named explicitly.
- **Filename comparison is human-debuggable.** `'2026-05-30T140030Z' >= '2026-05-30T140000Z'`
  is obvious; `12 >= 11` requires correlating IDs to migrations.

## The algorithm

```sql
SELECT 1 FROM <migrations_table> WHERE name >= $1 LIMIT 1
```

Throws `MinSchemaVersionError` on empty result. Uses the PRIMARY KEY index
on `pgmigrations.name` (node-pg-migrate creates this by default), so the
query is O(log N) regardless of the table's size.

If the migrations table itself is missing, that's also a failure — the
consumer's code requires schema state that doesn't exist yet.

## Filename convention

`YYYY-MM-DDTHHMMSSZ_<snake_case_slug>.ts` — ISO 8601 UTC with `Z` suffix.
Lex-sortable as strings. Migrations live at `src/project/migrations/` per the
standard `@franzzemen/*` source layout and are transpiled by `tsc` to
`out/project/migrations/*.js` at build time; node-pg-migrate 8.x discovers the
post-build `.js` files. The `name` column stores the filename without the
extension, so the column value is identical regardless of source extension.

This is the canonical layout for consumer DDL packages (e.g.
`@franzzemen/brokenstock-postgres-ddl`). See Pre-Era-1.7 D4 in
`~/dev/projects/doc/prd/pre-era-1.7-secrets-loader-and-migration-shape.prd.md`.

## The `--migrations-package` discovery pattern

`pg-app.migrate <env> --migrations-package=<pkg>` resolves the migrations
directory by:

1. `require.resolve('<pkg>/package.json')` — confirms the package is installed.
2. `import('<pkg>')` — reads the package's default export, which must include
   a `migrationsDir: string` field naming the absolute path to its
   `migrations/` directory.

This pattern keeps `postgres-app` generic. The CLI doesn't know about
Brokenstock; it accepts any DDL package that follows the contract.

`@franzzemen/aws-build-system`'s `abs.migrate` is a thin wrapper that
hard-codes `--migrations-package=@franzzemen/brokenstock-postgres-ddl`.

## Per-consumer ownership

Each consumer (auth-worker, imports-worker, ...) carries its own
`MIN_SCHEMA_VERSION` constant. Consumers DO NOT import a shared constant from
`brokenstock-postgres-ddl` — that would couple every consumer's rebuild to
every migration. Each consumer's constant tracks only the schema state IT
requires.

## Backwards compatibility note

The `MinSchemaVersionError` constructor signature changed (count `applied`
field removed; `migrationsTable` field added). Callers should rebuild against
the new types. There is no `applied` to report; the query is set-membership,
not maximum.
