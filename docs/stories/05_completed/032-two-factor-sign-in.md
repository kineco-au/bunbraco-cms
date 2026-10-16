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

- [x] A time-based one-time password provider (app authenticator) is installed
      for backoffice users, and the two-factor operations list, set up and
      disable it.
- [x] Sign-in for a user with it enabled asks for the code, and `verify-2fa`
      completes it; a wrong code is refused.
- [x] The same for members, with `isTwoFactorEnabled` reflecting the real state.
- [x] An administrator can disable a user's two-factor sign-in
      (`DeleteUserById2faByProviderName`).
- [x] Tested on both dialects.

## Out of scope

- Importing Umbraco's two-factor secrets (071 counts them).
- Passkeys and other providers.
- Requiring two-factor sign-in for a group. Turning it on is each person's
  choice, as in Umbraco.

## Decision (2026-10-16)

- **TOTP is our own RFC 6238**: HMAC-SHA1, 30-second steps, 6 digits, which is
  what every authenticator app expects. It runs on WebCrypto and is tested
  against the RFC's vectors. A code from one step either side is accepted for
  clock drift, and a code already used is refused, by remembering the last
  step used.
- **The secret is sealed** with `CROMBOLO_SECRET_KEY`, as webhook headers and
  provider secrets are. Two-factor sign-in cannot be turned on without the key
  (the setup says so), so a database dump yields no working second factor.
- **The QR code** is an SVG `data:` URL rendered on the server by `uqr` (MIT, no
  dependencies), carrying the standard `otpauth://totp/…` URI. Umbraco's setup
  screen shows it as an image, and the secret is shown beside it for typing in.
  Nothing goes to a third-party QR service.
- **Recovery**: turning it on shows ten one-time recovery codes, stored hashed;
  each signs in once in place of a code. An administrator can also turn it off,
  for a user through Umbraco's own screen
  (`DeleteUserById2faByProviderName`), and for a member through an action we
  add to the member workspace, since the contract has no member operation for
  it.

## Plan

1. **TOTP and recovery codes** (`packages/auth/src/totp.ts`): generating a
   secret (base32), the `otpauth` URI, code verification with the drift
   window, and recovery codes (generate, hash, check). Pure, with the RFC
   vectors as tests.
2. **Storage** (`packages/data`): migration 040, release 0.14.0.
   - `two_factor_login`: owner key (user or member, polymorphic, as Umbraco's
     `umbracoTwoFactorLogin` is), provider name, sealed secret, last used step,
     created.
   - `two_factor_recovery_code`: owner key, code hash, used date.

   Add a `TwoFactorRepository`. Deleting a user or member removes their rows.
3. **Backoffice users** (`packages/auth`, `packages/api-management`,
   `packages/server`):
   - **Endpoints:** the provider `UmbracoUserAppAuthenticator` behind the six
     user 2FA operations: list, setup (`{ secret, qrCodeSetupImageUrl }`),
     enable with a code (answering with the recovery codes), disable with a
     code, and the administrator's list and disable for another user.
     `allowTwoFactor` turns on in the user configurations, so the backoffice
     offers "Configure two-factor".
   - **Sign-in:** a correct password for a user with 2FA answers 402 with the
     provider name, and a short-lived signed pending cookie instead of a
     session. `verify-2fa` takes a code or a recovery code and creates the
     session; a wrong code counts towards lockout.
   - **Plugin manifest:** the `mfaLoginProvider` extension.
4. **The login page**: a code step after a 402, which also accepts a recovery
   code.
5. **Members** (`member-auth.ts`):
   - **Sign-in:** a correct password with 2FA on sets the pending cookie and
     answers `twoFactorRequired`, or redirects to `returnUrl?memberTwoFactorRequired=1`.
     `POST /umbraco/members/login/2fa` takes the code or a recovery code.
   - **Setup endpoints** for the signed-in member: status, setup, enable and
     disable.
   - **Elsewhere:** `isTwoFactorEnabled` reflects the real state. A member
     workspace action (`plugin/`) lets an administrator turn a member's 2FA off.
6. **Docs**: two-factor sign-in in `docs/operations.md`, with the member
   endpoints for templates.

**Tests** (the data layer, so both dialects):
- The RFC vectors, the drift window and replay.
- Recovery codes used once.
- A user: set up, enable, sign in with a code, a wrong code refused, a recovery
  code, an administrator disabling it, and enabling refused without the key.
- A member: the same through the member endpoints, and `isTwoFactorEnabled`.

## Implementation (2026-10-16)

- **Codes** — `packages/auth/src/totp.ts`: base32, RFC 6238 over `node:crypto`
  HMAC-SHA1, a ±1-step window that skips steps at or before the last one used,
  the `otpauth` URI, the QR code as an SVG `data:` URL (`uqr`), and recovery
  codes (`xxxxx-xxxxx`, SHA-256 of the code without case or dashes).
  `short-lived.ts` signs the five-minute pending cookie (jose HS256).
- **Storage** — migration 040 `AddTwoFactorLogin` (release 0.14.0):
  `two_factor_login` and `two_factor_recovery_code`. The repository is
  `TwoFactorRepository`. `useStep` records a step only if it is later than
  the last, in one `UPDATE … RETURNING`, so two requests cannot both spend
  one code. Deleting a user or member removes the rows.
- **Service** — `packages/server/src/two-factor.ts`: `TwoFactorService` seals
  each secret with `CROMBOLO_SECRET_KEY`. It is `available` only with the key,
  and `verify` takes either a six-digit code or a recovery code.
- **Users**:
  - The six operations go through `UserTwoFactorPort` (`ports.ts`).
  - `allowTwoFactor` follows `available`.
  - A login with 2FA answers 402 and sets `umbTwoFactor…`, a signed token
    holding the user's key and login.
  - `verify-2fa` checks the code; a wrong one counts towards lockout. It then
    signs in through `signInExternally`.
- **Backoffice**:
  - `plugin/two-factor-setup.js` is the `mfaLoginProvider` for
    `UmbracoUserAppAuthenticator`. It replaces Umbraco's setup screen, which
    discards the recovery codes, and refreshes the provider list when done.
  - The login page has a code step after a 402.
- **Members**:
  - `member-auth.ts` adds `login/2fa` and `2fa` (status, `setup`, `enable`,
    `disable`). A form post comes back with `memberTwoFactorRequired=1`.
  - `isTwoFactorEnabled` reads the real state.
  - Saving the member with the workspace toggle off resets two-factor.
  - The management handler now treats a missing `isTwoFactorEnabled` as true,
    so an API client that leaves it out does not reset anyone.
- **Docs** — `docs/operations.md` § Two-factor sign-in.
- **Tests** — `tests/two-factor.test.ts` (24), on SQLite and Postgres.
