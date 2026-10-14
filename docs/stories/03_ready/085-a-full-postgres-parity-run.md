# 085 — A full Postgres parity run

**Epic:** I — Hardening · **Priority:** must · **Size:** M
**Depends on:** —

## Story

As someone running a site on Postgres, I want every behaviour proven on Postgres
as well as SQLite, so that choosing the production database never costs me a
feature.

## Context

Each work package has been required to be green on both dialects. Phase 7's exit
asks for more than that: the whole conformance suite green against both
dialects in one run.

## Acceptance criteria

- [ ] The full conformance suite runs against SQLite and against Postgres, and
      both are green.
- [ ] CI runs it on Postgres as well as SQLite.
- [ ] Any dialect-specific skip is listed with a reason. The target is none.
