# Configuration and scripts

Every setting the server reads, and every command the repository defines. The
defaults are chosen so that a clone runs with nothing set.

## How a site is configured

A site's settings come from three places, and the first one that gives a value
wins:

1. **`crombolo.config.ts`**, the site's config file, which exports
   `defineConfig({...})`. Anything set here is fixed for every environment the
   site runs in, and the settings that are code — a provider, a bundle, a
   redirect rule — can only be set here.
2. **The environment**: the variables below, from the process, a container or a
   `.env` file beside the site (Bun reads it on start).
3. **The defaults**, in the tables below.

```ts
import { defineConfig } from '@crombolo/crombolo'

export default defineConfig({
  siteName: 'Acme',
  seo: { titleSuffix: ' | Acme' },
})
```

Grouped settings — `seo`, `remote`, `deliveryApi` — merge field by field, so a
config file that sets the title suffix keeps the environment's sitemap switch.
Relative paths are resolved against the site's own folder, not wherever the
process was started.

```sh
# .env for a site on Postgres, sending e-mail through Resend
CROMBOLO_DB=postgres
CROMBOLO_POSTGRES_URL=postgres://crombolo:crombolo@localhost:5432/acme
CROMBOLO_APPLICATION_URL=https://www.acme.example
CROMBOLO_EMAIL_PROVIDER=resend
CROMBOLO_EMAIL_API_KEY=re_…
CROMBOLO_EMAIL_FROM=no-reply@acme.example
```

## Environment variables

Every variable crombolo reads is declared once, in the settings list in
`packages/server/src/settings.ts`. `loadConfig` reads the environment only
through that list, and the tables below are generated from it by
`bun run docs:config` — edit the list, not the tables. A test fails when the
code reads a variable the list does not declare, when the list declares one
nothing reads, and when these tables and the list disagree.

Settings marked as read by the command line are used by `crombolo` commands
rather than the running server. Secret ones are never printed or logged.

<!-- settings:start -->

### Server

| Setting | Takes | Default | Description |
| --- | --- | --- | --- |
| `NODE_ENV` | string | — | `production` turns off the development conveniences: generated admin passwords, writable schema files, e-mail to the console and relaxed upgrade checks. |
| `PORT` | number | `8080` | The HTTP port. The application URL defaults to localhost on this port. |
| `CROMBOLO_SITE_NAME` | string | `Crombolo` | The site's name, shown in the back office and used when a page is shared. |
| `CROMBOLO_APPLICATION_URL` | string | `http://localhost:<port>` | The site's public address, which invitation and password-reset links point at. |
| `CROMBOLO_ROLE` | `all`, `api`, `web` | `all` | What this process serves: everything, the back office and its API, or the public site alone. Splitting needs Postgres; a misspelt role stops the server. |
| `CROMBOLO_NODE_ID` | string | `host:pid` | This node's name, stamped on schema syncs, content changes and the upgrade history. |
| `CROMBOLO_MAX_REQUEST_BODY_MB` | number | `32` | The largest request body the server reads, media uploads included. |
| `CROMBOLO_INSECURE_COOKIES` | `true` / `false` | `false` | Drops the secure cookie requirements, for a plain-http host that is not localhost. |

### Database

