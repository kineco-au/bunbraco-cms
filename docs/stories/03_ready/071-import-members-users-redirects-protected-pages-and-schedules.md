# 071 — Import members, users, redirects, protected pages and schedules

**Epic:** H — Importing an Umbraco site · **Priority:** should · **Size:** L
**Depends on:** 070

## Story

As someone moving an Umbraco site, I want its members, users, redirects,
protected pages and scheduled publishing to come across with it, so that nobody
has to reset a password and nothing about how the site behaves is lost.

## Context

070 imports schema, content and views. The report counts these and does not
import them. [`umbraco-import.md`](../../umbraco-import.md), "Where it stands",
records WP-I.5 (site data) as partly built: dictionary and hostnames are
written as files.

- **Members and users.** Umbraco stores ASP.NET Core Identity v3 hashes
  (PBKDF2-HMAC-SHA512). Crombolo stores argon2id, and records the algorithm per
  row in `password_config`. The plan:
  1. Carry the original hash with its algorithm marker.
  2. Teach `verifyPassword` to verify PBKDF2.
  3. Re-hash to argon2id on a successful sign-in. That is the rotation the
     column was kept for, so nobody is forced to reset.

  A bundle deliberately carries no members, so this needs an import path of its
  own.
- **Redirects, protected pages, schedules.** No file format carries them yet.

## Acceptance criteria

- [ ] Members and backoffice users import with their groups, keeping their
      Umbraco password hash with its algorithm marker.
- [ ] `verifyPassword` verifies the PBKDF2 hash, and a successful sign-in
      re-hashes to argon2id.
- [ ] Members and users arrive through an import path of their own, not through
      the content bundle.
- [ ] Redirects import as rules matching 042's model.
- [ ] Protected pages import with their member-group rules.
- [ ] Scheduled publish and expire dates import as schedules.
- [ ] The compatibility report moves each of these from *not imported by this
      version* to imported, with counts.
- [ ] The demo store fixture proves each. Where it has none of a kind, an altered
      fixture does.

## Out of scope

- External and two-factor logins (032), which stay counted and not imported.
- Webhooks (044).
- Razor → TSX conversion offered by the assistant (130).
