# 031 — External identity providers

**Epic:** D — Members and identity · **Priority:** should · **Size:** L
**Depends on:** 030

## Story

As a site owner whose members already have accounts with an identity provider,
I want them to sign in with it, so that they need no separate password for the
site and access follows their account.

## Context

The remainder of the members work. Members, member groups and protected pages
are built (030), but members and backoffice users are local-only. Linking
external accounts to local members, with auto-linking, is what is left.
`external_login` already exists for it.

**Decided:** the integrations are typed config presets exported from
`@crombolo/crombolo`: `entra(...)`, `awsIdentityCenter(...)` and a generic
`oidc(...)`, each knowing its issuer, scopes and claim mapping.

- They are not separate packages. The plan defers a plugin ecosystem, and a
  preset is an import rather than an install.

## Acceptance criteria

- [x] `entra()`, `awsIdentityCenter()` and `oidc()` are exported from
      `@crombolo/crombolo` as typed presets, each carrying its issuer, scopes
      and claim mapping.
- [x] A member signing in through a provider is linked to a local member, with
      auto-linking, through `external_login`.
- [x] **Exit:** a page protected by a member group is served only after signing
      in through an external provider.

## Out of scope

- Two-factor sign-in, which is 032.
- Linking or unlinking a provider from the current user's profile in the
  backoffice. Linking happens at sign-in; the profile lists what is linked.
- SAML. Entra and IAM Identity Center both speak OpenID Connect, which is what
  the presets use.

## Decision (2026-10-16)

- **Members and backoffice users both**, configured separately: a site might
  sign staff in with Entra and members with AWS IAM Identity Center. The config
  has two lists, `memberIdentityProviders` and `backofficeIdentityProviders`,
  of the same preset objects. A provider in one list is not usable by the other.
- **OpenID Connect, authorization code with PKCE**, for every preset. Discovery,
  the redirect and the code exchange are ours, on `fetch`. **ID tokens are
  verified with `jose`**, the one new dependency: signature against the
  provider's published keys (cached, refetched on an unknown key), issuer,
  audience, expiry and nonce.
- **The presets** know their issuer, scopes and claim mapping:
  `entra({ tenantId, clientId, clientSecret })`,
  `awsIdentityCenter({ issuer, clientId, clientSecret })` and
  `oidc({ name, issuer, clientId, clientSecret, scopes?, claims? })`. Each takes
  a display name and an id (`entra` by default), which becomes the login
  provider recorded in `external_login`.
- **First sign-in creates and links, and links by verified email only where it
  is safe.** Per provider: `autoCreate` (default on) creates a member or user
  for a provider account no one has. `linkByEmail` (default off) links to an
  existing member or user with the same email, and only when the ID token says
  `email_verified`. Otherwise an email already taken is refused with a message,
  never merged. After the first sign-in, the account is found by the
  `external_login` row (provider and subject), not by email.
- **Groups follow a claim, re-synced on every sign-in.** Per provider:
  `groups: { claim: 'groups', map: { '<claim value>': '<group>' } }` maps
  claim values to member groups (members) or user groups (users), plus
  `defaultGroups` for a new account. On each sign-in the mapped groups are made
  to match the claim; groups outside the mapping (added by an editor) are left
  alone.
- **One sign-in per audience ends the same way local sign-in does.** A member
  gets the member cookie, so protected pages and the Delivery API's app
  sign-in work unchanged. A user gets the backoffice session, so `/authorize`
  continues as after a password. `allowLocalLogin = false` makes the backoffice
  provider-only.

## Plan

1. **Config and presets** (`packages/server`, exported from
   `@crombolo/crombolo`): the `IdentityProvider` type and the three presets,
   with options validated at boot and secrets from env. Add
   `members.identityProviders` and `backoffice.identityProviders` to
   `CromboloConfig`.
2. **The OIDC client** (`packages/auth`): discovery with caching; the
   authorization URL with `state`, `nonce` and a PKCE verifier, held in a
   short-lived signed cookie; the code exchange; and ID token verification with
   `jose`. It returns the subject, email, `email_verified`, name and the
   claims. Pure where it can be, with a fake provider in the tests.
3. **Linking** (`packages/data`): an `ExternalLoginRepository` over
   `external_login` and `external_login_token`: find by provider and subject,
   link, list and unlink, for members and users alike. Add find-by-email on
   members and users. A pure decision function turns the sign-in, what exists
   and the provider's options into sign in, create, link or refuse.
