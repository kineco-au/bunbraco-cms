# 120 — Cache instructions arrive without polling

**Epic:** M — Running at scale · **Priority:** could · **Size:** S
**Depends on:** —

## Story

As an editor on a site with several renderers, I want a publish to show on
every renderer straight away, so that I am not told my change is live while
some visitors still see the old page.

## Context

Every node polls `cache_instruction` with a cursor
([`../../schema-as-code.md`](../../schema-as-code.md)), so a change reaches a
renderer up to one poll interval late. On Postgres, `LISTEN/NOTIFY` can wake the
poller as soon as a row is written. On SQLite, which is single node, it is a
no-op.

## Acceptance criteria

- [x] On Postgres, writing a cache instruction notifies a channel and every node
      polls on notification, not only on its timer.
- [x] The timer stays as the fallback, so a dropped connection loses no
      instruction.
- [x] A test with two nodes shows a publish reaching the second within a small
      bound, well under the poll interval.
- [x] SQLite behaviour is unchanged.

## Out of scope

- Replacing the table with the notification payload.

## Decision (2026-10-15)

**Notified by the app, not a trigger.** On Postgres, `appendCacheInstruction`
sends `pg_notify` beside its insert, so a rolled-back write wakes nobody; each
node listens on a connection of its own (Bun's SQL client has `listen`, so no
new dependency) and polls when woken. No migration. A row written by anything
else — an older node mid-upgrade — arrives on the timer, which stays.

## What was built

- `Db.listen` (Postgres only): Bun's SQL `listen`, resolving to the way to stop.
  SQLite has none.
- `appendCacheInstruction` sends `pg_notify('crombolo_cache_instruction', kind)`
  beside its insert on Postgres; delivered at commit.
- `CacheInstructionPoller` listens when it has a timer and the database can,
  and polls when woken. Polls are serialised, and calls during one share a
  single follow-up, so a burst reads twice and an instruction written mid-poll
  is still read. The timer is unchanged as the fallback; `stop` unlistens.
- Tests: `tests/cache-notify.test.ts` — a stand-in listener for the wake-up,
  the coalescing, stopping and a database without `listen` (both dialects);
  two Postgres connections where a committed write reaches the other node's
  poller well under a second against a one-minute timer, and a rolled-back one
  wakes nobody. Documented in `docs/schema-as-code.md`, "Cache coherence".
- `tests/schema-boot.test.ts` and `tests/views-reload.test.ts` asserted that a
  second Postgres node stays stale until its explicit poll finds something; the
  notification now delivers first, so they assert the result after the poll.
