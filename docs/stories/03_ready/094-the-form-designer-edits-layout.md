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

- [ ] Fields can be reordered within a group and moved between groups, with the
      keyboard as well as by dragging.
- [ ] Pages and groups can be added, renamed, reordered and removed; removing
      one that holds fields asks first.
- [ ] A group's `columns` can be set, and the designer previews the layout.
- [ ] The saved file is what a person would have written: the diff of a
      reorder is a move, not a rewrite.
- [ ] A save the strict parser refuses is refused in the designer with the same
      message.

## Out of scope

- A visual canvas.
