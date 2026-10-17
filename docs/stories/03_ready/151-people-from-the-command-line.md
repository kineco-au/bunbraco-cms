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

- [ ] `crombolo users list` shows each user's name, e-mail, groups, state and
      last sign-in, with JSON output
- [ ] `crombolo users unlock <email>` clears the lockout and the failed-attempt
      count
- [ ] `crombolo users enable|disable <email>`
- [ ] `crombolo users reset-password <email>` prints a new password, or reads
      one from stdin; `admin reset-password` becomes an alias for the admin
      account
- [ ] `crombolo users reset-2fa <email>` removes the user's second factors, so
      the next sign-in enrols again
- [ ] `crombolo users invite <email> --group <alias>` creates the user and
      prints a one-time sign-in link, for sites with no e-mail delivery (story
      045)
- [ ] `crombolo api-client rotate` issues a new secret for the seeded API client
      and prints it once
- [ ] Every one of these writes an audit entry, with the command as its source
      (`commandAudit`)
- [ ] Tests on SQLite and Postgres
