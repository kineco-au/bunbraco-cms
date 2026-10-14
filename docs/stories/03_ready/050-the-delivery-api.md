# 050 — The Delivery API

**Epic:** F — Headless · **Priority:** should · **Size:** L
**Depends on:** —

## Story

As a front-end developer, I want to read published content over Umbraco's
Delivery API, so that I can build the site in any framework and use crombolo
headless.

## Context

Not started: there is no `packages/api-delivery` (checked 2026-10-14). The work
covers:

- the whole headless read API
- API-key auth
- the `Api` member kind

It is outside the 513 Management API operations because it is a separate
contract, so `coverage:api` does not show it. It is the largest absence for
anyone wanting headless, and the first of the could-haves in
[`features.md`](../../features.md).

## Acceptance criteria

- [ ] `packages/api-delivery` serves Umbraco's Delivery API contract for
      content and media, vendored and type-checked as the Management API is
      ([`api-contract.md`](../../api-contract.md)).
- [ ] Published content only, per culture, with Umbraco's expansion and field
      selection.
- [ ] API-key auth, and protected content readable by an `Api` member.
- [ ] Served by `web` nodes from the published cache, so it scales with
      rendering, not with the backoffice.
- [ ] Coverage of the Delivery contract is measured the way `coverage:api`
      measures the Management API.

## Out of scope

- Preview over the Delivery API (a later story).
- A GraphQL layer.
