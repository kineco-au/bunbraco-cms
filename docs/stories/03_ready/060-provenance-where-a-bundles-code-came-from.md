# 060 — Provenance: where a bundle's code came from

**Epic:** G — Trusting and extending bundles · **Priority:** should · **Size:** M
**Depends on:** 010

## Story

As a site administrator installing a bundle from the marketplace, I want to see
which source repository and commit it was built from, and be able to refuse one
that cannot say, so that I know what I am running in my backoffice.

## Context

**What an install trusts today** ([`bundles.md`](../../bundles.md), "Runtime
install"):

- `bun add` runs in the site directory, which verifies the tarball against the
  registry's sha512 integrity. That proves the bytes match what the registry
  holds, and says nothing about who published them.
- The marketplace lists a package only when the `crombolo-bundle` keyword *and*
  a real `crombolo` field agree. That stops a squatter, and does nothing
  against a package that declares a real extension with bad intent.
- Bun refuses lifecycle scripts outside `trustedDependencies`, so an install
  cannot run code in the server process.
- A server half is wired by a committed import and never discovered.

What remains is the exposure the docs already state plainly. A runtime install
runs third-party JavaScript in the backoffice origin with the signed-in user's
session, able to call the Management API as that user. The only gate is who may
install.

**Three ways to say more were weighed.** The first is rejected: a signing
scheme of our own (a signature in the `crombolo` field over the tarball hash,
countersigned by a crombolo key) would reinvent Sigstore's key management and
revocation. The other two are this story and 061, in that order.

A package published with `npm publish --provenance` from GitHub Actions or
GitLab CI carries a Sigstore attestation. It ties the exact tarball to a source
repository, a commit and the workflow that built it.

- The registry records it on the version's `dist.attestations`, and serves the
  bundle from `/-/npm/v1/attestations/<name>@<version>`.
- `npm audit signatures` is the reference verifier. Bun does not check it.
- The CMS can, with the `sigstore` library against the public Sigstore trust
  root. It can then show the one thing an administrator can act on: *built from
  `github.com/org/repo` at `abc1234`*.

## Acceptance criteria

- [ ] **The listing.** A version whose packument carries `dist.attestations` is
      marked *attested*, from the packument alone, so the list costs no extra
      calls. The badge names the source repository only once verified, never
      before.
- [ ] **The install.** An attested version's attestation is fetched and
      verified **before** `bun add` runs, pinned to the exact version it
      verified, so the two cannot disagree about which tarball was checked.
  - [ ] A failed verification is a refused install with a readable reason:
        never a 500, never a silent fall-through to an unverified install.
  - [ ] The verified repository and commit join the install response, beside
        the dependency line it already carries.
- [ ] **The setting.** `marketplace.require` takes `'none' | 'provenance'`,
      default `'none'`. Under `'provenance'` an unattested version is refused,
      with a message saying the site requires provenance and what the publisher
      must do.
- [ ] **The Installed view** shows each dependency's attestation state, so an
      administrator can see what a stricter setting would refuse. A
      `workspace:` dependency is shown as linked, not as unattested, because it
      never came from a registry.
- [ ] **Tests.** The verifier is tested against a recorded attestation and a
      recorded trust root, so the suite needs no network. An unreachable
      attestation endpoint is a specific error, as the unreachable registry
      already is.
- [ ] **Exit:** against a recorded registry, an attested package installs and
      the response names its repository; a tampered attestation refuses the
      install with a reason; with `require: 'provenance'` an unattested package
      is refused, and the Installed view says which dependencies would be.

## Technical notes

- **What the badge must not claim.** Provenance ties bytes to a build. It does
  not review the source. The wording is *built from*, never *verified* or
  *safe*.
- The `sigstore` dependency is pure JavaScript and lands in `@crombolo/server`
  only.
- **To confirm before starting:** that Bun performs no provenance check of its
  own, and that `sigstore` ships a TUF-refreshed trust root that the tests can
  pin.

## Out of scope

- Who the publisher is and whether anyone has reviewed them: that is 061.
- A signing scheme of our own (rejected above).
