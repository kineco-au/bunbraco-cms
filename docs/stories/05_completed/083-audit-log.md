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

- [x] Content, media, schema, user and permission changes write an audit entry:
      who, what, when, from where.
- [x] The backoffice's audit operations (per item, per user) answer from it.
- [x] Sign-ins, sign-in failures and permission changes are recorded.
- [x] Entries cannot be edited through the API, and retention is configurable.
- [x] Tested on both dialects.

## Decisions

- **Capture point: the Management API router, plus explicit entries.**
  - **The router.** Every successful contract write is recorded once, in
    `ManagementApiRouter.dispatch`, mapped by `auditPlanFor`. A test holds the
    whole contract to "mapped or deliberately left out".
  - **Explicit entries.** Writers the router never sees record their own
    entries: sign-ins (`packages/auth`), Crombolo's own endpoints, scheduled
    publishing, and the command line's write commands.
  - **The alternative.** Repository-level entries would have meant around 20
    repositories each remembering to write one.
- **Reading across users: a Settings dashboard.** The current Umbraco contract
  has audit operations per item only; the per-user `/audit-log` endpoints of
  older versions are gone. "Per user" is therefore the *Who* filter on a new
  Audit log dashboard in Settings, over a Crombolo endpoint, as the Changes
  dashboard works. The per-item Info tab reads the log.
- **Retention: 365 days by default.** It is set by
  `CROMBOLO_AUDIT_RETENTION_DAYS`, and `0` keeps everything. An hourly job
  prunes.
- **History: start fresh.** Nothing is backfilled. An item's versions stand in
  on the Info tab for the time before migration 033 ran.

## What was built

See [`audit-log.md`](../../audit-log.md).

- **Migration 033.** `audit_entry` copies in the names of the user and the
  item, so an entry outlives both. The peer address and `X-Forwarded-For` are
  kept apart.
- **Data layer.** `AuditLog` (`packages/data/src/audit.ts`) has `record`,
  `query`, `users`, `prune`, `startedAt` and `describe`. `describe` names an
  item and files a version under its page.
- **Router.** `audit.ts` in api-management holds the operation map. Bulk
  operations are read from the body. Items are named before a delete. Related
  groups or users go in the entry's detail. An anonymous reset-by-link or
  invite acceptance records the user it was for.
- **Info tab.** `handlers/audit-log.ts` answers the four Info-tab operations
  from the log, merged with pre-log versions. These operations were previously
  registered in each content handler, built from versions alone.
- **Auth.** `onAudit` on the auth routes reports sign-in, failure (wrong
  password, no such user, locked, disabled), lockout and sign-out, including
  client credentials. The service tells the routes which user a refusal
  concerns; responses are unchanged.
- **Server.** `adapters/audit.ts` holds the sink, the Info-tab history, the
  dashboard endpoint (`GET <backoffice>/crombolo/api/audit` and `/users`,
  Settings only, 405 otherwise) and `pluginAuditPlan` for Crombolo's own
  writes. Peer addresses come from `Bun.serve`'s `requestIP`.
- **Jobs.** `runAuditRetention` runs hourly, and scheduled publishing writes
  `job` entries.
- **CLI.** `recordCommand` records each write command, as the OS account or
  `CROMBOLO_ACTOR`, without arguments.
- **Dashboard.** `plugin/audit-dashboard.js` provides filters for who, what,
  words and dates, links to items, and paging.
- **Tests.** `tests/audit.test.ts` covers:
  - contract coverage of the map;
  - a page's life through to deletion;
  - schema, users and permissions;
  - sign-ins and lockout;
  - scheduled publishing;
  - the Info tab, before and after the log began;
  - the dashboard's filters and refusals;
  - retention.

  The existing Info-tab test now expects `New` for a created page.

## Not covered

- **Members signing in to the public site.** They are visitors, not editors.
  Their volume would swamp the log.
- **A per-user view on the user workspace.** The dashboard's filter does this
  job.
