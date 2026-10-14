# 041 — References and content-type transfer

**Epic:** E — Cross-cutting · **Priority:** should · **Size:** M
**Depends on:** —

## Story

As an editor, I want to see what refers to a page before I delete it, and as a
developer I want to move a content type between sites as a file, so that
deleting content never breaks links silently and types travel between Umbraco
and crombolo sites.

## Context

*What refers to what* used to answer an empty page, which told an editor that
nothing referenced a document they were about to delete. Umbraco keeps a
`umbracoRelation` row per reference, written on save. Content type export and
import was missing entirely.

## Acceptance criteria

- [x] "Referenced by" and "referenced descendants" answer from the content
      itself, and cannot go stale.
- [x] A content type exported from an Umbraco site imports here, and the other
      way round, as Umbraco's `.udt` XML.
- [x] `import/analyze` reports what an upload is before anything is imported.
- [x] The `schema` endpoints describe a type, and a data type's value, as JSON
      Schema.

## As built

**References** are derived from the current property values rather than a
relation table, so they cannot go stale (a relation table is only as good as
the last save that maintained it) and need no migration.

- A picker stores `umb://document/<hex>` or a bare uuid, so both spellings are
  matched.
- A node never counts as referring to itself.
- "Referenced descendants" ignores references from inside the branch being
  deleted.
- The cost is a scan of `property_value`, which is acceptable for an editor
  asking what breaks.
- Pinned by `tests/references.test.ts`.

**Export and import** speak `.udt`: `Info`, `Structure`, `GenericProperties`
and `Tabs`, with the root naming the kind.

- Aliases are the currency: compositions, allowed children and templates all
  travel by alias, because keys differ between sites.
- Creating from a file mints fresh container and property keys, since the
  file's keys still belong to the type it came from. Updating keeps them,
  because the alias guard has proved the file describes that type.
- Pinned by `tests/content-type-transfer.test.ts`.

## Out of scope

- Relation and relation-type administration, which is 046.
