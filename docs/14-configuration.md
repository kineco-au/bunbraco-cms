# Configuration and scripts

Every setting the server reads, and every command the repository defines. The
defaults are chosen so that a clone runs with nothing set.

## Environment variables

| Variable                                    | Default                                        | Purpose                                                                                                |
| ------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `PORT`                                      | `8080`                                         | HTTP port; the backoffice derives its application URL from it                                          |
| `BUNBRACO_DB`                               | `sqlite`                                       | `sqlite` or `postgres`                                                                                 |
| `BUNBRACO_SQLITE_FILE`                      | `bunbraco.sqlite`                              | SQLite path, or `:memory:`                                                                             |
| `BUNBRACO_POSTGRES_URL`                     | —                                              | required when `BUNBRACO_DB=postgres`                                                                   |
| `BUNBRACO_ADMIN_LOGIN`                      | `admin@bunbraco.local`                         | seeded administrator                                                                                   |
| `BUNBRACO_ADMIN_PASSWORD`                   | generated                                      | seeded administrator's password                                                                        |
| `BUNBRACO_VIEWS_DIR`                        | `apps/site/Views`                              | where template views live                                                                              |
| `BUNBRACO_APP_PLUGINS_DIR`                  | `App_Plugins`                                  | backoffice plugin packages, served at `/App_Plugins/`; independent of `BUNBRACO_VIEWS_DIR`              |
| `BUNBRACO_VIEWS_CACHE_DIR`                  | `<site>/.bunbraco/views`                       | where views are snapshotted so an edit needs no restart; inside the site, outside `Views/`     |
| `BUNBRACO_VIEWS_GATE_MS`                    | `5000`, `500` in development                   | how often a node looks for a changed views tree                                                          |
| `BUNBRACO_VIEWS_SWAP_MS`                    | `10000`, `0` in development                    | the floor between generations, which absorbs a flapping sync; an announced save is never delayed by it    |
| `BUNBRACO_VIEWS_GENERATION_LIMIT`           | `250`                                          | generations a node loads before it freezes, keeps serving and refuses newer ones                         |
| `BUNBRACO_VIEWS_KEEP`                       | `3`                                            | generations left on disk, for an instant return to one                                                   |
| `BUNBRACO_BACKOFFICE_PATH`                  | `/bunbraco`                                    | where the editor is mounted; the Management API stays at `/umbraco/management/api/v1`                  |
| `BUNBRACO_INSECURE_COOKIES`                 | `false`                                        | drops the `__Host-` prefix and `Secure`, for plain-http hosts that are not localhost                   |
| `BUNBRACO_SCHEMA_DIR`                       | `schema`                                       | where `*.toml` definitions live; sync is skipped when absent                                           |
| `BUNBRACO_SCHEMA_REVISION`                  | `0`                                            | set by the deploy; orders deploys within one schema version                                            |
| `BUNBRACO_NODE_ID`                          | `host:pid`                                     | the identity stamped on schema syncs, content changes and the migration ledger                          |
| `BUNBRACO_SCHEMA_WRITABLE`                  | `true` unless `NODE_ENV=production`            | whether the backoffice may write schema files                                                          |
| `BUNBRACO_SYNC_SCHEMA_AT_BOOT`              | `true`                                         | `false` when a pipeline runs `bunbraco schema sync` itself                                             |
| `BUNBRACO_UPGRADE_POLICY`                   | `strict` in production, else `pending-allowed` | whether findings that need a person gate `upgrade`                                                     |
| `BUNBRACO_PG_DUMP`                          | —                                              | a shell command that backs up Postgres before `--fix`, `upgrade` and `purge` (else `--backup-taken`)   |
| `BUNBRACO_MEDIA_DIR`                        | `media`                                        | where uploaded files live, served at `/media/`; resized variants are cached in its `.cache`            |
| `BUNBRACO_VERSION_CLEANUP`                  | `false`                                        | `true` runs the hourly version cleanup, as Umbraco's `EnableCleanup`                                   |
| `BUNBRACO_VERSION_CLEANUP_KEEP_ALL_DAYS`    | `7`                                            | keep every version newer than this; a content type's own policy wins                                   |
| `BUNBRACO_VERSION_CLEANUP_KEEP_LATEST_DAYS` | `90`                                           | then keep each day's latest version for this long                                                      |
| `BUNBRACO_LOGS_DIR`                         | `logs`                                         | where log files are written (Serilog's compact JSON, a file per day), read by the log viewer           |
| `BUNBRACO_LOG_LEVEL`                        | `info`                                         | the least severe level logged: `trace`, `debug`, `info`, `warning`, `error`, `fatal`                   |
| `BUNBRACO_LOG_TO_CONSOLE`                   | `true`                                         | whether log events are also printed                                                                    |
| `BUNBRACO_TRACE_REQUESTS`                   | `false`                                        | a debug line per request as it arrives and as its handler returns, console only                        |
| `BUNBRACO_HEAP_INTERVAL_SECONDS`            | `0`                                            | every N seconds: heap, RSS, and requests in flight — pending in Bun versus still in a handler          |
| `BUNBRACO_CSS_DIR`                          | `css`                                          | stylesheets the Settings section edits, served at `/css/`                                              |
| `BUNBRACO_SCRIPTS_DIR`                      | `scripts`                                      | scripts the Settings section edits, served at `/scripts/`                                              |
| `BUNBRACO_USERNAME_IS_EMAIL`                | `true`                                         | Umbraco's `UsernameIsEmail`: a backoffice user's login is their e-mail                                 |
| `BUNBRACO_MAX_REQUEST_BODY_MB`              | `32`                                           | the largest request body read, media uploads included; Bun's own default would be 128                  |
| `BUNBRACO_APPLICATION_URL`                  | `http://localhost:<port>`                      | the public URL invitation and password-reset links point at                                            |
| `BUNBRACO_MEDIA_STORE`                      | `filesystem`                                   | where media bytes live: `filesystem`, `s3` or `azure` (see [15-operations](15-operations.md#media-storage))            |
| `BUNBRACO_MEDIA_PUBLIC_URL`                 | —                                              | a CDN in front of the media root; browsers are redirected there instead of being served by this server |
| `BUNBRACO_ALLOW_MEMBER_REGISTRATION`        | `false`                                        | whether `POST /umbraco/members/register` accepts a registration                                        |
| `BUNBRACO_MEMBER_REGISTRATION_TYPE`         | `Member`                                       | the member type a registration creates, by alias — a type named in the request is ignored              |
| `BUNBRACO_MEMBER_REGISTRATION_GROUPS`       | —                                              | comma-separated member group names a registration joins                                                |
| `BUNBRACO_MEMBER_SESSION_MINUTES`           | `20160` (14 days)                              | how long a member's sign-in is good for                                                                |
| `BUNBRACO_MAX_FAILED_PASSWORD_ATTEMPTS`     | `5`                                            | failed member sign-ins before lockout; `0` never locks out                                             |
| `BUNBRACO_TRACK_REDIRECTS`                  | `true`                                         | whether renaming or moving a page records a redirect from the URL it had                               |

Invitations and password resets reach people through `sendUserLink`, a function
a site sets in `bunbraco.config.ts` (typically handing the link to its mailer).
Without one, users cannot be invited — the backoffice hides Invite and offers
Create, which shows a generated first password — and nobody can reset a
forgotten password by e-mail. In development the links are printed to the
console instead; `sendUserLink: null` turns that off. `allowPasswordReset: true`
shows "Forgotten password?" on the sign-in screen.

## Scripts

| Command                                               | Does                                                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun test`                                            | full suite against SQLite                                                                                                                                     |
| `bun run test:sqlite` / `test:postgres`               | pin the dialect explicitly; `test:postgres` starts the `db` container first                                                                                   |
| `bun run docker:test`                                 | the suite in a container on SQLite, over the mounted source                                                                                                   |
| `bun run docker:test:sqlite` / `docker:test:postgres` | the same, dialect pinned; the SQLite one starts no database                                                                                                   |
| `bun run test:all`                                    | both dialects in sequence                                                                                                                                     |
| `bun run docker:test:all`                             | both dialects in a container, in sequence                                                                                                                     |
| `bun run test:ci`                                     | the suite with the test environment but no dialect pinned — CI sets `BUNBRACO_DB` itself                                                                      |
| `bun run test:browser`                                | the real backoffice in headless Chrome against a throwaway site; fails on console errors, failed requests and 4xx/5xx (`docs/08-testing.md`)                  |
| `bun run docker:test:browser`                         | the same suite in its own Playwright image; Chromium rather than Chrome (no Linux arm64 Chrome)                                                               |
| `bun run test:integration` / `docker:test:integration` | the `*.integration.ts` suites: the real CLI spawned per step, for content transfer and for the upgrade. Named so `bun test` leaves them out; CI always runs them |
| `bun run check`                                       | **the gate**: Biome (formatting, lint, import order) + `tsc --noEmit`                                                                                         |
| `bun run fix`                                         | **fix everything Biome can**: formatting, lint, import order                                                                                                  |
| `bun run format`                                      | rewrite formatting only                                                                                                                                       |
| `bun run format:check`                                | verify formatting only                                                                                                                                        |
| `bun run lint`                                        | lint only                                                                                                                                                     |
| `bun run lint:fix`                                    | apply lint fixes only                                                                                                                                         |
| `bun run typecheck`                                   | `tsc --noEmit` across the workspace                                                                                                                           |
| `bun run check:modules`                               | verify the vendored backoffice links in a browser                                                                                                             |
| `bun run start:local`                                 | **local development**: `bunbraco start` in `apps/site` — migrate, seed, reset and print the admin password, serve                                             |
| `bun run start:local:watch`                           | as above, reloading on change                                                                                                                                 |
| `bun run dev`                                         | `apps/site/server.ts` under `bun --watch`, with no password handling                                                                                          |
| `bunx bunbraco <cmd>`                                 | the CLI: `start [--bundle <dir>]`, `init [--name\|--postgres\|--template]`, `status [--json]`, `admin reset-password`, `schema check\|sync\|export\|rewrite\|purge\|new\|add-property`, `generate`, `views check\|list\|new`, `assets list\|new`, `content export\|check\|import\|runs\|revert\|publish\|unpublish`, `domains [set\|clear\|apply\|undo]`, `dictionary export\|import`, `upgrade [check [--fix]\|--plan\|ledger\|schema]` |
| `bun add -g @bunbraco/cli`                            | the same CLI without a site: `init` somewhere new, or run commands against a site this machine does not serve                                                  |
| `bun run build:template`                              | regenerate a starter template's content bundle and images (`scripts/build-template.ts`); no argument does every template                                       |
| `bun run generate:types`                              | regenerate contract types from `contracts/OpenApi.json`                                                                                                       |
| `bun run coverage:api`                                | implemented vs. total API operations → `docs/api-coverage.md`                                                                                                 |
| `bun run vendor:backoffice`                           | build `vendor/backoffice/` from npm                                                                                                                           |
| `bun run vendor:refresh-static`                       | re-seed `vendor/upstream-static/` from `$UMBRACO_SRC`                                                                                                         |
| `bun run localizations:build`                         | regenerate the per-language branding overrides in `backoffice-host/plugin/localizations/`; `vendor:backoffice` already runs it                                 |
| `bun run docker:down`                                 | stop the test containers and remove any stray `run` container                                                                                                 |
| `bun run docker:reset`                                | the same, and delete the volumes too, including the database                                                                                                   |
| `bun run docker:build`                                | rebuild the CMS image                                                                                                                                         |
| `bun run db:up`                                       | start only Postgres (what `test:postgres` uses)                                                                                                               |
| `bun run release:version <v>`                         | set one version across every published package, the backoffice plugin manifests, `bun.lock` and the `VERSION` constant; `--backoffice-dist <v>` bumps the vendored client instead |
| `bun run release:dry-run`                             | pack every package and check the tarballs, publishing nothing                                                                                                 |
| `bun run release:publish`                             | pack and publish to npm; skips versions the registry already holds                                                                                            |

---
