# 156 — The audit log from the command line

**Epic:** P — The command line · **Priority:** could · **Size:** S
**Depends on:** —

## Story

As whoever answers for a site's security, I want to query the audit log from the
command line and stream it out as structured records, so that it can feed a SIEM
or answer an auditor without screenshots of a dashboard.

## Context

The audit log (story 083, `audit-log.md`) is read through the Settings
dashboard, over `GET <backoffice>/crombolo/api/audit`, which needs a back-office
sign-in. Entries are deleted after `CROMBOLO_AUDIT_RETENTION_DAYS`, so anyone who
must keep them longer needs a way to get them out first.

## Acceptance criteria

- [ ] `crombolo audit [--since <time>] [--until <time>] [--user <email>]
      [--category <c>] [--entity <uuid>]` lists entries, newest first,
      paginated with a cursor
- [ ] NDJSON output, one entry per line, oldest first with `--follow`, for
      shipping to a log store
- [ ] Reading the log is not itself audited, and never writes to the database
- [ ] Tests on SQLite and Postgres