4. **Member sign-in** (`packages/server`): `GET
   /umbraco/members/external/{provider}?returnUrl=` starts the flow and
   `/umbraco/members/external/{provider}/callback` finishes it. It creates or
   links the member, syncs groups, issues the member cookie and redirects to
   the safe `returnUrl`. A refusal goes back with `memberLoginFailed` and a
   reason. Members with only a provider show as `ExternalOnly` in the
   backoffice. The Delivery API's `authorize` honours `identity_provider=`, as
   Umbraco does.
5. **Backoffice sign-in** (`packages/server`, `packages/backoffice-host`): the
   same flow under the management API's security path, ending in a backoffice
   session. The login page shows a button per backoffice provider.
   `GetUserCurrentLoginProviders` lists them with whether each is linked, for
   the profile.
6. **Templates**: a "Sign in with …" link per member provider for site login
   forms (`externalSignInUrl(provider, returnUrl)` from `@crombolo/crombolo`),
   used by the Harbourstone demo's members area if it has one, else documented.
7. **Docs**: `docs/configuration.md` (the presets and the two lists),
   `docs/operations.md` (registering the redirect URLs with Entra and AWS) and
   a members section on external sign-in.

**Tests** (the data layer, so both dialects):
- Discovery, the code flow and token verification against a fake OIDC provider
  served by the test, including a bad signature, the wrong audience, an expired
  token and a replayed `state`.
- Auto-create, link by verified email, and refusal when the email is not
  verified.
- Group sync, keeping groups outside the mapping.
- **Exit:** a page protected by a member group, served after signing in through
  the fake provider.
- A backoffice user signing in through a provider and reaching the backoffice,
  with local login off.
- The presets' issuers and claims.

## Implementation

- **Presets** (`packages/server/src/identity-providers.ts`, exported from
  `@crombolo/crombolo`): `entra()`, `awsIdentityCenter()` and `oidc()`, checked at
  boot. They feed `memberIdentityProviders` and `backofficeIdentityProviders` in
  `CromboloConfig`. A group map with no claim named reads `groups`, and
  `emailsVerified` exists for providers that send no `email_verified` claim,
  Entra among them.
- **The OIDC client** (`packages/auth/src/oidc.ts`): discovery, cached for an
  hour; the authorization URL with `state`, `nonce` and S256 PKCE; the code
  exchange; and ID-token verification with `jose` against the provider's
  remote keys. The flow state is an HS256 token in a short-lived cookie scoped
  to the routes. `jose` is the one new dependency.
- **Linking** (`packages/data/src/repositories/external-logins.ts`): the
  login provider is recorded as `UmbracoMembers.{id}` or `Umbraco.{id}`, so the
  two audiences never mix. Deleting a user now removes their links, as
  deleting a member already did.
- **The flow** (`packages/server/src/external-sign-in.ts`): the pure
  `decideSignIn` and `syncedGroups`, and start and callback routes over one
  adapter per audience.
  - Members (`member-auth.ts`, at `/umbraco/members/external/{id}`) end with the
    member cookie.
  - Users (`backoffice-external.ts`, at
    `/umbraco/management/api/v1/security/back-office/external/{id}`) end with
    the backoffice session, through `AuthService.signInExternally`, which keeps
    the lockout and approval refusals. The sign-in is audited.
- **Around it:**
  - The Delivery API's member `authorize` honours `identity_provider`.
  - A member with no password is `ExternalOnly` in the backoffice.
  - The login page shows a button per backoffice provider, and hides the
    password form when `allowLocalLogin` is off.
  - `GetUserCurrentLoginProviders` lists the providers and whether each is
    linked.
  - `externalSignInUrl()` gives templates the member sign-in link.

Tests: `tests/external-sign-in.test.ts` (14), on both dialects, run against a
fake OIDC provider served by the test (`tests/support/fake-oidc.ts`). They
cover:
- the presets
- the decision and group-sync rules
- the exit criterion
- re-sign-in with groups following the claim
- refusal and verified-email linking
- a token signed with a foreign key, an expired token, the wrong audience and
  a replayed nonce
- a callback without its flow
- the Delivery API's `identity_provider`
- a backoffice user signing in with local login off, through to an
  authorization code
