# 027 — The Library section (elements)

**Epic:** C — The backoffice, end to end · **Priority:** should · **Size:** M
**Depends on:** 024

## Story

As an editor, I want to create, publish and organise reusable elements in the
Library section. As a site developer, I want to render those published
elements in a template. Together, content that is shared across pages is
written once and goes live when it is published.

## Context

Epic framing and shared decisions are in 020. The Library's Create dialog
offered nothing but Folder.

**Umbraco 18 made elements first-class.** An element is publishable,
versioned content with no URL and no template
(`IElement : IPublishableContentService<IElement>`). Elements are gathered in
folders and trashed into a bin of their own. Only 4 of the 25 element
operations were implemented. The tree and its folders already existed,
because a folder is a plain node.

**Most of the machinery already existed.** An element is a node facet exactly
as a document is, so `DocumentRepository` took `element` as a fifth `kind`:
object type Element, container ElementContainer, recycle bin `-22`. Elements
inherit versioning, publishing, validation, copy, move, restore and cleanup
from that.

**The empty Create dialog was correct.** It reads
`document-type/allowed-in-library`, which already behaved correctly: Umbraco
offers a type there only when it is *both* an element type and flagged for
the library. `apps/site` had no such type, so the dialog had nothing to show.

## Acceptance criteria

- [x] All 25 element operations are real, and `element-version` 4/4.
- [x] **The editor:**
  - create, read and save
  - `validate` (both calls)
  - create-and-publish, update-and-publish, publish and unpublish
  - the published read and `configuration`

  Draft saves stay permissive and publishing enforces `mandatory`. That is
  Umbraco's rule, and the one documents already follow.
- [x] **The tree** mixes folders and elements in one listing, with ancestors,
      siblings, the item lookups a picker makes, and search.
- [x] **Moving, copying and the bin:**
  - move, and copy with a free name
  - move-to-recycle-bin, restore and empty
  - original parent and delete

  Folders move and are trashed too.
- [x] **History:** versions, reading a version back, rollback,
      prevent-cleanup and the audit log.
- [x] References.
- [x] A published element is readable by a template.

## As built

**What is new.** `adapters/elements.ts` (the port), `handlers/element.ts` (the
25 operations), and migration 016's single row.

**Tree shape.** A folder reports `documentType: null` and a single
`NotCreated` variant. The contract makes both fields nullable or valued
precisely for that row. An element reports its type and its variants'
publish state.

**Folders move and are trashed**, which no other area's folders do. Those two
operations therefore live on the element port rather than the shared
`FolderPort`. The document repository's `move` refuses anything that is not an
element, so a folder moves through the node repository with the same two
rules.

**History** goes through the same shared helper that documents and media use.

**References came for free.** The reference repository derives "what points
at this?" from current property values and is generic over object type, so
adding `Element` to its area list was one line.

**Rendering**

- **The cache.** A published element is held in the published cache.
  Publishing one changes what a visitor sees, and unpublishing one drops it
  from the pages that picked it.
- **The picker.** Umbraco's selection editor is a first-class
  `Umbraco.ElementPicker`, not a repurposed tree picker. Its value is a bare
  `Guid[]`, not udis. It resolves by key and always yields a collection. An
  element not published in the ambient culture is dropped on read.
- **No new built-in.** Umbraco seeds no data type for the picker, so the 37
  built-ins needed no addition. A site declares its own data type, as
  `tests/elements.test.ts` does.
- **Culture views.** Elements live in the culture views rather than in one
  global map. The culture filtering that Umbraco does with an explicit
  `IsPublished(culture)` check is structural here: an element the culture
  cannot see is simply not in its view.
- **Loading.** `loadElements()` reuses the query that builds the content
  cache. `loadPublished()` is keyed on the repository's own object type, and
  only ever needed `kind: 'element'` passed to it.
- **Invalidation** was already in place: the element port writes an
  `{ elements: true }` cache instruction on every change.
- **Generated types.** `crombolo generate` narrows a pick to its element type
  from the picker's `allowedContentTypes`, reusing `TypedElement<T>`.
- The full design is in [`../../rendering.md`](../../rendering.md), under
  "Published elements".

**Tests.** `tests/elements.test.ts` pins this on both dialects, covering:

- the allowed-in-library list
- the mixed tree, with ancestors, siblings, items, folder-items and search
- the editor round trip
- the draft-permissive, publish-strict rule with its JSON-path errors
- publish, and the published read against a newer draft
- create-and-publish refusing before it creates anything
- move, copy and folder-move, with the below-itself refusals
- the bin: trash, list, original parent, restore and empty
- a trashed folder taking its branch unpublished with it
- versions, rollback and prevent-cleanup
- the audit log, and the reference endpoints answering

API coverage went from 426 to **459/513**.
