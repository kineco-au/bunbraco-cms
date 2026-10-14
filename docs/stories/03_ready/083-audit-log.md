# 083 — Audit log

**Epic:** I — Hardening · **Priority:** should · **Size:** M
**Depends on:** —

## Story

As a site administrator, I want a record of who did what and when, across
content, settings and users, so that I can answer for a change after the fact.

## Context

Listed under Phase 7 hardening. Umbraco keeps an audit trail of user actions,
shown per item and per user.

## Acceptance criteria

- [ ] Content, media, schema, user and permission changes write an audit entry:
      who, what, when, from where.
- [ ] The backoffice's audit operations (per item, per user) answer from it.
- [ ] Sign-ins, sign-in failures and permission changes are recorded.
- [ ] Entries cannot be edited through the API, and retention is configurable.
- [ ] Tested on both dialects.
