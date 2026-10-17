# 155 — Members out and in

**Epic:** P — The command line · **Priority:** could · **Size:** M
**Depends on:** —

## Story

As a site owner, I want to export and import members as a spreadsheet, and to
answer a person's request for their data or for its erasure, so that member data
can move between systems and privacy requests take minutes.

## Context

The Management API's `member` and `member-group` areas work one member at a
time. Bundles and `export --site --with-members` carry members, always
encrypted, but only between crombolo sites. A newsletter platform, a CRM or a
regulator wants a CSV. Member types are files (`schema/`), so a member's
properties are known in advance.

## Acceptance criteria

- [ ] `crombolo members export --out <file.csv> [--group <alias>]`, with one
      column per member-type property; the file holds personal data, so the
      command warns before it writes
- [ ] `crombolo members import <file.csv> --type <alias>` creates or updates
      members by e-mail. Passwords are never imported: new members get a reset
      link instead
- [ ] `crombolo members show <email> --out <file.json>` writes everything held
      about one person, for a subject access request
- [ ] `crombolo members erase <email>` removes the member, scrubs their name
      from the audit log, and asks for confirmation, or `--yes`
- [ ] A reset link is never sent to a member with no password: they sign in
      only through a provider (story 035)
- [ ] Imports are idempotent and support `--dry-run`
- [ ] Each command writes an audit entry, naming the member but not their data
- [ ] Tests on SQLite and Postgres
