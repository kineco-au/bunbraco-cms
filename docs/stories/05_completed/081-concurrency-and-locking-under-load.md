# 081 — Concurrency and locking under load

**Epic:** I — Hardening · **Priority:** should · **Size:** M
**Depends on:** —

## Story

As a site owner with several editors, I want simultaneous edits, publishes and
moves to behave correctly under load, so that nobody loses work and the tree is
never left inconsistent.

## Context

Umbraco relies on database-level locks around content-tree mutation. Here that
is WAL plus a single-writer queue on SQLite and advisory locks on Postgres,
behind one lock abstraction (risk R4 in [`roadmap.md`](../../roadmap.md)). It
has been built and tested for correctness, not under concurrent load.

## Acceptance criteria

- [x] A load test with concurrent saves, publishes, moves, sorts and deletes on
      overlapping branches, on both dialects.
- [x] No lost update, deadlock or inconsistent tree after the run, checked by an
      invariant pass over the tree and the values.
- [x] Lock waits and timeouts surface as a readable error, not a 500.
- [x] Multi-node: two backoffice-serving nodes under the same load stay
      consistent through the cache instruction poll.

## Decisions

- **Every content write takes its tree's lock**, as Umbraco's content services
  do, rather than per-page row locks. Documents, blueprints and elements share
  the content lock; media and members have their own.
- **Contention is a 503 with `Retry-After`**, with the message "Someone else is
  changing this content right now. Try again in a moment." A deadlock is retried
  once first, unless an enclosing transaction has already been aborted.
- **The wait is 15 seconds**, set by `CROMBOLO_LOCK_TIMEOUT_SECONDS`.
- **The load test runs only in the release pipeline**, on both dialects, before
  npm publish (`.github/workflows/release.yml`, job `load`). It is not part of
  `bun test`.
- **The pieces are pure, so they can be unit tested:** classifying contention,
  the retry policy (with the sleep injected), the lock queue (with its timeout
  passed in), the busy response, and the invariant check over plain rows.

## What was built

- `packages/data/src/busy.ts`:
  - `ContentBusyError`.
  - `classifyContention`, which recognises Postgres SQLSTATEs 40P01, 40001 and
    55P03 (Bun reports these as `errno`) and SQLite's busy and locked errors.
  - `retryContention`.
- `packages/data/src/locks.ts`:
  - `LockQueue`, an in-process FIFO with a bounded wait.
  - On Postgres, the queue sits in front of `pg_advisory_xact_lock`, under
    `SET LOCAL lock_timeout`.
- The Postgres pool deadlock: every request waiting for a lock held a pooled
  connection blocked on the advisory lock, so a pool full of waiters left the
  holder no connection to work on. Waiters now queue in-process first.
  Routing locked work into the lock's own transaction was tried and dropped: on
  Postgres any failed statement aborts the whole transaction, and migrations
  and schema sync rely on probing and on committing step by step.
- `packages/data/src/ambient.ts` marks a chain as inside a transaction, so a
  deadlock is not retried into a transaction the database has already aborted.
- `packages/data/src/tree-invariants.ts`: `checkTreeInvariants`, a pure check,
  and `loadTreeSnapshot`, which reads the rows it needs.
- `DocumentRepository`:
  - Update, unpublish, rollback, delete, publish-with-descendants, schedules,
    version cleanup and value migration all take the tree lock.
  - Trash, restore and sort read their node inside the lock.
- The Management API router gained an `onError` hook. The server answers
  contention with `busyResponse` (`packages/server/src/busy.ts`).
- Tests:
  - `tests/concurrency.test.ts`, run in the normal suite.
  - `tests/load/concurrency.load.ts`, run by `bun run test:load` or
    `docker:test:load`.

## Faults the load test found

The first four were reproducible serially, on SQLite:

- Trashing a page kept its old path, so restoring an ancestor un-trashed a page
  sitting in the bin. A trashed branch is now re-pathed under the bin, as
  Umbraco does.
- Moving a page out of the bin left it trashed. A move out of the bin now
  restores the page, as Umbraco's Move does.
- Trashed pages kept their sort orders and collided in the bin. Each now takes
  the next one there.
- A page could be created under a trashed parent, and a missing parent silently
  became the root. Both now answer 400.

Before the locking change, on Postgres:

- Two saves of one page could both leave a "current" version.
- Unpublish, delete and rollback could interleave with moves and publishes.

## Not done

- Multi-node runs on Postgres only. SQLite is a single-node topology, and two
  processes on one SQLite file do not share the in-process lock.
- Public-site routes (member sign-in, form submissions) do not take the content
  lock, so they keep their existing error handling.
