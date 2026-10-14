# 121 — Reads from a Postgres replica

**Epic:** M — Running at scale · **Priority:** could · **Size:** M
**Depends on:** —

## Story

As someone running a busy site, I want renderers to read from a Postgres read
replica, so that visitor traffic does not compete with editors for the primary.

## Context

Connection pooling is built (`poolSize`). Renderers are readers by role and
already refuse to migrate or write, so they are the natural users of a replica.
A replica lags, and the published cache reloads on cache instructions, so a
reload must not read a replica that has not yet caught up with the instruction
that triggered it.

## Acceptance criteria

- [ ] A read-replica URL is configurable; `web` nodes use it for reads and the
      primary for anything else.
- [ ] A reload triggered by a cache instruction waits until the replica has
      replayed past that instruction, or falls back to the primary after a bound.
- [ ] Without the setting, behaviour is unchanged.
- [ ] The dialect suite runs against a primary and replica pair.

## Out of scope

- Using a replica on the node that serves the backoffice.
