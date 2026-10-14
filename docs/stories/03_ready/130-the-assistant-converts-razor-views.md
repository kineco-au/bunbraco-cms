# 130 — The assistant converts Razor views

**Epic:** N — The assistant · **Priority:** could · **Size:** M
**Depends on:** 070

## Story

As a developer who has imported an Umbraco site, I want the assistant to offer a
TSX version of each Razor view, so that I start from a working draft rather than
an empty stub.

## Context

The importer writes a TSX stub per template, with the original Razor beside the
report ([`../../umbraco-import.md`](../../umbraco-import.md)). The assistant
already proposes TSX under guardrails and a person applies each proposal
([`../../assistant.md`](../../assistant.md)). Conversion is a proposal like any
other: reviewed per view, never applied in bulk.

## Acceptance criteria

- [ ] From an imported view's stub, the assistant proposes a TSX conversion
      using the original Razor and the site's content types.
- [ ] The proposal passes the existing TSX guardrails and `components check`
      before it is offered.
- [ ] Partials, macros and injected services it cannot convert are left as
      marked gaps, listed in the proposal.
- [ ] Nothing is written until a person applies the proposal.

## Out of scope

- Converting custom C#.
