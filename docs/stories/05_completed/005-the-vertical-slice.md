# 005 — The vertical slice

**Epic:** A — Foundations · **Priority:** must · **Size:** L
**Depends on:** 004

## Story

As an editor, I want to create a page, edit it, save a draft, publish it, see
it rendered at its URL and roll back a version, so that the CMS does the one
job a CMS has, end to end.

## Context

The slice runs from the backoffice to a rendered page: documents (create,
update, validate, publish, unpublish), draft vs published storage, versioning,
rollback and `prevent_cleanup`, the tree, collection and recycle bin, publish
notifications, the published cache, URL routing, the TSX renderer, and
templates as files.

The publish model is Umbraco's. Saving a draft creates no version; publishing
freezes the draft and forks a new one; `edited` is recomputed by comparing
draft against published; rollback writes into the draft without touching
history; a publish below an unpublished ancestor is refused. (011 later
changed two of these on purpose: every save is a version, and rollback
appends.)

Rendering resolves a route by walking the published tree, runs a `.tsx`
template through a JSX-to-HTML runtime, and applies the layout chain declared
in the file. See [`../../rendering.md`](../../rendering.md).

## Acceptance criteria

- [x] Create a page → edit → save draft → publish → see it rendered at its
      URL → roll back a version. Verified end to end over real HTTP as well as
      in tests.
- [x] Documents: create, update, publish, unpublish; draft vs published
      storage; versioning, rollback and `prevent_cleanup`.
- [x] Tree, collection and `move-to-recycle-bin`; publish notifications; the
      published cache; URL routing; the TSX renderer; templates as files.
- [ ] ~~The rest of the document surface.~~ **Not built here**, carried into
      Epic C (020, 024, 025): the `validate` endpoints and the JSON-path
      `errors` shape, move/copy/sort, recycle-bin restore and empty,
      scheduled publishing, publish-with-descendants, preview, segments, and
      domain/culture routing. Culture variants were stored and returned but
      only exercised invariantly.

## As built

- The publish model above, and the route walk, JSX runtime and layout chain.
- `umbracoUrlAlias` was built later; see [`../../seo.md`](../../seo.md).
