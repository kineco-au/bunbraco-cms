# 048 — The rest of the contract

**Epic:** E — Cross-cutting · **Priority:** could · **Size:** M
**Depends on:** —

## Story

As an editor, I want every control the backoffice offers to work, so that no
screen fails with an error because the server behind it was never written.

## Context

The odds and ends `bun run coverage:api` still reports after everything else in
this epic:

- dynamic root pickers (`dynamic-root`, 0/2)
- `document/{id}/patch`
- `object-types` (0/1)
- `data-type/{id}/is-used` and `property-type/is-used` (0/1)
- `help` (0/1)
- `item/static-file`, and the static-file tree (stubbed empty)
- `DELETE /preview`

Some of these are deliberate divergences and stay 501: the install wizard and
the upgrade endpoints, the template query builder (Razor-specific) and
segments without a provider. This story does not change them. See "Deliberate
divergence" in [`roadmap.md`](../../roadmap.md).

## Acceptance criteria

- [x] Each operation above is real, or recorded in `api-coverage.md` as a
      deliberate divergence with the reason.
- [x] Dynamic root pickers resolve a picker's start node from a query, as
      Umbraco's do.
- [x] `is-used` answers from the current values, as references do (041).
- [x] `coverage:api` shows nothing outside the deliberate divergences — and the
      operations of stories `044` (webhooks) and `046` (relations), each listed
      under the story that builds it.

## Decisions

- **Document patch: built.** Umbraco's spec is a JSON Patch over the update
  model with filter segments, so the general form is implemented rather than a
  few fixed paths; it covers the agreed subset (values and variant names) and
  block values with it.
- **Static files: the served stylesheets and scripts.** There is no general web
  root, so the picker lists `/css/` and `/scripts/` — what the site serves — by
  their URLs.

## What was built

- **Document patch** (`applyJsonPatch` in `@crombolo/core`, `PatchDocumentByIdPatch`):
  replace, add and remove over filters, indexes and `/-`, applied to a copy; the
  result saves through the same path as PUT. 400 / 422 / 404 as Umbraco's spec.
- **Dynamic roots** (`DynamicRootRepository`): the six origins and four steps;
  `Site` is the nearest ancestor-or-self with a hostname, falling back to `Root`.
- **is-used** for data types and property types, from current saved values.
- **Static-file tree and items** over the two served folders (`handlers/static-files.ts`);
  the stubs are gone.
- **`object-types`**, **`help`** (an empty list, as the news dashboard is) and
  **`template/configuration`**, which no story owned.
- **`DELETE /preview`** was already answered by a real server; the preview port
  now comes from `createDeps`, so `coverage:api` counts it.
- **Coverage report:** `DELIBERATE_DIVERGENCES` (install and upgrade, with
  reasons) and `PLANNED_AREAS`/`PLANNED_OPERATIONS` in
  `packages/api-management/src/divergences.ts`; `docs/api-coverage.md` lists both,
  and a test fails on any 501 that is in neither.
- **Tests:** `tests/contract-rest.test.ts`.
