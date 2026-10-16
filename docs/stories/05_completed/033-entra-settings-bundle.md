# 033 — Entra settings bundle

**Epic:** D — Members and identity · **Priority:** could · **Size:** M
**Depends on:** 031

## Story

As an administrator of a site that signs people in with Microsoft Entra, I want
to change the Entra settings from the backoffice — the tenant, the app's client
id and secret, and which Entra groups become which groups here — so that a
changed secret or a new group mapping needs no deploy.

## Context

Story 031 made identity providers code: `entra()` in `crombolo.config.ts`. That
stays the way a provider exists. This bundle, `@crombolo/entra`, only edits:
it is a Settings screen whose values override the code's for an Entra provider
the site already declares, and it can put them back.

## Acceptance criteria

- [x] Core keeps per-provider overrides in the database, with a client secret
      sealed by `CROMBOLO_SECRET_KEY`. A sign-in uses the code's settings with
      the overrides on top, read when it happens, so a change takes effect on the
      next sign-in on every node.
- [x] A bundle capability, `identityProviders`, lists the providers the config
      declares, with their effective settings (never a secret), and sets or
      clears the overrides.
- [x] `@crombolo/entra` adds a Settings screen for each Entra provider, for
      members and for the backoffice:
  - tenant id, client id, client secret (write-only), button name;
  - the sign-in options: create accounts, link by verified email, trust emails;
  - group mappings, with a picker for the local group;
  - the default groups;
  - the redirect URL to register;
  - "Test connection", and "Reset to the code's settings".
- [x] Only administrators can change the settings, because a group mapping can
      grant administrator.

## Out of scope

- Declaring a provider from the backoffice. A provider exists because the
  config says so.
- Looking up Entra groups by name through Microsoft Graph. A mapping takes the
  group's object id, as the token carries it.

## Decision (2026-10-16)

- **Overrides, not a second source.** The code's preset is the provider; the
  database holds only the fields an administrator changed. "Reset" deletes them.
- **Read at sign-in, not cached.** Sign-ins are rare enough that reading one
  `key_value` row each time is free, and it keeps a cluster consistent with no
  cache instruction.
- **Generic in core, Entra in the bundle.** Overrides work for any provider; the
  bundle shows only those made by `entra()`, which now records its kind.

## Plan

1. **Core** (`packages/server`): an `IdentityProviderOverrides` store over
   `key_value` (`crombolo:identity-provider:{audience}:{id}`), sealing the
   secret. `effectiveProvider(code, overrides)` is pure, and recomputes Entra's
   issuer from an overridden tenant. External sign-in resolves the provider at
   each start and callback, and keeps OIDC clients by issuer and client id so
   discovery stays cached.
2. **Capability**: `host.identityProviders` with `list()`, `update(audience,
   id, overrides)`, `reset(audience, id)` and `test(audience, id)`, the last of
   which fetches the discovery document.
3. **The bundle** (`packages/entra`): a server half with routes gated on
   Settings, writes requiring an administrator, and a backoffice half — a menu
   item under Settings → Advanced and a workspace with the form above.
4. **Docs** in `docs/operations.md` and `docs/bundles.md`; tests on both
   dialects.

## Implementation

- **Core** (`packages/server/src/identity-provider-overrides.ts`):
  `IdentityProviderOverrides` keeps the fields changed in `key_value`, under
  `crombolo:identity-provider:{audience}:{id}`, with the client secret sealed by
  `CROMBOLO_SECRET_KEY`. It refuses to keep a secret without the key. An empty
  value clears a field, and `reset` deletes them all. `effectiveProvider` is
  the pure merge, and recomputes Entra's issuer from a changed tenant;
  `entra()` now records `kind` and `tenantId` for it. External sign-in resolves
  the provider at each start and callback, and caches an OIDC client per
  effective configuration.
- **The capability**: `host.identityProviders` offers:
  - `list`, with effective settings, `overridden` fields and the callback
    path, and never a secret;
  - `update` and `reset`;
  - `test`, which fetches the discovery document;
  - `groups`, with user groups by alias and member groups by name.
- **The bundle** (`packages/entra`, `@crombolo/entra`): `entraSettings()` with
  routes under `crombolo/api/bundle/entra/` — providers, groups, update,
  reset and test. They are gated on Settings, and writes need an administrator.
  The screen is a menu item under Settings → Advanced, with a workspace card
  per Entra sign-in: each field marked "Changed here" where it differs from
  code, the secret write-only with Replace and Remove, the group mappings with
  a picker, the default groups, the redirect URL to register, Test connection,
  and "Use the code's settings".

Tests (both dialects):
- `tests/entra-bundle.test.ts` (10): the merge, input sanitising, the store
  (sealed secret, reset, refusal without a key), and the bundle's routes
  (listing only Entra, editing and reset, sealing a secret, groups, and
  refusing non-administrators).
- `tests/external-sign-in.test.ts`: an override changing the client id takes
  effect at the next sign-in.