| Setting | Takes | Default | Description |
| --- | --- | --- | --- |
| `CROMBOLO_DB` | `sqlite`, `postgres` | `sqlite` | Which database engine the site runs on. Read by the server and the command line. |
| `CROMBOLO_SQLITE_FILE` | string | `crombolo.sqlite` | The SQLite file, relative to the site, or `:memory:`. Read by the server and the command line. |
| `CROMBOLO_POSTGRES_URL` | string | — | The Postgres connection string. Required when the database is Postgres. Read by the server and the command line. Kept secret: never printed. |
| `DATABASE_URL` | string | — | Used as the Postgres connection string when `CROMBOLO_POSTGRES_URL` is unset. Read by the server and the command line. Kept secret: never printed. |
| `CROMBOLO_LOCK_TIMEOUT_SECONDS` | number | `15` | How long a content write waits for another before it gives up and answers 503. Read by the server and the command line. |
| `CROMBOLO_PG_DUMP` | string | — | A shell command that backs up Postgres before a repair, an upgrade or a purge. It is given `CROMBOLO_BACKUP_STAMP` and `CROMBOLO_BACKUP_REASON`; without it those commands need `--backup-taken`. Read by the server and the command line. |
| `CROMBOLO_UPGRADE_POLICY` | `strict`, `pending-allowed` | strict in production, else pending-allowed | Whether findings that need a person stop an upgrade. Read by the server and the command line. |
| `CROMBOLO_VERSION_CLEANUP` | `true` / `false` | `false` | Runs the hourly clean-up of old content versions. |
| `CROMBOLO_VERSION_CLEANUP_KEEP_ALL_DAYS` | number | `7` | The clean-up keeps every version newer than this many days. A content type's own policy wins. |
| `CROMBOLO_VERSION_CLEANUP_KEEP_LATEST_DAYS` | number | `90` | After that, it keeps each day's latest version for this many days. |
| `CROMBOLO_AUDIT_RETENTION_DAYS` | number | `365` | How many days the audit log keeps an entry. `0` keeps them all. |

### Sign-in and secrets

| Setting | Takes | Default | Description |
| --- | --- | --- | --- |
| `CROMBOLO_ADMIN_LOGIN` | string | `admin@crombolo.local` | The login of the first administrator. |
| `CROMBOLO_ADMIN_PASSWORD` | string | generated in development | The first administrator's password, used only when the database is created. Unset in production, the site is set up in the browser. Kept secret: never printed. |
| `CROMBOLO_SETUP_CODE` | string | — | Guards "Set up your new site" in production: 16 or more characters, chosen by you. Remove it once the site is set up. Kept secret: never printed. |
| `CROMBOLO_API_CLIENT_ID` | string | — | An API client an unattended install creates in the administrators group; it starts `crombolo-back-office-`. With it, no password administrator is created unless `CROMBOLO_ADMIN_PASSWORD` is set. Read by the server and the command line. |
| `CROMBOLO_API_CLIENT_SECRET` | string | — | That client's secret, set together with the id. It is used once, when the client is created. Kept secret: never printed. |
| `CROMBOLO_LOCAL_ADMIN` | `true` / `false` | `false` | Creates the password administrator even when an API client is set. Honoured only on localhost. |
| `CROMBOLO_SECRET_KEY` | string | — | Seals secrets kept in the database, such as a webhook's headers and two-factor keys; 32 or more characters. Features that need it are not offered without it. Kept secret: never printed. |
| `CROMBOLO_USERNAME_IS_EMAIL` | `true` / `false` | `true` | A back office user's login is their e-mail address. |

### Back office and bundles

| Setting | Takes | Default | Description |
| --- | --- | --- | --- |
| `CROMBOLO_BACKOFFICE_PATH` | string | `/crombolo` | Where the back office is served. |
| `CROMBOLO_CSS_DIR` | string | `css` | The stylesheets the Settings section edits, served at `/css/`. |
| `CROMBOLO_SCRIPTS_DIR` | string | `scripts` | The scripts the Settings section edits, served at `/scripts/`. |
| `CROMBOLO_APPLY_BUNDLE_CONTENT` | `true` / `false` | `true` | Installing a bundle from the Marketplace also applies the schema, components and content it carries. |
| `CROMBOLO_RUNTIME_INSTALLS` | `true` / `false` | true, false with a schema store | The Packages section installs and removes packages on the running site. Off, they are added to `package.json` and deployed. |
| `CROMBOLO_MARKETPLACE_URL` | string | `https://www.npmjs.com/search?q=keywords%3Acrombolo-bundle` | Where the Marketplace sends someone browsing for bundles. |
| `CROMBOLO_PACKAGE_KEYWORD` | string | `crombolo-bundle` | The npm keyword a bundle publishes under to be found by the Marketplace. |
| `CROMBOLO_NPM_REGISTRY` | string | `https://registry.npmjs.org` | The registry the Marketplace searches, such as a mirror. |

### Schema

