# 090 — Choices from a prevalue source

**Epic:** J — Forms · **Priority:** should · **Size:** M
**Depends on:** —

## Story

As a site builder, I want a choice field's options to come from a list I
maintain once — content, a dictionary, or a fixed file — so that ten forms
asking for a department do not each carry their own copy of the list.

## Context

`dropdown`, `singleChoice` and `multipleChoice` take manual `values` only
([`../../forms.md`](../../forms.md), "Field types"). Umbraco Forms calls the
alternative a prevalue source. The field-type set is closed and the TOML,
validator, renderer and entry shape must agree, so a source has to resolve to
the same `values` array everywhere those four read it — at render, at
server-side validation, and in the designer — rather than becoming a second
shape.

## Acceptance criteria

- [ ] A choice field accepts `source = { … }` instead of `values`; the
      validator refuses both together, and an unknown source kind by name.
- [ ] At least two source kinds: the children of a content node (name and key)
      and a dictionary of items.
- [ ] Rendering and server-side validation resolve the source the same way, so a
      submitted value outside the current list is refused.
- [ ] An entry stores the submitted value, so an entry stays readable after the
      source changes.
- [ ] The designer edits a source and shows the options it currently resolves to.
- [ ] `parseForm(writeForm(x))` still equals `x` with a source present.

## Out of scope

- Sources that call an external URL.
- Field types other than the three choice fields.
