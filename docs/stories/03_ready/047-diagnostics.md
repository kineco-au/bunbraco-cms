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

- [ ] Health checks for the things that actually go wrong here: database
      reachability and dialect, pending migrations, media store, e-mail
      availability, and the cluster's nodes and their versions.
- [ ] Telemetry answers that nothing is collected, and the level cannot be raised.
- [ ] Profiling answers truthfully (off, or a real implementation).
- [ ] `server/troubleshooting` reports the runtime, versions and configuration
      that matter, with secrets omitted. `server/upgrade-check` answers from the
      registry.
- [ ] Every operation listed is real or a deliberate, documented answer.

## Out of scope

- An external metrics or tracing pipeline.
