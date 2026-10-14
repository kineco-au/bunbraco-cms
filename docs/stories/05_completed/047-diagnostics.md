# 047 — Diagnostics: health checks, telemetry, profiling and troubleshooting

**Epic:** E — Cross-cutting · **Priority:** could · **Size:** M
**Depends on:** —

## Story

As a site administrator, I want the backoffice's health checks and
troubleshooting screens to tell me something true about the site, so that I can
diagnose a problem without opening a terminal.

## Context

None of this is visible to a visitor. The operations answer 501 today:

| Group | Built |
| --- | --- |
| `health-check-group` | 0/3 |
| `health-check` | 0/1 |
| `telemetry` | 0/3 |
| `profiling` | 0/2 |
| `server/troubleshooting` and `server/upgrade-check` | part of `server`, 3/5 |

Telemetry must answer *honestly*: nothing is sent anywhere, and the screen says
so.

## Acceptance criteria

- [x] Health checks for the things that actually go wrong here: database
      reachability and dialect, pending migrations, media store, e-mail
      availability, and the cluster's nodes and their versions.
- [x] Telemetry answers that nothing is collected, and the level cannot be raised.
- [x] Profiling answers truthfully (off, or a real implementation).
- [x] `server/troubleshooting` reports the runtime, versions and configuration
      that matter, with secrets omitted. `server/upgrade-check` answers from the
      registry.
- [x] Every operation listed is real or a deliberate, documented answer.

## Decisions

- **Node versions: a new column, and a release.** `server.version` holds the
  schema set's version, not Crombolo's, so migration 034 adds
  `server.crombolo_version`. 0.11.0 was already tagged, so the packages moved to
  0.12.0 for the migration to name.
- **Profiling: always off.** There is no profiler to switch on; mapping it to the
  request tracer would not give the screen what it expects.

## What was built

See [`diagnostics.md`](../../diagnostics.md).

- **Four groups, five checks** (`adapters/health.ts`): database connection,
  database upgrades (framework migrations, bundle steps, schema state against
  this node's), media storage (write, read back, remove), e-mail delivery, and
  the servers seen in the last minute with a warning when releases or schema
  files disagree. Checks report and offer no action, so `execute-action` is a
  400 that says so.
- **Telemetry** is fixed at Minimal and **profiling** at off; raising either is
  a 400 with the reason (`handlers/diagnostics.ts`).
- **Troubleshooting** builds each line from a value that holds no secret.
- **Upgrade check** reads `@crombolo/crombolo`'s `latest` from the configured
  registry, names the part that moved, remembers the answer for the version
  check period, and does not remember a registry it could not reach.
- **Tests:** `tests/health-checks.test.ts`; the two tests that used these
  operations as examples of a 501 now use webhooks and the upgrade settings.

## Out of scope

- An external metrics or tracing pipeline.
