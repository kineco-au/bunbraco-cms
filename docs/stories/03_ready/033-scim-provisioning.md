# 033 — SCIM provisioning

**Epic:** D — Members and identity · **Priority:** could · **Size:** L
**Depends on:** 030

## Story

As an organisation running its members through an identity provider, I want
the provider to create, update and remove members on the site itself, so that
removing someone in the provider actually closes the door, without waiting for
them to sign in.

## Context

**Umbraco has no answer here.** A case-insensitive search of the whole
`Umbraco-CMS` source for `scim` returns nothing, and none of the contract's 513
operations provision anything: the 37 member paths are backoffice CRUD. What
Umbraco federates is *authentication* (`MemberExternalLoginProviders` and the
polymorphic `external_login` table). A member appears the first time they sign
in, and nothing ever tells the site they have left.

SCIM (RFC 7643 for the schema, 7644 for the protocol) works the other way: the
identity provider calls the site.

- That is what makes **deprovisioning** real.
- It lets group membership arrive before a first login rather than after it.
- For a CMS whose protected pages are gated by member group, it decides whether
  revoking someone in Entra actually closes the door.

It fits the data model almost exactly. `external_member` holds federated
members who are not content nodes, and already carries `key`, `email`,
`userName` and `displayName`. Those are SCIM's `id`, `emails[]`, `userName` and
`displayName`. Member groups are SCIM `Group`s.

Not before the members work (030): provisioning needs something to provision.

## Acceptance criteria

- [ ] A router of its own at `/scim/v2/**`, outside the Umbraco contract, so it
      cannot affect conformance.
- [ ] `GET|POST /Users`, `GET|PUT|PATCH|DELETE /Users/{id}`, and the same for
      `/Groups`.
- [ ] `GET /ServiceProviderConfig`, `/ResourceTypes` and `/Schemas`: the
      discovery documents every provider fetches before it will enable
      provisioning.
- [ ] Bearer-token auth with a per-tenant token, not a backoffice session.
- [ ] `filter=userName eq "x"` only. That is the one filter Entra and AWS
      Identity Center actually send, so the whole filter grammar is not needed.
- [ ] `PATCH` with `op: add|remove|replace` over `path` expressions. This is the
      fiddly half of the spec, and where most implementations are wrong.
- [ ] **Exit:** Entra's provisioning test succeeds against a running site. A
      user assigned to an application appears as a member of the mapped group
      without signing in, and unassigning them revokes access to a protected
      page.

## Out of scope

- The full SCIM filter grammar.
- Provisioning backoffice users.
