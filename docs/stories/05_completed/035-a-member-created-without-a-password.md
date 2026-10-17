# 035 — A member created without a password

**Epic:** D — Members and identity · **Priority:** should · **Size:** S
**Depends on:** 031

## Story

As someone provisioning a site's members from an identity provider, I want to
create a member through the Management API without a password, so that a
member who will only ever sign in through the provider is not given a password
nobody holds.

## Context

External sign-in (`031`) already makes members with no password: they show as
`ExternalOnly` in the backoffice. The Management API cannot make one, because
`CreateMemberRequestModel` requires `password`. Anything that provisions
members ahead of their first sign-in, such as a directory sync or SCIM, has to
invent a password to get past that. The result looks like a password member
and can be reset into one.

## Acceptance criteria

- [x] `POST /member` accepts a request with no `password` (or an empty one) and
      creates the member exactly as external sign-in does: no password hash,
      shown as `ExternalOnly`.
- [x] A member made that way is linked at their first sign-in through a
      provider with `linkByEmail` on, as any member with that address is.
- [x] The member login form refuses such a member, without counting the attempt
      or taking longer or shorter than a wrong password does. Setting
      `newPassword` through `PUT /member/{id}` still gives them one
      deliberately. (There is no member password reset to refuse them: members
      have none. Story 155's reset link must not be sent to one.)
- [x] The OpenAPI document marks `password` optional on create. The
      difference from Umbraco's contract is listed where the other deliberate
      differences are.
- [x] Tests on both dialects.

## Out of scope

- SCIM itself, and any other provisioning protocol.

## Decisions

Taken on 2026-10-17:

1. **The contract is changed on load, not in the file.** `OpenApi.json` stays
   exactly Umbraco's, so re-vendoring a release is a clean diff;
   `packages/contracts/src/overrides.ts` lists each deliberate difference with
   its reason, applied by `loadSpec()` and by the served document.
2. **The login form stops counting attempts against a member with no
   password.** Before, a stranger who knew the username could post wrong
   passwords until the member was locked out — which also stopped their provider
   sign-in — and the null hash failed faster than a real verify, saying the
   account had no password. This story made such members easy to create in
   bulk, so it is fixed here.

Only an absent or empty `password` means none; one of spaces is a password.

## What was built

- `handlers/member.ts`: the create no longer requires `password`. Everything
  below it already coped with a member who has none — the adapter stores a null
  hash, `kindOf` reports `ExternalOnly`, linking by verified email looks only at
  the address, and `newPassword` on update hashes one in.
- `member-auth.ts` `login`: a member with no hash takes the same throwaway
  verify as an unknown username and gets the same generic 401, with no failed
  attempt recorded.
- `packages/contracts/src/overrides.ts`: `CONTRACT_OVERRIDES`, `applyOverrides`;
  `spec.ts` gains `loadUmbracoSpec()` (the file as vendored) and
  `servedContract()`, which `GET /umbraco/management/api/openapi.json` now
  answers with.
- Tests: `tests/members.test.ts` (created with no or an empty password, then
  given one; an `oldPassword` refused when there is none),
  `tests/external-sign-in.test.ts` (linked at first sign-in; seven wrong guesses
  leave the member unlocked and their provider sign-in working),
  `tests/contract.test.ts` and `tests/boot.test.ts` (the file untouched, the
  loaded and served contract without the requirement).
- Docs: `roadmap.md` (deliberate divergence), `api-contract.md`,
  `operations.md` § Signing in through an identity provider.

The generated `management-api.d.ts` still types `password` as required on
`CreateMemberRequestModel`; nothing uses that request type, and it regenerates
from the vendored file.
