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

- [ ] A load test with concurrent saves, publishes, moves, sorts and deletes on
      overlapping branches, on both dialects.
- [ ] No lost update, deadlock or inconsistent tree after the run, checked by an
      invariant pass over the tree and the values.
- [ ] Lock waits and timeouts surface as a readable error, not a 500.
- [ ] Multi-node: two backoffice-serving nodes under the same load stay
      consistent through the cache instruction poll.
