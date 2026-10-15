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

- [x] With `step-pages = true` the form renders one page at a time, with next
      and back controls.
- [x] Moving forward validates the current page on the server; errors are shown
      on that page.
- [x] Earlier answers survive back and forward without being stored as an entry.
- [x] Conditions that refer to fields on earlier pages still work.
- [x] ~~Without JavaScript the form still steps, a round trip per page.~~
      Restated (2026-10-15): without JavaScript, every page shows on one form
      and is validated on submit.
- [x] Without `step-pages` the current behaviour is unchanged.

## Out of scope

- Saving a partly completed form to resume later.

## Decision (2026-10-15)

The stepping happens in the browser. Every page is already rendered into one
`<form>`, so the script shows one at a time, and answers never leave the
browser until the final submission. That removes the problem of carrying
earlier answers between round trips, which file uploads made hard. In exchange,
the no-JavaScript criterion is restated: without JavaScript every page shows
together and is checked on submit, which is today's behaviour.

## What was built

- **The file:** `step-pages` on `[form]`, parsed and written (left out when
  off) and coerced from the designer. The designer has a "Show one page at a
  time" toggle, with the Next and Back button labels, shown for a form with
  more than one page.
- **The renderer:** `data-step-pages="true"` on the form, and Back and Next
  buttons (`previous-label`, `next-label`) rendered `hidden`. Off, the markup is
  unchanged.
- **The script** (`form-script.ts`):
  - `layout` shows the current page and the right buttons. `neighbour` finds
    the next reachable page, skipping those whose condition hides them.
  - Next posts `_crombolo_page`, shows the page's errors, or moves on. A failure
    to reach the server moves on too, since the submission checks everything.
  - Enter means Next, and after a refused submission the form opens on the
    first page with an error.
  - A page's condition is held as `data-condition-hidden`, so conditions and
    stepping do not fight over `hidden`.
- **The endpoint:** a check mode in `submitForm`, the outcome `checked`. It
  verifies the token, then checks one page against all the answers. It refuses
  an upload by name and size and writes nothing. It never stores an entry or
  queues a workflow, and always answers in JSON.
- **Tests:** `tests/forms-steps.test.ts`, on both dialects:
  - the stepper on a stand-in form (first, last, skipped and closing pages);
  - the file round-trip;
  - stepped and unstepped markup;
  - a page check that names only its own problems, stores nothing and writes no
    upload;
  - a refused upload;
  - a later page checked against an earlier answer;
  - the final submission as before.

