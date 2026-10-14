# 004 — Schema and content types

**Epic:** A — Foundations · **Priority:** must · **Size:** L
**Depends on:** 003

## Story

As a site developer, I want to create a content type with tabs, properties and
a template in the backoffice and have it persist, so that there is a model to
create content against.

## Context

This is the Tier 1–2 schema: content-type services (compositions, groups,
allowed children, variance), data types and core property-editor value
handling, and the `tree`/`item` endpoints for types and folders.

Two decisions shape everything after it. `node` is the universal polymorphic
tree, as in Umbraco. And a content type is written as one aggregate document —
groups, properties, compositions, allowed children and allowed templates
together — rather than row by row. Templates' views live on disk.

Types later moved into files: see 011 and
[`../../schema-as-code.md`](../../schema-as-code.md).

## Acceptance criteria

- [x] The full Tier 1–2 migration.
- [x] Content-type services: compositions, groups, allowed children, variance.
- [x] Data types and core property-editor value handling.
- [x] `tree`/`item` endpoints for types.
- [x] Create a content type with tabs, properties and a template in the real
      backoffice, reload, and it persists.
- [ ] ~~Content-type folders, copy, move, import/export, and the media and
      member type trees.~~ **Not built here**; carried into Epic C (021, 023)
      and 030.

## As built

- `node` as the universal polymorphic tree.
- The content-type aggregate written as one document.
- 13 seeded data types, keyed with Umbraco's own GUIDs.
- Templates whose views live on disk.
- Variance stored as the flags byte on both the type and the property, so the
  intersection rule holds.