| Setting | Takes | Default | Description |
| --- | --- | --- | --- |
| `CROMBOLO_SCHEMA_DIR` | string | `schema` | Where the schema files live. Nothing is synced when the folder is absent. |
| `CROMBOLO_SCHEMA_REVISION` | string | `0` | Set by a deploy, to order deploys of the same schema version. |
| `CROMBOLO_SCHEMA_CACHE_DIR` | string | `<temp>/crombolo-schema` | Where a schema kept in cloud storage is copied to when the server starts. |
| `CROMBOLO_SCHEMA_WRITABLE` | `true` / `false` | true unless production or with a schema store | Whether the back office may change the schema files. |
| `CROMBOLO_SYNC_SCHEMA_AT_BOOT` | `true` / `false` | `true` | Syncs the schema files when the server starts. Turn it off when a deploy runs `crombolo types sync` itself. |

### Components

| Setting | Takes | Default | Description |
| --- | --- | --- | --- |
| `CROMBOLO_COMPONENTS_DIR` | string | `components` | Where the site's page views and components live. |
| `CROMBOLO_COMPONENTS_CACHE_DIR` | string | `.crombolo/components` | Where components are copied so that an edit is picked up without a restart. Inside the site, and cleared when the server starts. |
| `CROMBOLO_COMPONENTS_GATE_MS` | number | 5000, 500 in development | How often a node looks for changed components, in milliseconds. |
| `CROMBOLO_COMPONENTS_SWAP_MS` | number | 10000, 0 in development | The least time between two changes being picked up, in milliseconds. A save made in the back office is never held back by it. |
| `CROMBOLO_COMPONENTS_GENERATION_LIMIT` | number | `250` | How many changes a node picks up before it stops taking more and keeps serving the last. |
| `CROMBOLO_COMPONENTS_KEEP` | number | 3, all in development | How many earlier copies are kept on disk, for an instant return to one. |
| `CROMBOLO_RENDER_TIMEOUT_MS` | number | `10000` | How long a page may take to render, layouts included, before it fails, in milliseconds. `0` for no limit. |

### Media

| Setting | Takes | Default | Description |
| --- | --- | --- | --- |
| `CROMBOLO_MEDIA_DIR` | string | `media` | Where uploaded files live on this disk, served at `/media/`. |
| `CROMBOLO_MEDIA_STORE` | `filesystem`, `s3`, `azure` | `filesystem` | Where media files are kept. An unrecognised value falls back to the file system. |
| `CROMBOLO_MEDIA_PUBLIC_URL` | string | — | A CDN in front of the media folder: browsers are sent there instead of being served by this server. |
| `CROMBOLO_MEDIA_S3_BUCKET` | string | — | S3: the bucket. |
| `CROMBOLO_MEDIA_S3_REGION` | string | — | S3: the bucket's region. |
| `CROMBOLO_MEDIA_S3_ENDPOINT` | string | — | S3: the endpoint, for an S3-compatible store such as R2, Spaces or MinIO. |
| `CROMBOLO_MEDIA_S3_ACCESS_KEY_ID` | string | — | S3: the access key. Unset, the client's usual credentials are used. |
| `CROMBOLO_MEDIA_S3_SECRET_ACCESS_KEY` | string | — | S3: the access key's secret. Kept secret: never printed. |
| `CROMBOLO_MEDIA_S3_SESSION_TOKEN` | string | — | S3: a session token, for temporary credentials. Kept secret: never printed. |
| `CROMBOLO_MEDIA_S3_PREFIX` | string | — | S3: a folder inside the bucket to keep media under. |
| `CROMBOLO_MEDIA_S3_PUBLIC_URL` | string | — | S3: a public address for the bucket, such as a CDN, that browsers are sent to. |
| `CROMBOLO_MEDIA_S3_PRESIGN_SECONDS` | number | — | S3: sends browsers to a signed bucket address that lasts this many seconds. Use this or a public address, not both. |
| `CROMBOLO_MEDIA_AZURE_ACCOUNT` | string | — | Azure: the storage account. |
| `CROMBOLO_MEDIA_AZURE_CONTAINER` | string | `media` | Azure: the blob container. |
| `CROMBOLO_MEDIA_AZURE_KEY` | string | — | Azure: the account's key. Kept secret: never printed. |
| `CROMBOLO_MEDIA_AZURE_SAS` | string | — | Azure: a shared access signature, instead of the key. Kept secret: never printed. |
| `CROMBOLO_MEDIA_AZURE_ENDPOINT` | string | — | Azure: the blob endpoint, for a sovereign cloud or a local emulator. |
| `CROMBOLO_MEDIA_AZURE_PREFIX` | string | — | Azure: a folder inside the container to keep media under. |
| `CROMBOLO_MEDIA_AZURE_PUBLIC_URL` | string | — | Azure: a public address for the container, such as a CDN, that browsers are sent to. |

