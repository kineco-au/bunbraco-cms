# Diagnostics in the backoffice

What the Settings section's health checks and the system information dialog
tell an administrator, what became of Umbraco's telemetry and profiling screens, tell an administrator — and why each answer is
the one it is. Built in story `047`. For the request trace and heap report that
`docker compose up` turns on, see [`operations.md`](operations.md); for the log
viewer, [`stories/05_completed/040-the-log-viewer.md`](stories/05_completed/040-the-log-viewer.md).

## Health checks

Umbraco's checks are about IIS, `web.config` and HTTPS headers. None of that
exists here, so the checks are for what actually goes wrong on this kind of
site. They live in `packages/server/src/adapters/health.ts` behind the
`DiagnosticsPort` (`packages/api-management/src/ports-diagnostics.ts`), and need
the Settings section.

| Group | Check | Says |
| --- | --- | --- |
| Database | Database connection | whether the database answers, which dialect, and where (credentials left out) |
| Database | Database upgrades | framework migrations and bundle steps still to run, and a schema state ahead of or behind this node |
| Media | Media storage | a small file written, read back and removed — on disk, S3 or Azure alike |
| E-mail | E-mail delivery | whether a provider is configured, and which features are off until one is |
| Servers | Servers | every node seen in the last minute, its role, release and schema, and a warning when releases or schema files disagree |

The Servers check reads `server.crombolo_version` (migration 034), written by
every node at boot and on each poll beside the schema version it already wrote.
A row from before 0.12.0 reads "of an unknown release" until that node upgrades.

**No check offers an action.** Each reports; the fix is a configuration change,
not something a button should do to a running site, so
`POST /health-check/execute-action` answers 400 saying so.

## Telemetry and profiling

Both are gone, deliberately rather than missing: neither screen is vendored
([Nothing sent out](backoffice-hosting.md#nothing-sent-out)), and their
endpoints answer **410 Gone** with a problem detail saying why.

- **Telemetry** is not collected, and nothing is sent anywhere. Its three
  endpoints (`GET /telemetry`, `GET` and `POST /telemetry/level`) answer
  **410 Gone** with a problem detail saying so, rather than pretending to a
  level. The back office has no screen for it: Umbraco's consent dashboard is
  not vendored ([Nothing sent out](backoffice-hosting.md#nothing-sent-out)).
- **Profiling**: there is no profiler (Umbraco's is MiniProfiler, which is
  .NET). `GET` and `PUT /profiling/status` answer 410 Gone, and the Settings
  section has no Profiling dashboard.

## Troubleshooting

`GET /server/troubleshooting` is the system information dialog's list: the
Crombolo, backoffice and Bun versions, the operating system, the mode, the node
and its role, the database and where it is, the schema, the upgrade policy, the
media store, e-mail, the log level, the time zone and the server time.

**Secrets are omitted by construction:** each line is built from a value that
holds none (a store's `description`, `describeDatabase`, which drops the
Postgres user and password), rather than by filtering a dump of the
configuration. The admin password, API keys, the Git and assistant settings are
never read.

## Upgrade check

`GET /server/upgrade-check` asks the npm registry (`CROMBOLO_NPM_REGISTRY`) for
`@crombolo/crombolo`'s `latest` and names what moved — `Major`, `Minor`, `Patch`,
or `None` — with a link to that release. The answer is kept for
`versionCheckPeriod` days; `0` turns the check off. An unreachable registry
answers `None` with the reason and is not remembered, so an air-gapped site is
not told "up to date" for a week. The vendored backoffice no longer calls this
endpoint; it is answered for other clients of the contract.
