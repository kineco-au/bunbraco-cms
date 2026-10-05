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
| `BUNBRACO_COMPONENTS_DIR`                        | `apps/site/Views`                              | where template views live                                                                              |
| `BUNBRACO_COMPONENTS_CACHE_DIR`                  | `<site>/.bunbraco/components`                  | where components are snapshotted so an edit needs no restart; inside the site, outside `components/` |
| `BUNBRACO_COMPONENTS_GATE_MS`                    | `5000`, `500` in development                   | how often a node looks for a changed views tree                                                          |
| `BUNBRACO_COMPONENTS_SWAP_MS`                    | `10000`, `0` in development                    | the floor between generations, which absorbs a flapping sync; an announced save is never delayed by it    |
| `BUNBRACO_COMPONENTS_GENERATION_LIMIT`           | `250`                                          | generations a node loads before it freezes, keeps serving and refuses newer ones                         |
| `BUNBRACO_COMPONENTS_KEEP`                       | `3`                                            | generations left on disk, for an instant return to one                                                   |
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
| `BUNBRACO_MARKETPLACE_URL`                  | npm search for the keyword                     | where the Bundles section sends someone browsing for bundles                                       |
| `BUNBRACO_PACKAGE_KEYWORD`                  | `bunbraco-bundle`                             | the npm keyword a bundle publishes to be discoverable                                    |
| `BUNBRACO_NPM_REGISTRY`                     | `https://registry.npmjs.org`                   | the registry the marketplace searches; a mirror or a test fixture                                      |
| `BUNBRACO_EMAIL_PROVIDER`                   | `none`                                         | how e-mail is sent: `resend`, `postmark`, `ses`, `custom` or `none` (see [E-mail](#e-mail))            |
| `BUNBRACO_EMAIL_FROM`                       | —                                              | the sender address; required by every provider, and the provider verifies its domain                   |
| `BUNBRACO_EMAIL_FROM_NAME`                  | —                                              | the display name beside that address                                                                   |
| `BUNBRACO_EMAIL_API_KEY`                    | —                                              | the provider's key — Resend's API key, Postmark's server token, a bearer token for `custom`            |
| `BUNBRACO_EMAIL_URL`                        | the provider's own API                         | the endpoint messages are POSTed to; required for `custom`, an override for the others                 |
| `BUNBRACO_EMAIL_POSTMARK_STREAM`            | `outbound`                                     | `postmark` only: the message stream to send on                                                         |
| `BUNBRACO_EMAIL_SES_REGION`                 | `AWS_REGION`                                   | `ses` only: the region to send from                                                                    |
| `BUNBRACO_EMAIL_SES_ACCESS_KEY_ID`          | `AWS_ACCESS_KEY_ID`                            | `ses` only: overrides the standard AWS variable                                                        |
| `BUNBRACO_EMAIL_SES_SECRET_ACCESS_KEY`      | `AWS_SECRET_ACCESS_KEY`                        | `ses` only: overrides the standard AWS variable                                                        |
| `BUNBRACO_EMAIL_SES_CONFIGURATION_SET`      | —                                              | `ses` only: the configuration set that governs sending                                                 |
| `BUNBRACO_EMAIL_SES_ENDPOINT`               | the regional SES host                          | `ses` only: a VPC endpoint, or a fake in a test                                                        |

## The demo command and the database it may touch

`bun run site <template>` exists so trying a starter template is one command
rather than four. Two decisions in it are worth stating, because both are about
not damaging anything:

- **The database is forced, not defaulted.** The dialect is SQLite and the file
  is inside the scaffolded site, whatever the environment says — a `.env` naming
  Postgres, or a `BUNBRACO_SQLITE_FILE` pointing at a real site, is overridden
  rather than honoured. A demo cannot migrate or seed a live database even by
  accident. If the site's own file already holds content the run stops and names
  the two flags that continue it.
- **The site lives in `sites/<template>`**, not `output/`. The compose stack
  mounts `cms_output:/app/output`, which masks the host directory inside the
  container, so a site scaffolded there would be invisible to `--docker`.
  `sites/` is inside the bind mount, matches no workspace glob — so it joins no
  `bun install` — and is gitignored.

Nothing is installed into the site. Resolution walks up to this repository's
`node_modules`, where every `@bunbraco/*` name is a workspace symlink, so the
demo serves the working tree. That is the point: a demo that installed from npm
would not show you your own changes.

## Settings with no environment variable

Three things a site declares only in `bunbraco.config.ts`, because each of them
is code rather than a value:

| Setting | What it is |
| --- | --- |
| `assistant` | the AI helper; enabling it takes a provider ([`11-assistant.md`](11-assistant.md)) |
| `redirects` | rules built with `redirect()`, synced into the database at boot ([`05-rendering.md`](05-rendering.md)) |
| `bundles` | the server halves of the bundles this site runs ([`17-bundles.md`](17-bundles.md)) |

`bundles` has no environment variable deliberately, and the absence is tested. A
variable naming a package would be a way to start third-party code in the server
process without a code change, and the point of the list is that it is a
reviewable, deployed decision:

```ts
import { redirects } from '@bunbraco/simple-redirects'
import { defineConfig } from 'bunbraco'

export default defineConfig({
  bundles: [redirects()],
})
```

Installing a bundle from the Bundles section gives you its backoffice screen.
This line is what lets it answer a request.

## E-mail

Opt-in, and off by default. Nothing is installed, no SMTP is spoken, and a site
that configures no provider sends no e-mail — which is a supported state, not a
broken one.

What needs it: inviting backoffice users, resetting a forgotten password, and
Forms' Send email workflow. Without a provider those are **unavailable rather
than failing**: the backoffice hides Invite and offers Create (which shows a
generated first password), the sign-in screen drops "Forgotten password?", and
`GET /umbraco/bunbraco/api/email` tells a signed-in client why. `bunbraco status`
has an `email` line, and the boot log says it once.

Set it from the environment, or pass a port as `email` in `bunbraco.config.ts`:

```ts
import { resendEmail } from 'bunbraco'

export default defineConfig({
  email: resendEmail({ apiKey: process.env.RESEND_KEY ?? '', from: { email: 'no-reply@example.com', name: 'Example' } }),
})
```

Four adapters, all plain `fetch` against a provider's HTTPS API:

| Adapter | Takes | Notes |
| --- | --- | --- |
| `resendEmail` | `apiKey`, `from` | Resend verifies the sending domain |
| `postmarkEmail` | `apiKey` (server token), `from`, `messageStream?` | rejects a send on the wrong stream, so the stream is configurable |
| `sesEmail` | `region`, `from`, credentials | SES v2, signed with SigV4; attachments become a raw MIME message |
| `customEmail` | `url`, `from`, `apiKey?`, `headers?` | POSTs this CMS's own JSON to an endpoint the site owns |

### HTTPS is required

Every adapter authenticates with something worth stealing — a bearer token, a
server token, a SigV4 `Authorization` header — so an `http://` endpoint is
refused **at construction**, not on the first send. A site that gets it wrong
fails at boot with the reason; from the environment it is a warning and no
e-mail, because an opt-in feature must never stop a site booting.

The one exception is loopback: `http://localhost:8025` and the rest of
`127.0.0.0/8` and `[::1]` are allowed, because a mail relay in a sidecar is a
real deployment and nothing about it is on a wire. A host that merely looks
local — a service name inside a cluster, or `localhost.example.com` — still
crosses a boundary and is held to HTTPS like anything else.

### SES and its signature

SES authenticates with a Signature Version 4 signature rather than a key, so the
signing is ours (`email-ses.ts`) rather than an SDK's. Hand-rolled signing is
only defensible against known answers, so it is held against two:

- AWS's **published signing-key derivation example** — the `us-east-1`/`iam`
  vector from their own documentation
- **Bun's own SigV4**, which is an independent implementation: `Bun.S3Client.presign`
  signs a canonical request, and ours must produce the identical signature for
  the same inputs. This reaches the canonicalisation and the string-to-sign,
  which a key vector alone does not

Both run on every suite, so a change that breaks the signing fails the build
rather than failing in production.

Credentials come from the options, else from the variables AWS tools already
read. **Instance roles are not resolved** — that needs the metadata service — so
a container wanting SES needs static keys or a session token
(`AWS_SESSION_TOKEN` is signed in when present).

SES's Simple content carries a subject and a body and nothing else, so a message
with an attachment is sent as raw MIME: `multipart/mixed`, with a nested
`multipart/alternative` when there is both text and HTML. Bcc stays out of the
MIME headers and travels in `Destination`, where it cannot be shown to the other
recipients.

No SMTP adapter. Outbound 25/587 is blocked on most container hosts, so an SMTP
client would be protocol risk for a path that often cannot be used; one can be
added behind the same port if a self-hosted mail server turns out to matter.

`email` has three states: a port sends through it, `undefined` lets the
environment decide and falls back in development to printing the message on the
console, and `null` is off outright — console included, so a site that declares
it has no e-mail behaves the same in every environment.

Sending never throws. A provider that is down, a wrong key and a dead network
all come back as a failed send with the provider's own message, which is what
the log records and what an invitation's failure reports.

`sendUserLink` remains, for a site that wants to deliver these two links itself
rather than through a provider — a function in `bunbraco.config.ts` handed the
link. It outranks `email`, and `sendUserLink: null` means nobody can be invited
and no password can be reset whatever else is configured.
`allowPasswordReset: true` shows "Forgotten password?" on the sign-in screen,
when a link can actually be delivered.

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
| `bun run test:integration` / `docker:test:integration` | the `*.integration.ts` suites: the real CLI spawned per step, for creating a site, importing an Umbraco site, content transfer and the upgrade. Named so `bun test` leaves them out; CI always runs them |
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
| `bun run site <template>`                             | **a starter template, running**: scaffolds it into `sites/<template>` and starts it. `--docker` in the compose stack, `--fresh` to scaffold again, `--reuse` to accept a database that already holds content, `--dry-run` to say what it would do. Runs the working tree, not the published packages |
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