### E-mail

| Setting | Takes | Default | Description |
| --- | --- | --- | --- |
| `CROMBOLO_EMAIL_PROVIDER` | `none`, `resend`, `postmark`, `ses`, `custom` | `none` | How e-mail is sent. Without one, invitations, password resets and form e-mails are unavailable; development prints messages to the console. |
| `CROMBOLO_EMAIL_FROM` | string | — | The sender address. Every provider needs it, and verifies its domain. |
| `CROMBOLO_EMAIL_FROM_NAME` | string | — | The name shown beside the sender address. |
| `CROMBOLO_EMAIL_API_KEY` | string | — | The provider's key: Resend's API key, Postmark's server token, or a bearer token for a custom endpoint. Kept secret: never printed. |
| `CROMBOLO_EMAIL_URL` | string | the provider's own API | The address messages are sent to. Required for a custom endpoint, an override for the others. Must be HTTPS unless it is on this machine. |
| `CROMBOLO_EMAIL_POSTMARK_STREAM` | string | `outbound` | Postmark: the message stream to send on. |
| `CROMBOLO_EMAIL_SES_REGION` | string | `AWS_REGION` | SES: the region to send from. |
| `CROMBOLO_EMAIL_SES_ACCESS_KEY_ID` | string | `AWS_ACCESS_KEY_ID` | SES: the access key, when it differs from the standard AWS one. |
| `CROMBOLO_EMAIL_SES_SECRET_ACCESS_KEY` | string | `AWS_SECRET_ACCESS_KEY` | SES: that access key's secret. Kept secret: never printed. |
| `CROMBOLO_EMAIL_SES_CONFIGURATION_SET` | string | — | SES: the configuration set that governs sending. |
| `CROMBOLO_EMAIL_SES_ENDPOINT` | string | the regional SES address | SES: a private endpoint to send through instead. |

### Members

| Setting | Takes | Default | Description |
| --- | --- | --- | --- |
| `CROMBOLO_ALLOW_MEMBER_REGISTRATION` | `true` / `false` | `false` | Lets visitors register as members of the site. |
| `CROMBOLO_MEMBER_REGISTRATION_TYPE` | string | `Member` | The member type a registration creates, by alias. |
| `CROMBOLO_MEMBER_REGISTRATION_GROUPS` | list | — | The member groups a registration joins, separated by commas. |
| `CROMBOLO_MEMBER_SESSION_MINUTES` | number | `20160` | How long a member's sign-in lasts, in minutes. The default is 14 days. |
| `CROMBOLO_MAX_FAILED_PASSWORD_ATTEMPTS` | number | `5` | Failed member sign-ins before the member is locked out. `0` never locks out. |

### Public site

| Setting | Takes | Default | Description |
| --- | --- | --- | --- |
| `CROMBOLO_INDEXABLE` | `true` / `false` | `true` | Off keeps search engines out entirely, for a staging site: robots are refused, there is no sitemap and every page asks not to be indexed. |
| `CROMBOLO_SITEMAP` | `true` / `false` | `true` | Serves `/sitemap.xml`. |
| `CROMBOLO_TRACK_REDIRECTS` | `true` / `false` | `true` | Renaming or moving a page records a redirect from the address it had. |
| `CROMBOLO_DELIVERY_API` | `true` / `false` | `false` | Turns on the Delivery API, which serves content as JSON. |
| `CROMBOLO_DELIVERY_API_KEY` | string | — | The key that unlocks a private Delivery API, and previews of unpublished content. Kept secret: never printed. |
| `CROMBOLO_DELIVERY_API_PUBLIC` | `true` / `false` | `true` | Off, every Delivery API request needs the key. |
| `CROMBOLO_DELIVERY_API_MEDIA` | `true` / `false` | `false` | The Delivery API serves media as well as content. |

