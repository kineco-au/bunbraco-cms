# 012 — Framework migrations, hardened

**Epic:** B — Packaging and upgrades · **Priority:** must · **Size:** M
**Depends on:** 011

## Story

As an operator, I want every framework migration to be ledgered, previewable,
classified as expand or contract, and refused at boot when it is unsafe, so
that upgrading a running site is predictable and a mismatch between code and
database is named rather than discovered.

## Context

012–015 are the upgrade machinery, designed in
[`../../packaging-and-upgrades.md`](../../packaging-and-upgrades.md), Part 2,
and planned after 011 landed, with the decisions 011's code forces or makes
easy. They stand on:

- `schema_state` rows with `prepared`/`current` status, and
  `makeStateCurrent` as the cut-over
- write gating (`assertNodeMayWrite`, 409)
- append-only values tagged with the state that wrote them, and read as-of a
  state
- `since_state_id` on every element; retirement
- the version-gated sync with a dry run
- `server` + `cache_instruction` + the poll
- the GUID-chain migrator in `migrations.ts`, which had no backups

The four slices (012, 013, 014, 015) were each green on both dialects before
the next started. This one hardens the framework's own migrations.

## Acceptance criteria

- [x] **Ledger.** `migration_history(name, kind, from_state, to_state,
      applied_at, duration_ms, checksum, applied_by)`, written by `migrate()`
      per step and by the value-migration runner (kind `value`), so "which
      converters ran here" is one table. `checksum` is a hash of the
      migration's source text where it is a file, or of its name for
      built-ins.
- [x] **Expand/contract, linted.** `Migration` gains
      `kind: 'expand' | 'contract'` and `release`. A contract must name the
      expand it removes (`contracts`), and the `MigrationPlan` constructor
      throws unless that expand's `release` is lower than the contract's. The
      three existing migrations are expand, release `0.1.0`.
- [x] **`crombolo upgrade --plan`.** A `RecordingDb` implements `Db`: `exec`
      captures rendered SQL, `query` throws `Unplannable`, and `transaction`
      recurses. Each pending step runs against it. The output is the DDL per
      step, or "unplannable: <step> reads data". Migrations 001–003 are
      plannable.
- [x] **Boot rules.**
      - A state that is not in the plan raises `UpgradeStateError`, naming
        both states ("database is newer than this code").
      - In production (`NODE_ENV=production`), pending steps on an existing
        database refuse to boot and name the command to run.
      - A database at the initial state is an install and proceeds
        everywhere.
      - Development migrates at boot.
- [x] **Schema operations on the dialect seam.**
      `db.schema.addColumn/dropColumn/renameColumn/addIndex/dropIndex/renameTable`.
      Bun's SQLite supports `ALTER TABLE … DROP/RENAME COLUMN`, so no
      copy-table dance is needed; the helper exists so a migration is written
      once.
- [x] **Backups.** `backupBefore(db, config, what)`. SQLite copies the file to
      `<file>.<timestamp>.bak` beside it. Postgres runs `CROMBOLO_PG_DUMP`
      when set, and otherwise refuses unless `--backup-taken` is given. Used
      by `check --fix`, `upgrade` and `schema purge`.

## As built

Pinned by `tests/migrations.test.ts`. The rule that a contract may only ship
in a major, and the derived release declaration, are described in
[`../../packaging-and-upgrades.md`](../../packaging-and-upgrades.md), "What a
release may change, and what it declares".
