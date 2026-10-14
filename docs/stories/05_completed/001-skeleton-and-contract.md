# 001 — Skeleton and contract

**Epic:** A — Foundations · **Priority:** must · **Size:** L
**Depends on:** —

## Story

As a maintainer, I want the repository, toolchain, API contract and database
seam in place before any feature, so that every later handler is written
against the real Umbraco contract and runs on both database dialects from the
first line.

## Context

The whole project is a server for the unmodified Umbraco backoffice, so the
contract comes first. The Management API's OpenAPI document is vendored from
Umbraco `release-18.2.0` and types are generated from it, which turns drift
from the contract into a compile error rather than a runtime surprise. Every
one of the 513 operations is routable from day one and answers 501, so
coverage is measured, never remembered.

The dialect seam (SQLite and Postgres behind one `Db`) and the migration runner
are here too, because every later phase writes to the database and must stay
green on both.

The roadmap's rule for every phase starts here: no phase is done until its
exit criterion is met, and the criterion is always "works in the actual
Umbraco backoffice", never "returns 200".

## Acceptance criteria

- [x] Repo layout as Bun workspaces; TypeScript strict; Biome for format and
      lint.
- [x] `contracts/OpenApi.json` vendored from `release-18.2.0`, with types
      generated from it.
- [x] A typed route table with 501 stubs for all 513 operations.
- [x] The dialect seam with both drivers connecting, and the migration runner.
- [x] `vendor:backoffice` and `crombolo dev`.
- [x] `bun run check` (format, lint, typecheck) and `bun test` are green.
- [x] `bun run coverage:api` reports 513 operations with a known implemented
      count.
- [x] `vendor/backoffice/` contains a browser-runnable client.

## As built

- 53 tests green on both dialects.
- 0/513 operations implemented; all 513 routable and answering 501.
- `vendor/backoffice/` builds in 0.8 s with 140 import-map entries.
- How the npm client was made runnable (R3 in [`../../roadmap.md`](../../roadmap.md))
  is in [`../../backoffice-hosting.md`](../../backoffice-hosting.md).