### Remote

| Setting | Takes | Default | Description |
| --- | --- | --- | --- |
| `CROMBOLO_REMOTE_ENABLED` | `true` / `false` | `false` | Lets `crombolo pull` and `crombolo push` reach this site. |
| `CROMBOLO_REMOTE_ENVIRONMENT` | string | `production` | The name this site goes by for pull and push: lower case letters, digits and dashes. |
| `CROMBOLO_REMOTE_PROTECTED` | `true` / `false` | `true` | A push here needs the protected-push permission. |
| `CROMBOLO_REMOTE_APPROVALS` | `true` / `false` | `false` | A push to a protected site waits for someone else to approve it. Needs `CROMBOLO_SECRET_KEY`. |
| `CROMBOLO_REMOTE_MAX_UPLOAD_GB` | number | `50` | The largest push or media file a client may upload, in gigabytes. Every other request keeps the usual body limit. |

### Logging

| Setting | Takes | Default | Description |
| --- | --- | --- | --- |
| `CROMBOLO_LOGS_DIR` | string | `logs` | Where log files are written, a file a day, read by the back office log viewer. |
| `CROMBOLO_LOG_LEVEL` | `trace`, `debug`, `info`, `warning`, `error`, `fatal` | `info` | The least severe level logged. |
| `CROMBOLO_LOG_TO_CONSOLE` | `true` / `false` | `true` | Log events are also printed to the console. |
| `CROMBOLO_TRACE_REQUESTS` | `true` / `false` | `false` | Prints a line on the console as each request arrives and as it is answered. |
| `CROMBOLO_HEAP_INTERVAL_SECONDS` | number | `0` | Every this many seconds, prints the memory in use and the requests in flight. `0` is off. |

### Command line

| Setting | Takes | Default | Description |
| --- | --- | --- | --- |
| `CROMBOLO_BOOT_ATTEMPTS` | number | `10` | How many times `crombolo start` tries to start the site, waiting longer each time, before it exits. Read by the command line. |
| `CROMBOLO_ACTOR` | string | the account running the command | Who the audit log records for a command, for a pipeline acting for someone. Read by the command line. |
| `CROMBOLO_BUNDLE_PASSPHRASE` | string | — | The passphrase for an encrypted content file, instead of being asked for it. Read by the command line. Kept secret: never printed. |
| `CROMBOLO_DEBUG` | `true` / `false` | `false` | Adds the stack trace to an unexpected error. Read by the command line. |
| `CROMBOLO_TEMPLATES_DIR` | string | the templates the command line ships | Where `crombolo init` finds its site templates, for trying a changed one. Read by the command line. |

### AWS credentials

| Setting | Takes | Default | Description |
| --- | --- | --- | --- |
| `AWS_REGION` | string | — | The AWS region, for SES e-mail and the Bedrock assistant when they set none. |
| `AWS_PROFILE` | string | — | The AWS profile the Bedrock assistant signs in with. |
| `AWS_ACCESS_KEY_ID` | string | — | A static AWS access key, for SES e-mail and the Bedrock assistant. |
| `AWS_SECRET_ACCESS_KEY` | string | — | That access key's secret. Kept secret: never printed. |
| `AWS_SESSION_TOKEN` | string | — | A session token, for temporary AWS credentials. Kept secret: never printed. |

<!-- settings:end -->

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

What needs it: inviting backoffice users, resetting a forgotten password,
Forms' Send email workflow, and notifications about page changes. Without a
provider those are **unavailable rather than failing**: the backoffice hides
Invite and offers Create (which shows a generated first password), the sign-in
screen drops "Forgotten password?", the Notifications dialog says the site
can't send e-mail and disables its choices, and `GET
/umbraco/crombolo/api/email` tells a signed-in client why. Subscriptions made
before stay, and start delivering once a provider is set; development sends to
the console, so notifications work there as invitations do. `crombolo status`
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
| `bun run docs:config`                                 | regenerate the environment variable tables in this page from the settings list (`packages/server/src/settings.ts`) |
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
