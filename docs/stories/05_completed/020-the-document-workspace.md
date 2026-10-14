# 020 — The document workspace

**Epic:** C — The backoffice, end to end · **Priority:** must · **Size:** M
**Depends on:** 005, 015

## Story

As an editor, I want to create a page with "Save and publish", be told exactly
which field is wrong when I can't, and find the page in the tree afterwards,
so that the most basic thing a CMS does works in the real backoffice without
an error toast.

## Context

This is the first package of Epic C. Epic C widens the CMS one work package at
a time, ordered by one question: what does the **create content type →
publish page** journey still hit that answers 501, or that a real editor would
reach for and find missing? The first three packages (020, 021, 022) complete
that journey in the real backoffice; the rest widen outward from it. Each
package has its own exit criterion, updates
[`../../api-coverage.md`](../../api-coverage.md), and is green on both
dialects before the next starts.

When the epic started, the journey called these operations, all answering 501.
They were found by reading the client's data sources, not by guessing:

- The document workspace loads `GetDocumentConfiguration` and validates
  through `PostDocumentValidate` / `PutDocumentByIdValidate` before every save.
  Its "Save and publish" is `PostDocumentCreateAndPublish` /
  `PutDocumentByIdUpdateAndPublish`.
- The content tree renders a Recycle Bin node (`GetRecycleBinDocumentRoot`)
  and deep-links through `GetTreeDocumentAncestors`.
- The document-type workspace loads `GetDocumentTypeConfiguration`. Its
  Compositions tab posts `PostDocumentTypeAvailableCompositions`, "Create
  template" posts `PostDocumentTypeByIdTemplate`, and pickers search with
  `GetItemDocumentTypeSearch`.
- The property editor picker lists data types with `GetFilterDataType`.

### Decisions taken before this story started

These apply to the whole epic:

- **Folders live in the files.** A `folder = "Pages/Blog"` key on a document
  type's or data type's file. The sync creates the folder path in the tree,
  and the backoffice's folder actions write it. There are no database-only
  folders.
- **Media and member types are files too.** They live in
  `schema/media-types/` and `schema/member-types/`, with the same vocabulary,
  the same sync and the same promotion as content types.
- **Verification is API tests per endpoint**, plus a manual checklist per
  package in [`../../testing.md`](../../testing.md). No browser tests until
  asked. Browser tests were added later for several packages, when asked.

## Acceptance criteria

- [x] `GetDocumentConfiguration` answers.
- [x] `PostDocumentValidate` and `PutDocumentByIdValidate` return Umbraco's
      JSON-path `errors` shape for the mandatory rule, the regex rule and the
      pending rule. A field the editor shows in red is exactly the one the
      server refuses.
- [x] `PostDocumentCreateAndPublish`, `PutDocumentByIdUpdateAndPublish` and
      `GetDocumentByIdPublished` answer.
- [x] Tree completeness: `GetTreeDocumentAncestors`,
      `GetTreeDocumentSiblings`, `GetItemDocumentAncestors` and
      `GetItemDocumentSearch`.
- [x] The recycle bin tree answers (`GetRecycleBinDocumentRoot`, `Children`,
      `OriginalParent`), so the node the tree always renders does not error.
      Restore and empty came with 024.
- [x] Save and publish responses carry the `Umbraco-Notifications` header, so
      the client's toasts say what happened.
- [x] **Exit.** In the real backoffice, with `apps/site`'s TOML type:
  - "Save and publish" with a mandatory field empty marks the field and
    creates nothing.
  - Filling the field in creates the page, publishes it and renders it.
  - A reload deep-linked to the page works.
  - The tree shows the page and the Recycle Bin without an error toast.

  API tests cover each endpoint. The UI steps are a manual checklist in
  [`../../testing.md`](../../testing.md).

## As built

- `tests/documents.test.ts` "WP-6.1" pins the story:
  - validation errors by index and by filter expression, exactly as Umbraco
    emits them
  - create-and-publish refusing before it creates anything
  - the published read against a newer draft
  - ancestors, siblings and search
  - the recycle bin with the original parent, which migration 006 records
- The content tree returns the contract's `DocumentTreeItemResponseModel` in
  full (content type, variants with state, ancestors and dates), not the
  generic item.
- The manual checklist is in [`../../testing.md`](../../testing.md).
- API coverage 61/513.

## Out of scope

- Restore and empty in the recycle bin: 024.
- The Settings section: 021.
