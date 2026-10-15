# 094 — The form designer edits layout

**Epic:** J — Forms · **Priority:** should · **Size:** M
**Depends on:** —

## Story

As an editor building a form in the backoffice, I want to reorder fields and
lay out pages and columns, so that I can shape a form without editing its file.

## Context

The designer is a table, not a canvas; saving sends the whole definition, the
server writes TOML and reads it back with the strict parser
([`../../forms.md`](../../forms.md), "Backoffice"). The file format already has
pages, groups and `columns`; the designer just cannot edit them yet.

## Acceptance criteria

- [x] Fields can be reordered within a group and moved between groups, with the
      keyboard as well as by dragging.
- [x] Pages and groups can be added, renamed, reordered and removed; removing
      one that holds fields asks first.
- [x] A group's `columns` can be set, and the designer previews the layout.
- [x] The saved file is what a person would have written: the diff of a
      reorder is a move, not a rewrite.
- [x] A save the strict parser refuses is refused in the designer with the same
      message.

## Out of scope

- A visual canvas.

## What was built

- **`packages/backoffice-host/plugin/forms-layout.js`:** the layout operations,
  all pure. Each takes a form and answers a new one:
  - `moveField` and `nudgeField`: the keyboard's one step, crossing into the
    next group at an edge.
  - `addPage`, `movePage`, `removePage` and `setPageCaption`: the last page
    stays.
  - `addGroup`, `moveGroup`, `removeGroup`, `setGroupCaption` and
    `setColumns`, held to 1–4.
  - `layoutRows` for the preview, `pageHasFields` and `groupHasFields` for the
    confirmation, and `withLayout`.
- **The designer** (`forms-overview.js`) edits every page and group, not only
  the first:
  - Each page and group has a title, ↑ and ↓ buttons, and a remove button that
    asks first when fields would go.
  - Each group has a column count and a preview of its rows.
  - Each field row can be dragged (native drag and drop, across groups and
    pages) or moved with its ↑ and ↓ buttons.
  - A choice preview is keyed by its source, so a move that copies the field
    keeps it.
- **A refused save** shows the strict parser's own problems, as before. The
  existing test "an unknown field type is refused by the strict parser" covers
  that.
- **Tests:**
  - `tests/forms-layout.test.ts`: every operation, plus "a reorder's file is the
    same lines in a new order".
  - `tests/forms-backoffice.test.ts`: a two-page layout with a two-column group
    saves and reads back.
  - No browser test: those are run only when asked.

