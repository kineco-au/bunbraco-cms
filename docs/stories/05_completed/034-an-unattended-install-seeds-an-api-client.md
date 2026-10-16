# 034 — An unattended install seeds an API client

**Epic:** D — Members and identity · **Priority:** should · **Size:** S
**Depends on:** 031

## Story

As someone who runs sites from a pipeline, I want a fresh install to create the
API client my automation signs in with, so that a site whose backoffice accepts
only an identity provider (`allowLocalLogin = false`) can still be administered
by a machine, without a password user existing to create it.

## Context

Today the only way to get an API user is through the Management API, signed in
as a backoffice user — in practice the seeded administrator, with a password.
With `allowLocalLogin = false` (`031`) that sign-in is refused, so an unattended
install that wants provider-only sign-in has no way to bootstrap automation.
Umbraco's unattended install seeds a user for the same reason.

## Acceptance criteria

- [x] `apiClient: { id, secret }` in `CromboloConfig`, from
      `CROMBOLO_API_CLIENT_ID` and `CROMBOLO_API_CLIENT_SECRET`, validated at
      boot: the id carries the prefix API clients already require, and the
      secret meets the client-secret rules.
- [x] A fresh install with it set seeds an API user in the `admin` group with
      that client, and seeds **no** password administrator unless
      `adminPassword` is also set. The site counts as set up: "Set up your new
      site" is not shown.
- [x] An existing install with it set gains the client if it has none of that
      id, and leaves one that exists alone (never rotates it from config).
- [x] The client gets a token through the client-credentials grant with local
      login off.
- [x] Documented in `docs/configuration.md` and `docs/operations.md` (the
      unattended install).

## Out of scope

- Rotating the secret from config. Rotation stays a Management API call.
- More than one seeded client.

## Decision (2026-10-16)

- **No password administrator anywhere when `apiClient` is set**, unless
  `adminPassword` is also set. The exception is local development: with
  `localAdmin: true` (`CROMBOLO_LOCAL_ADMIN=true`) and the site running on
  localhost, the usual password administrator is seeded, so `crombolo start`
  still prints a sign-in. "Running on localhost" means `development` is on and
  `applicationUrl` is either unset or names `localhost`, `127.0.0.1` or `::1`.
  Anywhere else the flag is ignored, and boot logs a warning saying so.
- **An existing install still waiting for setup counts as set up** once it
  gains the client. A machine can then administer the site, so the browser
  setup page is withdrawn, exactly as for a fresh install. A person signs in
  through an identity provider, or the client creates users.

## Plan

1. **Config** (`server/src/config.ts`):
   - `apiClient?: { id, secret }` comes from `CROMBOLO_API_CLIENT_ID` and
     `CROMBOLO_API_CLIENT_SECRET`, and `localAdmin` from
     `CROMBOLO_LOCAL_ADMIN`.
   - `loadConfig` refuses, naming the variable:
     - one of the pair set without the other;
     - an id without the `crombolo-back-office-` prefix that client ids
       already need;
     - a secret that fails `isValidPassword`, the client-secret rule.
   - The secret is never logged or printed.
2. **Install** (`server/src/database.ts`, `installDatabase`):
   - When `apiClient` is set, no password administrator is seeded unless
     `adminPassword` is set, or `localAdmin` is on and the site runs on
     localhost.
   - `ensureApiClient(db, apiClient)` runs on every install and boot. If no
     user holds that client id, it creates an API user, named for the client,
     in the `admin` group, with the client's credential (hashed, as the
     Management API stores it). An existing one is left alone: config never
     rotates a secret.
   - Seeding the client clears a pending setup, so "Set up your new site" is
     not shown.
   - Each seeding is written to the audit log, without the secret.
3. **Sign-in:** the client-credentials grant already issues tokens whatever
   `allowLocalLogin` says. A test holds it to that.
4. **The local demo sites keep their password** (asked for 2026-10-16).
   `scripts/start-site.ts` (`bun run site <name>`) sets
   `CROMBOLO_LOCAL_ADMIN=true` in both the local environment and the
   `--docker` one. A demo site that sets `apiClient` then still seeds and
   prints the administrator's password, as every demo site does today.
5. **Docs:** both variables and `localAdmin` in `docs/configuration.md`, and
   the unattended install, with provider-only sign-in, in
   `docs/operations.md`.

**Tests** (`tests/api-client-seed.test.ts`, the data layer, so both dialects):
- **A fresh production install with `apiClient`:**
  - no password user;
  - setup isn't pending;
  - the client gets a token with `allowLocalLogin: false`, and that token
    calls the Management API.
- **The same with `adminPassword`:** both exist.
- **An existing install:**
  - one that has setup pending gains the client, and the pending setup is
    cleared;
  - restarting with a different secret leaves the stored one working, and the
    new one refused;
  - a second id adds a second client.
- **Config:**
  - a bad prefix, a weak secret, or one variable without the other is refused
    at load;
  - `localAdmin` on localhost seeds the password administrator;
  - `localAdmin` with a non-local `applicationUrl` doesn't, and warns.

## Implementation (2026-10-16)

- **Config** (`server/src/config.ts`):
  - `apiClient` comes from `CROMBOLO_API_CLIENT_ID` and
    `CROMBOLO_API_CLIENT_SECRET`, and `localAdmin` from
    `CROMBOLO_LOCAL_ADMIN`.
  - `checkApiClient` refuses, naming the variable: one of the pair without
    the other, an id without the `crombolo-back-office-` prefix
    (`API_CLIENT_ID_PREFIX`), or a secret that fails `isValidPassword`.
  - `runsOnLocalhost` means development, with no `applicationUrl` or one on
    localhost.
- **Install** (`server/src/database.ts`): with `apiClient` and no
  `adminPassword`, no password administrator is seeded and setup isn't opened,
  unless `localAdmin` is on and the site runs on localhost. A `localAdmin`
  that doesn't apply is logged as ignored. An empty `adminPassword` now counts
  as unset; before, it crashed the seed.
- **Seeding the client** (`server/src/api-client.ts`, `ensureApiClient`):
  - It runs on every install. If no user holds the client id, it creates an
    API user named "API client", with the client id as its login, in the
    administrators group, holding the hashed secret, and audits it.
  - An existing client is left alone.
  - Either way, a pending setup is closed (`closeSetup`, in
    `data/src/setup.ts`).
- **Demo sites:** `scripts/start-site.ts` sets `CROMBOLO_LOCAL_ADMIN=true` for
  local and `--docker` runs.
- **Docs:** `docs/operations.md` § First boot, and `docs/configuration.md`.
- **Tests** (`tests/api-client-seed.test.ts`, both dialects):
  - a fresh production install: no password user, not waiting for setup, and
    a client token with local sign-in off that administers the site;
  - with an admin password as well;
  - an install waiting for setup gains the client and closes setup;
  - a changed secret leaves the stored one working;
  - the config refusals;
  - `localAdmin` on localhost, on a hosted URL, and not asked for.
