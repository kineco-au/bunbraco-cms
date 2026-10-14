# 032 — Two-factor sign-in

**Epic:** D — Members and identity · **Priority:** should · **Size:** M
**Depends on:** —

## Story

As a site administrator, I want backoffice users and members to be able to
protect their account with an authenticator app, so that a leaked password is
not enough to get in.

## Context

Umbraco ships app-authenticator two-factor sign-in for both users and members.
Here, as checked against the code on 2026-10-14:

- Every two-factor operation answers "no provider". `GetUserCurrent2fa` returns
  an empty list, and the per-provider operations answer *No two-factor provider
  with that name is installed* (`packages/api-management/src/handlers/user.ts`).
- The sign-in path already branches on it. `packages/auth/src/routes.ts`
  answers 402 with the enabled provider names when `twoFactorRequired`, but
  `verify-2fa` answers *Two-factor authentication is not implemented*. The
  login page says such an account *requires two-factor authentication, which is
  not yet supported*.
- Members carry `isTwoFactorEnabled`, and nothing sets it.
- The Umbraco importer counts `umbracoTwoFactorLogin` rows and does not import
  them.

So the seams are in place and the path is unreachable.

## Acceptance criteria

- [ ] A time-based one-time password provider (app authenticator) is installed
      for backoffice users, and the two-factor operations list, set up and
      disable it.
- [ ] Sign-in for a user with it enabled asks for the code, and `verify-2fa`
      completes it; a wrong code is refused.
- [ ] The same for members, with `isTwoFactorEnabled` reflecting the real state.
- [ ] An administrator can disable a user's two-factor sign-in
      (`DeleteUserById2faByProviderName`).
- [ ] Tested on both dialects.

## Out of scope

- Importing Umbraco's two-factor secrets (071 counts them).
- Passkeys and other providers.
