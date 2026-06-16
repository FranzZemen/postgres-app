# Resource governance — postgres-app's role

This package participates in the fleet-wide resource-governance model. Canonical
design + operations live elsewhere; this note records what *this* package
contributes so the next person inherits the reasoning.

- **PRD:** `~/dev/projects/doc/prd/worker-resource-governance.prd.md`
- **Operational Manual:** `~/dev/brokenstock-infra/doc/guide/worker-fleet-operations.guide.md`

## What postgres-app owns in the model

**Per-worker connection-pool sizing (PRD E3).** The pool `max` is not a single
shared constant — workers are not uniform (a heavy yields process and a light
auth process pull different shares of one cluster connection budget). The config
loader (`config-loader/load-postgres-config.ts`) reads an optional
**`BROKENSTOCK_DB_POOL_MAX`** environment variable that overrides the config
block's `pool.max`, taking precedence over the shared blob precisely so each
worker can be sized independently. The deploy document injects that value per
role, derived from the worker-role registry's `connectionShare × cluster budget ÷
processCount`. Precedence: env var > config `pool.max` > default (10). Invalid /
non-positive values are ignored with a warning and fall back.

**Connection-reclaim backstops (incident 2026-06-14).** `DEFAULT_POOL` also sets
`idle_in_transaction_session_timeout` (30 s) and `statement_timeout` (60 s) so no
single stalled or aborted transaction can pin the connection budget — the
server-side half of the storm fix that the E4 per-operation-transaction work
relies on.

The cluster connection budget the per-worker share divides is sized against the
DB's connection **floor** (live-verified `max_connections = 194` at the 0.5-ACU
active minimum) — see PRD E3.
