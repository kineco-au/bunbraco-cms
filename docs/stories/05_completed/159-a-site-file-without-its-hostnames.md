# 159 — A site file without its hostnames

**Epic:** K — Moving content · **Priority:** should · **Size:** S
**Depends on:** 104, 105

## Story

As a developer copying a site to another environment, I want the whole-site
file to be able to leave out the site's hostnames, and a replace to keep
the target's own, so that the copy runs at its own address instead of
routing as the original.

## Context

A site's cultures and hostnames (`data/src/repositories/domains.ts`) are
where a multi-root site decides which root answers which address. The
whole-site file (`104`) carries them, and a replace (`105`) applies them. That
is right when moving a site to a new host for good. It is wrong when
copying it alongside the original — production to a staging copy, or a
live site onto a laptop. The copy then holds the original's hostnames:
- a multi-root site routes by addresses it does not answer on;
- its default root can change.

## Acceptance criteria

- [x] ~~`exportSite` takes `hostnames: false`~~ — not needed: the file never
      carries culture-and-hostname rows (see Outcome)
- [x] A replace leaves the target's own culture-and-hostname rows as they
      were, on every page the file also carries
- [x] A remote's anonymised pull leaves them out — it is built from the same
      export, so it never carries them either
- [x] ~~A file that does carry them replaces them as today~~ — no file does
- [x] Tests: the file carries no hostname; a replace keeps the target's

## Out of scope

- Rewriting hostnames to the target's addresses: the target keeps what it
  has.

## Outcome

Closed as already true; pinned by a test rather than built.

The story assumed the whole-site file carries culture-and-hostname rows and
that a replace applies them. Neither is so, and neither was when 104 and 105
landed: domains are on `content-transfer.md`'s "What never travels" list beside
sessions and tokens, `exportSite` has no domain step, and a replace re-applies
the target's own `domains.toml` (when it has one) after the import
(`installBundleContent`). A remote pull is built from the same export, so it
never carries them either. A copy therefore cannot route as the original.

`tests/site-replace.test.ts` › "hostnames" now pins both halves: a site with a
hostname exports a file in which the hostname appears nowhere, and a staging
copy holding the same pages keeps its own hostname across a second replace.

**The one edge, left as documented:** a hostname bound only in the back office
to a page the file does not carry goes with that page — recycled by
`--replace`, deleted by `--replace-all`. That happens when the target's root has
a different key from the source's. A site that is copied onto should declare
its hostnames in `domains.toml`, which is re-applied after every replace.
Re-binding them onto the file's page at the same path was considered and not
taken.
