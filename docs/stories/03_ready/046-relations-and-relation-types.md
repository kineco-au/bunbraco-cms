# 046 — Relations and relation types

**Epic:** E — Cross-cutting · **Priority:** could · **Size:** S
**Depends on:** 041

## Story

As a site administrator, I want the backoffice's relation screens to show real
relations, so that the Settings section has no empty areas that look broken.

## Context

"Referenced by" is derived from current values (041), which cannot go stale but
is not a relation table. Relation and relation-type administration answers
empty:

- `relation` is 0/1 and `relation-type` is 1/2.
- `GetRelationType` is a stub in `settings-stubs.ts`.
- The recycle bin's `ReferencedBy` operations are stubs too. The trash and
  delete dialogs therefore cannot warn that other content links to what is
  being removed.

Tag administration (`GetTag`) is already real.

## Acceptance criteria

- [ ] The relation types Umbraco defines are listed, read-only, with the
      relations derived for each.
- [ ] `relation` and `relation-type` operations are real.
- [ ] The recycle bin's `ReferencedBy` operations for documents, media and
      elements answer from the same derivation, so the trash and delete dialogs
      warn.
- [ ] Removed from `settings-stubs.ts`.

## Technical notes

- Derive, as 041 does, rather than add a relation table that a save has to
  maintain. If a user-defined relation type turns out to be needed, that is a
  separate decision.
