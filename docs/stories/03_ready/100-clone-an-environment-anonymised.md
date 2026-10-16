# 100 — Clone an environment, anonymised

**Epic:** K — Moving content · **Priority:** should · **Size:** L
**Depends on:** 108

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

## Plan (2026-10-16)

Built after `108`, as agreed: the clone is `pull`, made to require
anonymising, so building 108 first means one implementation, not two.

1. **`crombolo clone <remote|url> [dir] --anonymise [--env <name>]
   [--postgres] [--no-media | --media-info-only]`** (`packages/cli`, on 108's
   remote client):
   1. refuses a `dir` that holds a site;
   2. asks the remote for an anonymised pull, which the remote does, so the
      unsanitised copy never leaves it;
   3. downloads the file, which is sealed with a passphrase generated for this
      clone and kept in memory;
   4. checks the file before anything is written locally (step 3 below);
   5. starts it as `start --from` does, on SQLite unless `--postgres`.
2. **Without `--anonymise`** it refuses (exit 2), unless `--trusted` says the
   destination may hold personal data. `--trusted` is then a full pull, which
   needs the full-pull permission on the remote.
3. **The clone verifies its own copy.** Sanitising runs on the remote, but the
   clone doesn't take that on trust. Before starting the site it checks the
   opened file:
   - no back-office users;
   - members only as placeholders;
   - no address outside `example.invalid` in any value, name, dictionary item
     or person.

   If any check fails, it refuses and names what it found. Story 100's "runs
   before the copy is written" then holds for a remote that is not this CMS
   too.
4. **The sanitiser covers what the story names.** `transfer/src/sanitise.ts`
   already does users, members and addresses. Tokens, sessions, external
   logins and form entries are never exported, and a test now asserts that
   rather than assuming it.
5. **Docs:** `docs/content-transfer.md` (the down direction, which is "Still
   open" there today), `docs/remote-protocol.md` (what an anonymised pull
   promises), and the CLI help.

**Tests** (`tests/clone.test.ts`, both dialects), against the CMS server as a
remote:
- **The source site** carries an administrator, a second user, members, form
  entries, an external login, a device sign-in and addresses in content and
  the dictionary.
- **The cloned database:** no row contains any of the source's email
  addresses, token hashes or session ids (checked by scanning every table),
  and no `external_login`, `auth_token` or `form_entry` row came from the
  source.
- **Refusals:** a clone without `--anonymise` and without `--trusted` is
  refused before anything is fetched, and a doctored pull containing an
  address is refused by the clone's own check.
