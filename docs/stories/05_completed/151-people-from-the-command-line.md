# 151 — People from the command line

**Epic:** P — The command line · **Priority:** should · **Size:** M
**Depends on:** —

## Story

As whoever runs a site, I want to unlock, re-enable or reset any back-office
user from the command line, and to clear a lost second factor, so that a
locked-out team can get back in without someone hand-editing the database.

## Context

The Management API's `user` (41 operations), `user-group` and `security` areas
are complete, but all of them need a working sign-in. The CLI has one recovery
command, `admin reset-password`, and it reaches only the account named by
`adminLogin`. Since two-factor sign-in (story 032) and external providers
(story 031) shipped, someone can now be locked out in ways a password reset does
not fix: a lost authenticator, a disabled account, or too many failed attempts.
Story 034 seeds an API client from the environment, and nothing rotates its
secret afterwards.

Like `admin reset-password`, these commands open the site's database directly,
not through the server, so they work when the site will not boot. In a container
they run through `docker exec`.

User groups are files (`schema/user-groups/`), so they are out of scope here.

## Acceptance criteria

- [x] `crombolo users list` shows each user's name, e-mail, groups, state and
      last sign-in, with JSON output
- [x] `crombolo users unlock <email>` clears the lockout and the failed-attempt
      count
- [x] `crombolo users enable|disable <email>`
- [x] `crombolo users reset-password <email>` prints a new password, or reads
      one from stdin; `admin reset-password` keeps working for the site's own
      administrator
- [x] `crombolo users reset-2fa <email>` removes the user's second factors, so
      the next sign-in enrols again
- [x] `crombolo users invite <email> --group <alias>` creates the user and
      prints a one-time sign-in link, for sites with no e-mail delivery (story
      045)
- [x] `crombolo api-client rotate` issues a new secret for the seeded API client
      and prints it once
- [x] Every one of these writes an audit entry, with the command as its source
      (`commandAudit`)
- [x] Tests on SQLite and Postgres

## What was built

- `crombolo users list|unlock|enable|disable|reset-password|reset-2fa|invite`
  and `crombolo api-client rotate`, in `packages/cli/src/commands/users/` and
  `api-client/`. They go through `createUserPorts` — the port the Management
  API's Users section uses — so its rules hold here: an invitation cannot be
  disabled, a password must meet the site's rules, a disabled user's sessions
  end. `support/people.ts` opens it on the site's database, with two
  principals: an observer that sees the built-in administrator, as only that
  administrator may, and an operator that is nobody in particular, so no rule
  about acting on oneself applies.
- **Invite** prints the link. The port issues an invitation only through
  `sendUserLink`; the CLI passes one that captures the link instead of e-mailing
  it. Without `CROMBOLO_APPLICATION_URL` the link is printed as a path, and the
  command says so.
- **Rotate** replaces the credential's hash and prints the new secret once. A
  start keeps a client it finds, so it never puts the old secret back; the
  command says to update `CROMBOLO_API_CLIENT_SECRET`.
- `admin reset-password` stays as it was: `users reset-password <admin>` does
  the same, by e-mail or username, for any user.
- `@crombolo/server` now exports `createUserPorts` and `createNodeLookup`.
- **Tests:** `tests/cli-operations.test.ts` § users, run under both dialect
  services. Each CLI test drives its own SQLite site; the port beneath is the
  one the Users API tests already cover on both dialects.
