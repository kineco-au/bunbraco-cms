# 031 — External identity providers

**Epic:** D — Members and identity · **Priority:** should · **Size:** M
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

- [ ] `entra()`, `awsIdentityCenter()` and `oidc()` are exported from
      `@crombolo/crombolo` as typed presets, each carrying its issuer, scopes
      and claim mapping.
- [ ] A member signing in through a provider is linked to a local member, with
      auto-linking, through `external_login`.
- [ ] **Exit:** a page protected by a member group is served only after signing
      in through an external provider.

## Out of scope

- Two-factor sign-in, which is 032.
