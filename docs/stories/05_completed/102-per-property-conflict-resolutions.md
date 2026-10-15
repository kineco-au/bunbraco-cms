# 102 — Per-property conflict resolutions

**Epic:** K — Moving content · **Priority:** could · **Size:** M
**Depends on:** —

## Story

As a developer importing content, I want to keep the local value of one
property of a page while taking the incoming value of the rest, so that an edit
made in production is not lost to a transfer that changed something else.

## Context

Resolutions such as `keep-local` are per node today; a conflict on one property
cannot be answered differently from the rest
([`../../content-transfer.md`](../../content-transfer.md), "Resolutions").
Values are append-only, so a mixed result is one new version.

## Acceptance criteria

- [x] A resolution can name a node and a property alias, and culture where the
      property varies.
- [x] The dry run reports conflicts per property, so there is something to name.
- [x] Applying a mix writes one version holding the chosen value of each
      property.
- [x] A node-level resolution still applies to every property not named.
- [x] A revert undoes a mixed run like any other.

## Out of scope

- Merging inside one value (rich text, block lists).

## Decision (2026-10-15)

**Nested per node, and the old shape is gone.** `resolutions.json`'s `byNode`
maps a node key to an object: `"*"` answers the whole node, and `"<alias>"` or
`"<alias>@<culture>"` answers one property, overriding `"*"` for it. Files in
the old flat shape are not read: none are kept anywhere. On the command line it
is `--resolve <node>=…` for the node, and `--resolve <node>/<alias>[@<culture>]=…`
for a property.

## What was built

- `check.ts`: one `local-edit` finding per differing property and culture,
  naming the handle to answer it with (`<key>/<alias>[@<culture>]`). The answer
  is found by `answerFor` — culture, property, `"*"`, then `--resolve-all` —
  and the plan carries the handles kept as `keepLocal`.
- `import.ts`: the overlay leaves the kept handles out, so a mix is one new
  version; a node whose every difference is kept writes nothing. The revert is
  unchanged: it restores the version before the run.
- `resolutions.ts`: `parseResolveFlags`, `mergeResolutions` (saved answers
  under the caller's, per property) and the nested `byNode` file. The flat
  shape is refused by name; `skip` is for a whole node only.
- Tests: `tests/transfer-rehearse.test.ts` (findings per property, a mixed run
  and its revert, a node-level answer filling the rest, keeping everything, the
  pure helpers), with `content-check` and `content-import` moved to the nested
  shape. Documented in `docs/content-transfer.md`, "Resolutions".
