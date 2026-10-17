# Configuration and scripts

Every setting the server reads, and every command the repository defines. The
defaults are chosen so that a clone runs with nothing set.

## Environment variables

| Variable                                    | Default                                        | Purpose                                                                                                |
| ------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `PORT`                                      | `8080`                                         | HTTP port; the backoffice derives its application URL from it                                          |
| `CROMBOLO_DB`                               | `sqlite`                                       | `sqlite` or `postgres`                                                                                 |
| `CROMBOLO_SQLITE_FILE`                      | `crombolo.sqlite`                              | SQLite path, or `:memory:`                                                                             |
| `CROMBOLO_POSTGRES_URL`                     | —                                              | required when `CROMBOLO_DB=postgres`                                                                   |
| `CROMBOLO_SECRET_KEY`                       | —                                              | seals secrets kept in the database, such as a webhook's headers (32+ characters); without it they are not offered (`docs/webhooks.md`) |
| `CROMBOLO_API_CLIENT_ID` | — | an API client an unattended install seeds in the administrators group (starts `crombolo-back-office-`); with it, no password administrator is seeded unless `CROMBOLO_ADMIN_PASSWORD` is set (`docs/operations.md`) |
| `CROMBOLO_API_CLIENT_SECRET` | — | that client's secret; set with the id, never printed, never rotated from here |
| `CROMBOLO_LOCAL_ADMIN` | `false` | seed the password administrator even with an API client, on localhost only; the demo sites set it |
| `CROMBOLO_REMOTE_ENABLED` | `false` | answer the remote protocol, so `crombolo pull` and `push` can reach this site (`docs/remote-protocol.md`) |
| `CROMBOLO_REMOTE_ENVIRONMENT` | `production` | the environment this server is, as the remote protocol names it |
| `CROMBOLO_REMOTE_PROTECTED` | `true` | a push here needs the protected-push permission |
| `CROMBOLO_REMOTE_APPROVALS` | `false` | a push to a protected environment waits for someone else to approve it; needs `CROMBOLO_SECRET_KEY` |
| `CROMBOLO_REMOTE_MAX_UPLOAD_GB` | `50` | the largest push or media file a client may upload; every other request keeps `CROMBOLO_MAX_REQUEST_BODY_MB` |
| `CROMBOLO_LOCK_TIMEOUT_SECONDS`             | `15`                                           | how long a content write waits for another before answering 503 (`docs/architecture.md`)               |
| `CROMBOLO_ADMIN_LOGIN`                      | `admin@crombolo.local`                         | seeded administrator                                                                                   |
| `CROMBOLO_ADMIN_PASSWORD`                   | generated in development                       | the first administrator's password, used only when the database is created; unset in production, the site is set up in the browser |
| `CROMBOLO_SETUP_CODE`                       | —                                              | guards "Set up your new site" (16+ characters, chosen by you); never printed or shown (`docs/operations.md`) |
| `CROMBOLO_BOOT_ATTEMPTS`                    | `10`                                           | how many times `crombolo start` tries to boot, with backoff from 2s to 60s, before it exits            |
| `CROMBOLO_COMPONENTS_DIR`                        | `apps/site/Views`                              | where template views live                                                                              |
| `CROMBOLO_COMPONENTS_CACHE_DIR`                  | `<site>/.crombolo/components`                  | where components are snapshotted so an edit needs no restart; inside the site, outside `components/` |
| `CROMBOLO_COMPONENTS_GATE_MS`                    | `5000`, `500` in development                   | how often a node looks for a changed views tree                                                          |
| `CROMBOLO_COMPONENTS_SWAP_MS`                    | `10000`, `0` in development                    | the floor between generations, which absorbs a flapping sync; an announced save is never delayed by it    |
| `CROMBOLO_COMPONENTS_GENERATION_LIMIT`           | `250`                                          | generations a node loads before it freezes, keeps serving and refuses newer ones                         |
| `CROMBOLO_RENDER_TIMEOUT_MS`                     | `10000`                                        | how long a page may take to render, layouts included, before it fails and its `signal` aborts; `0` for no limit |
| `CROMBOLO_COMPONENTS_KEEP`                       | `3`                                            | generations left on disk, for an instant return to one                                                   |
| `CROMBOLO_BACKOFFICE_PATH`                  | `/crombolo`                                    | where the editor is mounted; the Management API stays at `/umbraco/management/api/v1`                  |
| `CROMBOLO_INSECURE_COOKIES`                 | `false`                                        | drops the `__Host-` prefix and `Secure`, for plain-http hosts that are not localhost                   |
| `CROMBOLO_SCHEMA_DIR`                       | `schema`                                       | where `*.toml` definitions live; sync is skipped when absent                                           |
| `CROMBOLO_SCHEMA_REVISION`                  | `0`                                            | set by the deploy; orders deploys within one schema version                                            |
| `CROMBOLO_NODE_ID`                          | `host:pid`                                     | the identity stamped on schema syncs, content changes and the migration ledger                          |
| `CROMBOLO_SCHEMA_WRITABLE`                  | `true` unless `NODE_ENV=production`            | whether the backoffice may write schema files                                                          |
| `CROMBOLO_SYNC_SCHEMA_AT_BOOT`              | `true`                                         | `false` when a pipeline runs `crombolo types sync` itself                                             |
| `CROMBOLO_UPGRADE_POLICY`                   | `strict` in production, else `pending-allowed` | whether findings that need a person gate `upgrade`                                                     |
| `CROMBOLO_PG_DUMP`                          | —                                              | a shell command that backs up Postgres before `--fix`, `upgrade` and `purge` (else `--backup-taken`)   |
| `CROMBOLO_MEDIA_DIR`                        | `media`                                        | where uploaded files live, served at `/media/`; resized variants are cached in its `.cache`            |
| `CROMBOLO_VERSION_CLEANUP`                  | `false`                                        | `true` runs the hourly version cleanup, as Umbraco's `EnableCleanup`                                   |
| `CROMBOLO_VERSION_CLEANUP_KEEP_ALL_DAYS`    | `7`                                            | keep every version newer than this; a content type's own policy wins                                   |
| `CROMBOLO_VERSION_CLEANUP_KEEP_LATEST_DAYS` | `90`                                           | then keep each day's latest version for this long                                                      |
| `CROMBOLO_AUDIT_RETENTION_DAYS`            | `365`                                          | how long the audit log keeps an entry; `0` keeps them all ([`audit-log.md`](audit-log.md))            |
| `CROMBOLO_ACTOR`                            | the account running the command                | who the command line records in the audit log, for a pipeline acting for someone                       |
| `CROMBOLO_LOGS_DIR`                         | `logs`                                         | where log files are written (Serilog's compact JSON, a file per day), read by the log viewer           |
| `CROMBOLO_LOG_LEVEL`                        | `info`                                         | the least severe level logged: `trace`, `debug`, `info`, `warning`, `error`, `fatal`                   |
| `CROMBOLO_LOG_TO_CONSOLE`                   | `true`                                         | whether log events are also printed                                                                    |
| `CROMBOLO_TRACE_REQUESTS`                   | `false`                                        | a debug line per request as it arrives and as its handler returns, console only                        |
| `CROMBOLO_HEAP_INTERVAL_SECONDS`            | `0`                                            | every N seconds: heap, RSS, and requests in flight — pending in Bun versus still in a handler          |
| `CROMBOLO_CSS_DIR`                          | `css`                                          | stylesheets the Settings section edits, served at `/css/`                                              |
| `CROMBOLO_SCRIPTS_DIR`                      | `scripts`                                      | scripts the Settings section edits, served at `/scripts/`                                              |
| `CROMBOLO_USERNAME_IS_EMAIL`                | `true`                                         | Umbraco's `UsernameIsEmail`: a backoffice user's login is their e-mail                                 |
| `CROMBOLO_MAX_REQUEST_BODY_MB`              | `32`                                           | the largest request body read, media uploads included; Bun's own default would be 128                  |
| `CROMBOLO_APPLICATION_URL`                  | `http://localhost:<port>`                      | the public URL invitation and password-reset links point at                                            |
| `CROMBOLO_MEDIA_STORE`                      | `filesystem`                                   | where media bytes live: `filesystem`, `s3` or `azure` (see [operations](operations.md#media-storage))            |
| `CROMBOLO_MEDIA_PUBLIC_URL`                 | —                                              | a CDN in front of the media root; browsers are redirected there instead of being served by this server |
| `CROMBOLO_ALLOW_MEMBER_REGISTRATION`        | `false`                                        | whether `POST /umbraco/members/register` accepts a registration                                        |
| `CROMBOLO_MEMBER_REGISTRATION_TYPE`         | `Member`                                       | the member type a registration creates, by alias — a type named in the request is ignored              |
| `CROMBOLO_MEMBER_REGISTRATION_GROUPS`       | —                                              | comma-separated member group names a registration joins                                                |
| `CROMBOLO_MEMBER_SESSION_MINUTES`           | `20160` (14 days)                              | how long a member's sign-in is good for                                                                |
| `CROMBOLO_MAX_FAILED_PASSWORD_ATTEMPTS`     | `5`                                            | failed member sign-ins before lockout; `0` never locks out                                             |
| `CROMBOLO_TRACK_REDIRECTS`                  | `true`                                         | whether renaming or moving a page records a redirect from the URL it had                               |
| `CROMBOLO_APPLY_BUNDLE_CONTENT`             | `true`                                         | whether a Marketplace install also applies the schema, components and content the bundle carries       |
| `CROMBOLO_RUNTIME_INSTALLS`                 | `true`, `false` with a schema store            | whether the Packages section installs and removes packages on the running node; off, they go in `package.json` and a deploy |
| `CROMBOLO_INDEXABLE`                        | `true`                                         | `false` keeps search engines out: `Disallow: /`, no sitemap, `noindex` on every page (staging)        |
| `CROMBOLO_SITEMAP`                          | `true`                                         | whether `/sitemap.xml` is served                                                                       |
| `CROMBOLO_DELIVERY_API`                     | `false`                                        | whether Umbraco's Delivery API answers ([`delivery-api.md`](delivery-api.md))                          |
| `CROMBOLO_DELIVERY_API_KEY`                 | unset                                          | the `Api-Key` that unlocks a non-public Delivery API and preview                                       |
| `CROMBOLO_DELIVERY_API_PUBLIC`              | `true`                                         | `false` makes every Delivery API request need the key                                                  |
| `CROMBOLO_DELIVERY_API_MEDIA`               | `false`                                        | whether the Delivery API serves media                                                                  |
| `CROMBOLO_MARKETPLACE_URL`                  | npm search for the keyword                     | where the Bundles section sends someone browsing for bundles                                       |
| `CROMBOLO_PACKAGE_KEYWORD`                  | `crombolo-bundle`                             | the npm keyword a bundle publishes to be discoverable                                    |
| `CROMBOLO_NPM_REGISTRY`                     | `https://registry.npmjs.org`                   | the registry the marketplace searches; a mirror or a test fixture                                      |
| `CROMBOLO_EMAIL_PROVIDER`                   | `none`                                         | how e-mail is sent: `resend`, `postmark`, `ses`, `custom` or `none` (see [E-mail](#e-mail))            |
| `CROMBOLO_EMAIL_FROM`                       | —                                              | the sender address; required by every provider, and the provider verifies its domain                   |
| `CROMBOLO_EMAIL_FROM_NAME`                  | —                                              | the display name beside that address                                                                   |
| `CROMBOLO_EMAIL_API_KEY`                    | —                                              | the provider's key — Resend's API key, Postmark's server token, a bearer token for `custom`            |
| `CROMBOLO_EMAIL_URL`                        | the provider's own API                         | the endpoint messages are POSTed to; required for `custom`, an override for the others                 |
| `CROMBOLO_EMAIL_POSTMARK_STREAM`            | `outbound`                                     | `postmark` only: the message stream to send on                                                         |
| `CROMBOLO_EMAIL_SES_REGION`                 | `AWS_REGION`                                   | `ses` only: the region to send from                                                                    |
| `CROMBOLO_EMAIL_SES_ACCESS_KEY_ID`          | `AWS_ACCESS_KEY_ID`                            | `ses` only: overrides the standard AWS variable                                                        |
| `CROMBOLO_EMAIL_SES_SECRET_ACCESS_KEY`      | `AWS_SECRET_ACCESS_KEY`                        | `ses` only: overrides the standard AWS variable                                                        |
| `CROMBOLO_EMAIL_SES_CONFIGURATION_SET`      | —                                              | `ses` only: the configuration set that governs sending                                                 |
| `CROMBOLO_EMAIL_SES_ENDPOINT`               | the regional SES host                          | `ses` only: a VPC endpoint, or a fake in a test                                                        |

## The sites in this repository

`sites/` holds the sites this repository builds, one directory each, committed:

| Site | Id | Ships with the CLI |
| --- | --- | --- |
| `sites/starter` | `starter` | yes |
| `sites/harbourstone` | `demo/harbourstone` | yes |
| `sites/crombolo` | `demo/crombolo` | no — the product site |

Each is a real site — `package.json`, `crombolo.config.ts`, `server.ts`, `schema/`,
`components/`, `css/` — plus a `site.json` naming it, and its content bundle under
`bundles/<slug>`. Each `package.json` is a private workspace depending on
`crombolo: workspace:*`, so after `bun install` it runs the working tree. What it
writes as it runs — the database, its backups, media, logs, the view cache — is
gitignored. `bun run site <id>` runs a copy of it rather than the site itself
(below), so the committed files change only when you mean them to.

None is published by default. A site whose `site.json` says `"distribute": true`
is staged into `@crombolo/cli`'s `templates/` only while the CLI is packed
(`scripts/publish-packages.ts`, through `scripts/sites.ts`), as `components/`,
`css/` and `schema/` under `files/`, its bundle as `bundle/`, and `CREDITS.md`
beside them; the media types `init` writes for itself are left out. Only
`templates/basic` is committed in the CLI.

A site's bundle is generated, not edited: `scripts/build-template.ts` creates the
content in a throwaway database from the site's own schema and exports it, so
`bun run build:template <id>` is how a change to the content lands.

## The demo command and the database it may touch

`bun run site <id>` exists so running one of the sites in `sites/`, or trying a
template the CLI ships, is one command rather than four. A site in `sites/` is
copied into `.scaffolds/<slug>` on its first run and runs from there; a CLI
template is scaffolded first. Two decisions in it are worth
stating, because both are about not damaging anything:

- **The database is forced, not defaulted.** The dialect is SQLite and the file
  is inside the site, whatever the environment says — a `.env` naming
  Postgres, or a `CROMBOLO_SQLITE_FILE` pointing at a real site, is overridden
  rather than honoured. A demo cannot migrate or seed a live database even by
  accident. If a scaffold's own file already holds content the run stops and
  names the two flags that continue it; a site in `sites/` carries on with its
  own.
- **A site runs from a copy.** What the backoffice writes — a form, a workflow,
  a content type, a bundle — goes to the site's files, and in `sites/` those are
  committed. The copy leaves out the database, media, logs, view cache and
  `node_modules`, is kept between runs so content made in it survives, and is
  replaced by `--fresh`. `--in-place` runs the committed site, for changing it
  through the backoffice on purpose; there `--fresh` clears only what it wrote as
  it ran.
- **A scaffold lives in `.scaffolds/<template>`**, not `output/`. The compose stack
  mounts `cms_output:/app/output`, which masks the host directory inside the
  container, so a site scaffolded there would be invisible to `--docker`.
- **Ctrl-C ends the run, the container included.** `--docker` runs the site in a
  `compose run` container, and such a container keeps the port it published once
  its client has gone — so the script waits out its child's shutdown rather than
  dying on the first press, and removes the container by a name it chose itself.
  A second press forces it. A container left by a run that was killed outright is
  cleared by the next one, so nothing needs `docker:down` by hand.
  `.scaffolds/` is inside the bind mount, matches no workspace glob — so it joins
  no `bun install` — and is gitignored. `sites/` is a workspace glob, so its sites
  link to the working tree through their own `workspace:*` dependencies.

Nothing is installed into a scaffold. Resolution walks up to this repository's
`node_modules`, where every `@crombolo/*` name is a workspace symlink, so the
demo serves the working tree. That is the point: a demo that installed from npm
would not show you your own changes.

## Settings with no environment variable

Five things a site declares only in `crombolo.config.ts`, because each of them
is code rather than a value:

| Setting | What it is |
| --- | --- |
| `assistant` | the AI helper; enabling it takes a provider ([`assistant.md`](assistant.md)) |
| `redirects` | rules built with `redirect()`, synced into the database at boot ([`rendering.md`](rendering.md)) |
| `bundles` | the server halves of the bundles this site runs ([`bundles.md`](bundles.md)) |
| `memberIdentityProviders` | identity providers members sign in with on the site: `entra()`, `awsIdentityCenter()`, `oidc()` ([`operations.md`](operations.md#signing-in-through-an-identity-provider)) |
| `backofficeIdentityProviders` | the same, for backoffice users; a separate list, so staff and members can use different providers |

`deliveryApi` is the same: its switches and key have environment variables
above, and member sign-in — clients, secrets, redirect URLs, the login page — is
set in `crombolo.config.ts` ([`delivery-api.md`](delivery-api.md)).

`seo` sits between the two: its two switches have environment variables above,
and the rest — robots rules, site name, title suffix, sharing image, not-found
page — are set in `crombolo.config.ts` or in Settings → Search & sharing, which
wins field by field ([`seo.md`](seo.md)).

`bundles` has no environment variable deliberately, and the absence is tested. A
variable naming a package would be a way to start third-party code in the server
process without a code change, and the point of the list is that it is a
reviewable, deployed decision:

```ts
import { redirects } from '@crombolo/simple-redirects'
import { defineConfig } from '@crombolo/crombolo'

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
`GET /umbraco/crombolo/api/email` tells a signed-in client why. `crombolo status`
has an `email` line, and the boot log says it once.

Set it from the environment, or pass a port as `email` in `crombolo.config.ts`:

```ts
import { resendEmail } from '@crombolo/crombolo'

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
rather than through a provider — a function in `crombolo.config.ts` handed the
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
| `bun run test:ci`                                     | the suite with the test environment but no dialect pinned — CI sets `CROMBOLO_DB` itself                                                                      |
| `bun run test:browser`                                | the real backoffice in headless Chrome against a throwaway site; fails on console errors, failed requests and 4xx/5xx (`docs/testing.md`)                  |
| `bun run docker:test:browser`                         | the same suite in its own Playwright image; Chromium rather than Chrome (no Linux arm64 Chrome)                                                               |
| `bun run test:load` / `docker:test:load` | the `*.load.ts` suite: concurrent edits on overlapping branches, then an invariant pass; the release pipeline runs it on both dialects |
| `bun run test:bench` / `docker:test:bench` | the `*.bench.ts` suite: a generated 25,000-page site timed against the budgets in `testing.md`; the release pipeline runs it on both dialects |
| `bun run test:integration` / `docker:test:integration` | the `*.integration.ts` suites: the real CLI spawned per step, for creating a site, importing an Umbraco site, content transfer and the upgrade. Named so `bun test` leaves them out; CI always runs them |
| `bun run check`                                       | **the gate**: Biome (formatting, lint, import order) + `tsc --noEmit`                                                                                         |
| `bun run fix`                                         | **fix everything Biome can**: formatting, lint, import order                                                                                                  |
| `bun run format`                                      | rewrite formatting only                                                                                                                                       |
| `bun run format:check`                                | verify formatting only                                                                                                                                        |
| `bun run lint`                                        | lint only                                                                                                                                                     |
| `bun run lint:fix`                                    | apply lint fixes only                                                                                                                                         |
| `bun run typecheck`                                   | `tsc --noEmit` across the workspace                                                                                                                           |
| `bun run check:modules`                               | verify the vendored backoffice links in a browser                                                                                                             |
| `bun run start:local`                                 | **local development**: `crombolo start` in `apps/site` — migrate, seed, reset and print the admin password, serve                                             |
| `bun run start:local:watch`                           | as above, reloading on change                                                                                                                                 |
| `bun run dev`                                         | `apps/site/server.ts` under `bun --watch`, with no password handling                                                                                          |
| `bun run site <id>`                                   | **a site, running**: a copy of a site in `sites/`, or a CLI template scaffolded, in `.scaffolds/`. `--docker` in the compose stack, `--fresh` to copy or scaffold again, `--in-place` to run a site in `sites/` itself, `--reuse` to accept a scaffold whose database holds content, `--dry-run` to say what it would do. Runs the working tree, not the published packages |
| `bunx crombolo <cmd>`                                 | the CLI: `start [--bundle <dir>] [--from <file>]`, `export --site`, `import <file> [--replace\|--replace-all]`, `init [--name\|--postgres\|--template]`, `status`, `admin reset-password`, `types check\|sync\|export\|rewrite\|purge\|new\|add-property`, `generate`, `components check\|list\|new`, `assets list\|new`, `content export\|check\|import\|runs\|revert\|publish\|unpublish`, `domains [set\|clear\|apply\|undo]`, `dictionary export\|import`, `upgrade [check [--fix]\|--plan\|ledger]`, `remote add\|list\|remove\|job`, `login\|logout\|whoami`, `pull`, `push`, `media fetch\|import\|export`, `maintenance pause\|resume\|status`, `bundle purge`, `users list\|unlock\|enable\|disable\|reset-password\|reset-2fa\|invite`, `api-client rotate`, `index list\|rebuild`, `cache rebuild`, `health`, `recycle-bin empty`, `schema` (this CLI described for machines); every command takes `-o json` |
| `bun add -g @crombolo/cli`                            | the same CLI without a site: `init` somewhere new, or run commands against a site this machine does not serve                                                  |
| `bun run build:template`                              | regenerate a starter template's content bundle and images (`scripts/build-template.ts`); no argument does every template                                       |
| `bun run generate:types`                              | regenerate contract types from `contracts/OpenApi.json`                                                                                                       |
| `bun run coverage:api`                                | implemented vs. total API operations → `docs/api-coverage.md`                                                                                                 |
| `bun run vendor:backoffice`                           | build `vendor/backoffice/` from npm                                                                                                                           |
| `bun run vendor:refresh-static`                       | re-seed `vendor/upstream-static/` from `$UMBRACO_SRC`                                                                                                         |
| `bun run localizations:build`                         | regenerate the per-language overrides in `backoffice-host/plugin/localizations/` (the product name, and "content type" for "content type"); `vendor:backoffice` already runs it                                 |
| `bun run docker:down`                                 | stop the test containers and remove any stray `run` container                                                                                                 |
| `bun run docker:reset`                                | the same, and delete the volumes too, including the database                                                                                                   |
| `bun run docker:build`                                | rebuild the CMS image                                                                                                                                         |
| `bun run db:up`                                       | start only Postgres (what `test:postgres` uses)                                                                                                               |
| `bun run release:version <v>`                         | set one version across every published package, the backoffice plugin manifests, `bun.lock` and the `VERSION` constant; `--backoffice-dist <v>` bumps the vendored client instead |
| `bun run release:dry-run`                             | pack every package and check the tarballs, publishing nothing                                                                                                 |
| `bun run release:publish`                             | pack and publish to npm; skips versions the registry already holds                                                                                            |

---
