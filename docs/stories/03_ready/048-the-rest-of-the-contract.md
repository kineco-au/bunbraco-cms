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

- [ ] Each operation above is real, or recorded in `api-coverage.md` as a
      deliberate divergence with the reason.
- [ ] Dynamic root pickers resolve a picker's start node from a query, as
      Umbraco's do.
- [ ] `is-used` answers from the current values, as references do (041).
- [ ] `coverage:api` shows nothing outside the deliberate divergences.
