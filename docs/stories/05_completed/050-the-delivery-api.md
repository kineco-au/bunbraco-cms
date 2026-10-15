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

- [x] `packages/api-delivery` serves Umbraco's Delivery API contract for
      content and media, vendored and type-checked as the Management API is
      ([`api-contract.md`](../../api-contract.md)).
- [x] Published content only, per culture, with Umbraco's expansion and field
      selection.
- [x] API-key auth, and protected content readable by an `Api` member.
- [x] Served by `web` nodes from the published cache, so it scales with
      rendering, not with the backoffice.
- [x] Coverage of the Delivery contract is measured the way `coverage:api`
      measures the Management API.

## Out of scope

- Preview over the Delivery API (a later story).
- A GraphQL layer.

## Decision (2026-10-15)

- **Contract**: Umbraco's generic Delivery API contract at `release-18.2.0` —
  the integration suite's `ExpectedContracts/default.json`, since Umbraco
  generates the spec at runtime and commits no file of it. Eight operations,
  content and media. A per-site typed contract can follow as its own story.
- **Off by default**, as Umbraco's `DeliveryApi:Enabled` is; switched on in
  `crombolo.config.ts` or by environment, with Umbraco's `PublicAccess`,
  `ApiKey` and disallowed content types.
- **Both member flows**, as Umbraco's `MemberAuthorization` has them:
  client credentials for members named in config with a client id and secret
  (those members show as kind `Api`, which is derived, not stored), and the
  authorization code flow with PKCE, refresh and sign-out, for members signing
  in from a browser or app. Protected items answer 401 or 403 and are filtered
  out of queries, as in Umbraco.
- **Umbraco's behaviour is copied**, including a disabled API answering 401,
  an invalid or expired token counting as anonymous, and empty bodies on 401,
  403 and 404 — except four security quirks, fixed instead:
  - a members-only page never appears in a query for a caller who cannot open
    it (Umbraco returns them when member sign-in is off);
  - signing out revokes that member's tokens (Umbraco only clears the cookie);
  - an access token is accepted from the `Authorization` header or the form
    body, never `?access_token=`;
  - PKCE must be S256 (Umbraco also allows `plain`).
- **Browser sign-in goes to a configured login page**: a setting names the
  site page with the member login form; the visitor signs in there and is
  returned to finish the authorization. Without it, the browser flow refuses
  with a clear error. (Umbraco sends them to ASP.NET's default
  `/Account/Login`.)

The research behind this — Umbraco 18.2's output shapes, query and
expansion rules, and the security flows, with file references — is in
[`050-research/`](050-research/).

## What was built

- `packages/contracts/DeliveryApi.json` and `generated/delivery-api.d.ts`
  (`loadDeliverySpec`, `DeliverySchemas`, `DeliveryResponseOf`), pinned by
  `tests/delivery-contract.test.ts`.
- `packages/api-delivery`: settings with Umbraco's defaults
  (`resolveDeliveryApiSettings`), access (`contentAccess`, `mediaAccess`), the
  `expand`/`fields` grammar, the query parsers, members-only rules
  (`accessTo`), the output builder, the handler (`createDeliveryApi`) and
  `deliveryCoverage`. The parsers and rules are pure and tested on their own.
- The published cache gained what headless reads need: `contentIn`,
  `allMedia`, `hasCulture`, `hidesTopLevel`, `defaultCulture`, and media's
  parent, sort order and dates.
- `packages/server`: `deliveryApi` settings and environment variables, the
  route at `/umbraco/delivery/api` on nodes that serve the site,
  `PublicAccessRepository.allRules`, and `delivery-members.ts` — both sign-in
  flows over `delivery_member_token` (migration 037, release 0.12.0). Members
  named for client credentials show as kind `Api`.
- `coverage:api` counts the Delivery contract: 8 of 8.
- Tests: `tests/delivery-api.test.ts`, `tests/delivery-members.test.ts`,
  `tests/delivery-contract.test.ts`. Documented in `docs/delivery-api.md`.
- Left for later, as `docs/delivery-api.md` lists: preview of drafts,
  segments, output caching, rich text as JSON, domain cultures in path
  resolution, the typed contract, external login providers.
