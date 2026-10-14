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

- [ ] On Postgres, writing a cache instruction notifies a channel and every node
      polls on notification, not only on its timer.
- [ ] The timer stays as the fallback, so a dropped connection loses no
      instruction.
- [ ] A test with two nodes shows a publish reaching the second within a small
      bound, well under the poll interval.
- [ ] SQLite behaviour is unchanged.

## Out of scope

- Replacing the table with the notification payload.
