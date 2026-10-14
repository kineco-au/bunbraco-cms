# 082 — Version cleanup at scale

**Epic:** I — Hardening · **Priority:** could · **Size:** S
**Depends on:** —

## Story

As a site owner whose site has years of edits, I want old versions cleaned up
without slowing the site, so that the database stays a sensible size.

## Context

Every save is a version, by decision (Umbraco versions only on publish), and the
version-cleanup job exists, respecting pinned versions (`preventCleanup`). A
site whose every save is a version accumulates far more rows than Umbraco
would. The job has not been measured against a large history.

## Acceptance criteria

- [ ] Measured against a generated history of realistic size, on both dialects.
- [ ] The job works in bounded batches, never holds the write lock long enough
      to stall an editor, and resumes where it stopped.
- [ ] Pinned versions and the current and published versions are never removed,
      as the invariant pass checks.
