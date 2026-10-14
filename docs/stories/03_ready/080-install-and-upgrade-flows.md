# 080 — Install and upgrade flows

**Epic:** I — Hardening · **Priority:** should · **Size:** M
**Depends on:** 015

## Story

As someone standing up a new site, I want installing and upgrading to work
first time, from a clean start, so that the first thing I meet is not a failure.

## Context

Phase 7 began with "install and upgrade flows", and its exit included "a fresh
install completes through the install wizard".

**Open question, not resolved here.** That exit conflicts with a deliberate
divergence: the install wizard (3 operations) and the upgrade endpoints (2)
answer 501 on purpose, because `crombolo init`, schema as code and
`crombolo upgrade` replace them (see "Deliberate divergence" in
[`roadmap.md`](../../roadmap.md)). The real consequence is that there is no
first-run browser experience, so a non-developer cannot stand a site up.

Before starting, decide which is true:

- the wizard is built, reversing the divergence, or
- the exit is restated as "a fresh install completes through `crombolo init`
  and boots to a working backoffice"

## Acceptance criteria

- [ ] The open question above is decided and recorded here.
- [ ] A fresh install completes, through the agreed path, on both dialects.
- [ ] An upgrade from the previous release completes through
      `crombolo upgrade`, and the dashboard reflects it.
- [ ] Failure at each step leaves a message a person can act on, and a database
      that the next attempt can resume from.
