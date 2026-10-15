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

- [x] The relation types Umbraco defines are listed, read-only, with the
      relations derived for each.
- [x] `relation` and `relation-type` operations are real.
- [x] The recycle bin's `ReferencedBy` operations for documents, media and
      elements answer from the same derivation, so the trash and delete dialogs
      warn.
- [x] Removed from `settings-stubs.ts`.

## Technical notes

- Derive, as 041 does, rather than add a relation table that a save has to
  maintain. If a user-defined relation type turns out to be needed, that is a
  separate decision.

## What was built

- **`packages/data/src/relations.ts`:**
  - `RELATION_TYPES`: Umbraco's nine relation types, in install order. Their
    keys come from `nameBasedUuid(alias____name)`, which is Umbraco's
    `string.ToGuid()` (a version-3 UUID in the URL namespace).
    `relateDocumentOnCopy` gets `4cbeb612-e689-3563-b755-bf3ede295433`, as a
    real install has.
  - Pure functions `referencedKeysIn` and `deriveReferences`.
  - `loadReferences`, one scan of the current values.
  - `RelationRepository`, which derives each type's relations and lists what
    refers to items in a recycle bin.
- **`ReferenceRepository.referencingRecycleBin`** shapes those referrers as the
  existing references list does.
- **The API**, in `packages/api-management/src/handlers/relations.ts`, with a
  `RelationPort` behind it:
  - `GetRelationType`, `GetRelationTypeById` (404 when unknown) and
    `GetItemRelationType` (never deletable).
  - `GetRelationByRelationTypeId`, paged and ordered by parent name then child
    name.
  - `GetRecycleBin{Document,Media,Element}ReferencedBy`, 20 at a time as Umbraco
    pages them.
  - Server adapter: `packages/server/src/adapters/relations.ts`.
- **Removed:** the stub entries and the planned-area entries for 046. API
  coverage is now 500/513.
- **Tests:** `tests/relations.test.ts`, on both dialects.

## Decisions

- Following the technical notes, relations are derived, and no relation table
  was added. Two relation types therefore always have no relations: a copy
  records no origin, and element containers are not trashed.
- A relation's creation date is derived too. For a reference, it is the
  referring item's latest save. For a trashed item, it is the item's latest
  version, because when it was trashed is not recorded.
- The recycle bins report every item that refers to something in the bin, as
  Umbraco's `GetPagedRelationsForRecycleBin` does, including referrers that are
  themselves trashed.

