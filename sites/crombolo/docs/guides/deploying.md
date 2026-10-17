---
title: Deploying
summary: Run a site in production on SQLite or Postgres, in a container or on a server, as one process or split in two, and upgrade it without taking it down.
order: 5
---

A crombolo site in production is the same Bun project you run locally, started with `crombolo start` and `NODE_ENV=production`.

## What production changes

Setting `NODE_ENV=production` turns off the conveniences that make sense only on your own machine:

| | Development | Production |
| --- | --- | --- |
| Administrator's password | generated and printed on every start | never reset; set once, or set up in the browser |
| Schema files | the back office writes them | read-only; changes arrive with a deploy |
| Schema changes | applied whenever a file changes | applied only when the version or revision goes up |
| Framework upgrades | applied at start-up | never automatic; run `crombolo upgrade` |
| E-mail with no provider | printed to the console | not sent, and shown as unavailable |

## Choosing a database

**SQLite** is a single file and needs no database server. It suits a site that runs as one process on one machine with a disk that lasts: a small server, or a container with a persistent volume. Backups before risky changes are taken for you, as a copy beside the file.

**Postgres** suits everything else: several processes behind a load balancer, containers that start afresh, a managed database you already run. It is also required to split a site into separate roles (below).

```sh
CROMBOLO_DB=postgres
CROMBOLO_POSTGRES_URL=postgres://crombolo:secret@db.internal:5432/my-site
CROMBOLO_PG_DUMP='pg_dump "$CROMBOLO_POSTGRES_URL" -f "/backups/$CROMBOLO_BACKUP_STAMP.sql"'
```

`CROMBOLO_PG_DUMP` is the command crombolo runs to back up the database before an upgrade, an import or a purge ([Operations](/docs/guides/operations/)).

## The settings a production site needs

```sh
NODE_ENV=production
CROMBOLO_APPLICATION_URL=https://www.example.com
CROMBOLO_SECRET_KEY=...                     # 32 or more characters, from your secret store
CROMBOLO_SETUP_CODE=...                     # or CROMBOLO_ADMIN_LOGIN and CROMBOLO_ADMIN_PASSWORD
CROMBOLO_SCHEMA_REVISION=$BUILD_NUMBER
```

Add the database settings above, an e-mail provider if you want invitations and password resets, and a media store if your disk does not last. [Configuration](/docs/guides/configuration/) explains each.

### The first administrator

A production site never prints a password. Choose one of these:

- **Set it from the pipeline** with `CROMBOLO_ADMIN_LOGIN` and `CROMBOLO_ADMIN_PASSWORD`. They are used only when the database is created.
- **Set it up in the browser.** Set `CROMBOLO_SETUP_CODE` to 16 or more characters only you know, and leave the password unset. The first visit to the back office opens **Set up your new site**, which asks for your details and the code. Setup happens once; remove the code afterwards.
- **Sign in only through an identity provider.** Set `CROMBOLO_API_CLIENT_ID` (starting `crombolo-back-office-`) and `CROMBOLO_API_CLIENT_SECRET`. The site creates an API client in the administrators group for your pipeline, and no password administrator.

### Media

By default uploads are stored in the site's `media/` folder. On a container whose disk is replaced on every deploy, or across several nodes, put media in a bucket instead:

```ts
import { defineConfig, s3MediaStore } from '@crombolo/crombolo'

export default defineConfig({
  mediaStore: s3MediaStore({ bucket: 'my-site-media', region: 'ap-southeast-2' }),
})
```

S3 and anything that speaks its API (Cloudflare R2, DigitalOcean Spaces, MinIO, Backblaze B2) work through `s3MediaStore`, and Azure Blob Storage through `azureMediaStore`. Both can also be chosen from the environment with `CROMBOLO_MEDIA_STORE`.

## Running in a container

There is nothing special about the container: it needs Bun, the site's files and its dependencies.

```dockerfile
FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
ENV NODE_ENV=production
EXPOSE 8080
CMD ["bun", "run", "start"]
```

On SQLite, mount a volume for the database file and for `media/`, and point `CROMBOLO_SQLITE_FILE` at it. Logs go to the console as well as to `logs/`, so your platform's log collection works as it is.

Point your load balancer's health check at `/health`. It answers 200 while the node can serve and 503 when it cannot, so traffic is kept away from a node that is starting, misconfigured or out of date.

### When the site cannot start

If the database is unreachable, an upgrade is waiting or `schema/` has an error, `crombolo start` keeps running rather than exiting at once. It serves a page saying what is wrong and which setting or command fixes it, answers 503 on `/health`, and retries with a growing delay. After `CROMBOLO_BOOT_ATTEMPTS` tries (10 by default) it exits with a non-zero code, so your platform's restart policy and alerts take over. A database that comes up late is picked up without a restart.

## Roles: one process or two

By default each process does everything. For a busier site you can split it into two kinds of process with `CROMBOLO_ROLE`:

| Role | Serves | Also |
| --- | --- | --- |
| `all` (default) | the public site, the back office and its API | everything below |
| `api` | the back office, its API, and preview | applies the schema, migrates the database, runs background jobs |
| `web` | the public site only | nothing else; refuses to start until an `api` node has migrated the database |

Run a few `web` processes for visitors and one or two `api` processes for editors, all on the same Postgres database. A publish on an `api` node reaches every `web` node within seconds.

On a site of several nodes, also set `CROMBOLO_RUNTIME_INSTALLS=false`, so bundles are added to `package.json` and deployed rather than installed on whichever node took the request.

## Deploying a schema change

A change to `schema/` deploys with your code. Each node applies it when it starts, under a lock, once the schema version or `CROMBOLO_SCHEMA_REVISION` has gone up. During a rolling deploy, nodes still on the old files keep serving pages and never write the old schema over the new one.

To apply the schema as a pipeline step instead, set `CROMBOLO_SYNC_SCHEMA_AT_BOOT=false` and run `crombolo types sync` before the new nodes start. [Schema as code](/docs/guides/schema-as-code/) has the detail.

## Upgrading crombolo

A production site never upgrades itself: a node started against a database with migrations waiting refuses to start, and says which command to run. An upgrade is check, fix, then upgrade, run with the **new** release's command line against the production database:

```sh
bun add @crombolo/crombolo@latest          # in the site, then build and deploy as usual
bunx crombolo upgrade check                # read-only: what the new release needs from your data
bunx crombolo upgrade check --fix          # back up, then apply what can be applied early
bunx crombolo upgrade                      # check again, back up, migrate and cut over
```

`upgrade check` lists anything that needs a person, such as a new mandatory field on existing pages, on the back office's **Changes** dashboard. Editors fill these in on the live site; `--set article.summary="To follow"` fills one value everywhere it is missing. `upgrade` refuses while anything is outstanding.

During the cut-over, readers are never interrupted. Old nodes keep serving pages but stop accepting saves. Those that serve editors report themselves unhealthy, so the load balancer sends editors to new nodes, while old `web` nodes stay in service until they are replaced. Start the new nodes, then stop the old ones.

```sh
bunx crombolo upgrade --plan               # the database changes a pending upgrade would make
bunx crombolo upgrade ledger               # every migration, schema sync and import applied here
```

A failed step is rolled back and named, and running `upgrade` again carries on from it. To roll back a release that converted data, restore the backup taken before it.

## Where next

- [Operations](/docs/guides/operations/): health, backups, pausing editing and rebuilding caches
- [The configuration reference](/docs/reference/configuration/): every setting
- [The operations commands](/docs/reference/command-line/operations/), with every flag
