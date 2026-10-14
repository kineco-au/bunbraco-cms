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

- [ ] A resolution can name a node and a property alias, and culture where the
      property varies.
- [ ] The dry run reports conflicts per property, so there is something to name.
- [ ] Applying a mix writes one version holding the chosen value of each
      property.
- [ ] A node-level resolution still applies to every property not named.
- [ ] A revert undoes a mixed run like any other.

## Out of scope

- Merging inside one value (rich text, block lists).
