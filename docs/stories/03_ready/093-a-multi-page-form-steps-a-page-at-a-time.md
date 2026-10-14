# 093 — A multi-page form steps a page at a time

**Epic:** J — Forms · **Priority:** could · **Size:** M
**Depends on:** —

## Story

As a visitor filling in a long form, I want each page checked when I move to
the next one, so that I find out about a mistake on page one before I reach
the end.

## Context

A multi-page definition renders every page into one `<form>` and arrives in one
submission ([`../../forms.md`](../../forms.md), "Rendering").
`validateSubmission` already takes the page to check, so stepping is a
refinement on the same shape. It must keep working without JavaScript.

## Acceptance criteria

- [ ] With `step-pages = true` the form renders one page at a time, with next
      and back controls.
- [ ] Moving forward validates the current page on the server; errors are shown
      on that page.
- [ ] Earlier answers survive back and forward without being stored as an entry.
- [ ] Conditions that refer to fields on earlier pages still work.
- [ ] Without JavaScript the form still steps, a round trip per page.
- [ ] Without `step-pages` the current behaviour is unchanged.

## Out of scope

- Saving a partly completed form to resume later.
