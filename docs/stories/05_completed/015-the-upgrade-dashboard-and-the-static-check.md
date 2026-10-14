# 015 — The upgrade dashboard and the static check

**Epic:** B — Packaging and upgrades · **Priority:** must · **Size:** M
**Depends on:** 014

## Story

As an editor, I want to see in the backoffice what an upgrade needs from me and
when my node has gone read-only. As a site developer, I want a pull request to
be checked before it reaches a database. Together, these make a release's
data work visible to the people who do it.

## Context

The last slice of the upgrade machinery: a dashboard over the report that 014
writes, a static check for pull requests, and the tools to clean up retired
data and rewrite files canonically.

The dashboard is a framework-shipped backoffice package rather than a contract
endpoint. It is plain Lit modules against the import map, with no build step.

## Acceptance criteria

- [x] **Upgrade dashboard**, called the Changes dashboard since migration 018.
      It lives in `packages/backoffice-host/plugin/`, is served at
      `<backoffice>/crombolo/*`, and is merged into the manifests like an
      installed npm extension.
      - A Settings-section dashboard reads `GET <backoffice>/crombolo/api/change-report`
        (non-contract, on the same footing as the auth routes). It shows counts
        by kind and each finding with its link, with resolved findings greyed
        out.
      - A header app shows a *read-only* banner when `server/status` reports
        compatibility mode.
- [x] **`schema check --static`** applies the pull-request rules: keys present,
      classification of the diff against the last exported state, and "this
      rename has no migration". *See As built.*
- [x] **`schema purge --older-than <days>`** deletes retired property types and
      their values. It is a contract: ledgered, with a backup first.
- [x] **`upgrade schema`** rewrites every file canonically.
- [x] **Exit scenario 1.** A site change renaming a property, with a value
      migration, promotes through two databases with different content and
      moves every value in both. Removing a property from its file hides it
      without touching a single value, and re-adding the alias by hand brings
      every value back.
- [x] **Exit scenario 2.** A release adds a required property without a
      default, and three existing values break:
      - `check` reports the property as needing a person, and the three values
        with links; `upgrade` refuses.
      - `check --fix` creates the property, so it shows in the running
        backoffice badged as pending, and an existing page still publishes
        without it.
      - After the property is filled in and the values fixed, `check` is clean
        and `upgrade` cuts over and records the run in the ledger, with a
        backup on disk.
      - An older instance serves reads throughout, with no maintenance page,
        and its `/health` goes 503 after the cut-over.
      - The findings are readable from the report endpoint and resolve as they
        are fixed.
- [x] The dashboard is proved by its endpoint and its manifest being served,
      not by clicking it. Browser tests are run only when asked.

## As built

- `schema check --static` enforces keys and well-formed migrations. It cannot
  classify a rename without a previous state to diff against, so "this rename
  has no migration" is reported by the database-backed check instead.
- Pinned by `tests/dashboard.test.ts`. The exit scenarios run in
  `tests/upgrade.test.ts`.
