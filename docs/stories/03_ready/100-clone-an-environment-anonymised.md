# 100 — Clone an environment, anonymised

**Epic:** K — Moving content · **Priority:** should · **Size:** L
**Depends on:** —

## Story

As a developer, I want a copy of production to work against, with personal data
removed, so that I can reproduce a problem on real content without putting
users' details on a laptop.

## Context

Content transfer moves content up between environments
([`../../content-transfer.md`](../../content-transfer.md)). The down direction
is a whole-environment copy, mostly orchestration over `pg_dump` or a file copy
plus a media sync — but it needs a sanitise step, because production users,
members, tokens and e-mail addresses must not land on a laptop.

## Acceptance criteria

- [ ] `crombolo clone --anonymise <source>` produces a working local database and
      media store from a source environment, on SQLite or Postgres.
- [ ] Sanitising replaces or removes: backoffice users bar one local
      administrator, members, tokens and sessions, external logins, form entry
      values marked sensitive, and e-mail addresses anywhere they are stored.
- [ ] Sanitising runs before the copy is written to the destination, so an
      unsanitised copy never exists there.
- [ ] A test asserts no row of the sanitised copy contains a source e-mail
      address or token.
- [ ] Without `--anonymise` the command refuses unless told the destination is
      trusted.

## Since: a whole site in one file (`104`, `105`)

The copy this story makes is `104`'s whole-site file, written with
`--anonymise`, and started by `105`, and fetched from a remote by `108`'s
`pull` (`107`). So `crombolo clone --anonymise` is `pull` with anonymising
required, and the sanitising here is the one `104`'s `--anonymise` uses:
there is one, not two.
