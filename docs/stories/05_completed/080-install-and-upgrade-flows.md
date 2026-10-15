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

- [x] The open question above is decided and recorded here (see Decisions).
- [x] A fresh install completes, through the agreed path, on both dialects.
- [x] An upgrade from the previous release completes through
      `crombolo upgrade`, and the dashboard reflects it.
- [x] Failure at each step leaves a message a person can act on, and a database
      that the next attempt can resume from (framework steps and boot; see Not done
      for value migrations).

## Decisions (2026-10-15)

**No install wizard.** The divergence stands: Umbraco's install and upgrade
endpoints keep answering 501. Two self-hosting routes matter, and neither is
served by a database-choosing wizard:

- **A build pipeline** supplies everything as environment variables, including
  `CROMBOLO_ADMIN_PASSWORD`, and must boot unattended and reproducibly.
- **Clickops** (a container started from a cloud console) fails today in two
  ways. The generated admin password exists only in the container's log, and a
  configuration mistake is a crash loop with nothing in the browser.

The exit is restated: a fresh install completes through `crombolo init`, or
through environment variables plus the "Set up your new site" screen, and
reaches a working backoffice on both dialects.

**Set up your new site.** In production, a fresh database with no
`CROMBOLO_ADMIN_PASSWORD` seeds no administrator. The first visit shows "Set up
your new site", which asks for the administrator's name, e-mail and password.

- The screen is guarded by `CROMBOLO_SETUP_CODE`, a value the person chooses
  and sets themselves.
- The code is never generated, printed, logged, or shown on the site.
- Without a code of at least 16 characters, the screen only says which setting
  to add.
- Development keeps today's generated, printed password.

**Security, evaluated against a forced restart:**

- In production, start-up never resets, re-enables or signs out an existing
  administrator. Today `crombolo start` resets the password on every start, so
  a forced restart could undo a password the owner had changed.
- `CROMBOLO_ADMIN_PASSWORD` seeds only a fresh database.
- Whether setup is open is recorded in the database, not held in memory. A
  restart cannot reopen it, and neither can deleting the administrator later.
- Completing setup closes it for good, inside a lock, so two concurrent
  attempts cannot both succeed.
- The code is compared in constant time, and wrong attempts are rate-limited.
- Once setup is done, the log warns, without the value, that the setup code is
  still set.

**Boot failure.** When the database is unreachable, an upgrade is pending, or
the schema is refused, the server stays up. It serves a plain page saying what
is wrong and which setting to check, with no secrets, and `/health` answers 503.
It retries the boot with backoff, and exits after the retry limit so the
platform's restart policy and alerts take over.

**A ready-to-run container image** is a story of its own (`087`).

## What was built

**Set up your new site**
- `packages/data/src/setup.ts`:
  - The setup state is kept in `key_value` under `crombolo:setup`.
  - `completeSetup` creates the super user under the key-values lock and closes
    setup in the same transaction.
- `seedIdentity` now takes an optional admin.
- `installDatabase` leaves a production install with no password pending.
- `packages/server/src/setup.ts`, all pure apart from the routes:
  - `checkSetupCode`: SHA-256 digests compared with `timingSafeEqual`, and
    refused when shorter than 16 characters.
  - `validateSetupForm`, which uses the configured password rules.
  - `AttemptLimiter`: 5 failures per caller and 50 overall per 15 minutes, with
    the clock injected.
  - `setupPage`.
  - `createSetupRoutes`: the `<backoffice>/setup` route, a same-origin check,
    and a redirect from the shell and the login page while setup is pending.
- `crombolo start` in production no longer resets the administrator. It prints
  the setup address, never the code.

**Boot failure**
- `packages/server/src/boot-failure.ts`, pure: `describeBootFailure`,
  `bootRetryDelays` and `bootFailurePage`.
- `crombolo start` listens straight away with a holding handler, retries
  `createServer`, then swaps to the site with `server.reload`.
- `CROMBOLO_BOOT_ATTEMPTS` sets the number of attempts.

**Upgrade**
- `migrate` now writes the state and the ledger row inside each step's
  transaction, so a crash between them can no longer make the next run repeat
  a step.
- A failing step throws `MigrationStepError`. It names the step, says how many
  steps before it are applied, and says the next run carries on there.
- The CLI prints that message and `UpgradeStateError`'s without a stack trace.
- `packages/server/src/upgrade-summary.ts`: `summariseUpgrades`, pure, works out
  the install and the last upgrade run from the ledger.
- `change-report` returns that summary, and the Changes dashboard shows a line
  such as "Crombolo 0.12.0 · installed … · last upgraded … to 0.12.0, 1 storage
  change".

**Tests**
- `tests/setup.test.ts`, `tests/boot-failure.test.ts` and
  `tests/upgrade-from-release.test.ts`, on both dialects.
- In `tests/data.test.ts`: "a failed step names itself, keeps the steps before
  it, and the next run resumes there".
- `tests/integration/first-boot.integration.ts`, through the real CLI:
  - setup end to end, including a restart;
  - the holding page and `/health` for an unreachable database, then the exit;
  - a database rewound to 0.11.0, refused at start, then upgraded by
    `crombolo upgrade`.

## Not done

- **Value migrations interrupted part way.** Each value is its own append, and
  the `value` ledger row is written after the whole loop. I have not verified
  that a re-run after a crash leaves already-converted values alone. It needs a
  story of its own, with a failure-injection test.
- **The upgrade test starts from a rewound database**, not from a database made
  by a real 0.11.0 install. There is no checked-in fixture from an older
  release.

