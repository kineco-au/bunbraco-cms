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

- [x] A choice field accepts `source = { … }` instead of `values`; the
      validator refuses both together, and an unknown source kind by name.
- [x] At least two source kinds: the children of a content node (name and key)
      and a dictionary of items.
- [x] Rendering and server-side validation resolve the source the same way, so a
      submitted value outside the current list is refused.
- [x] An entry stores the submitted value, so an entry stays readable after the
      source changes.
- [x] The designer edits a source and shows the options it currently resolves to.
- [x] `parseForm(writeForm(x))` still equals `x` with a source present.

## Decisions

- **Options have a key and a label.** The key (page key, dictionary item key) is
  stored; the label (page name, item translation) is shown. An entry also keeps
  the label it was submitted with, in `form_entry_value.label` (migration 034),
  so it reads after a rename or a removal.
- **TOML:** `source = { kind = "content", parent = "<page key>" }` or
  `source = { kind = "dictionary", parent = "<item name>" }`.
- **Content sources offer published children only**, in sort order.

## What was built

See [`forms.md`](../../forms.md), "Choices from a source".

- **Model:** `ChoiceSource`, `ChoiceOption`, `choiceOptions` and
  `withResolvedChoices` in `@crombolo/core`; the schema package's copy of the
  form model is now a re-export of it, so there is one.
- **Parser, writer and validator:** the inline table round-trips; both values
  and a source, an unknown kind, a content parent that is not a key, and a
  source on a non-choice type are each refused by name.
- **One resolution:** the published cache's `resolveChoices` (with the
  dictionary outline now in the snapshot) fills `options` for a picked form, for
  a submission (in the culture of the page it came from) and for the designer.
  The renderer and `validateSubmission` read `choiceOptions`, so a key outside
  the current list is refused.
- **Entries** store the key and the label; entry views, CSV and e-mail text show
  labels, and an edit in the backoffice keeps them.
- **Designer:** a choice field's options come from typed values, a page's child
  pages (document picker) or a dictionary item's children, with "Offers now: …"
  from `POST …/api/forms/choices`.
- **Tests:** `tests/forms-sources.test.ts`.

## Out of scope

- Sources that call an external URL.
- Field types other than the three choice fields.
