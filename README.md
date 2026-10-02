# Bunbraco

An Umbraco-based CMS with a Bun + TypeScript backend.

The editor experience _is_ Umbraco's: the real `@umbraco-cms/backoffice` SPA,
unmodified, talking to a Bun server that implements Umbraco 18's Management API
contract over an Umbraco-shaped relational model. SQLite by default, Postgres as
an option.

**Status: phases 0–5 complete; Phase 6 is planned as work packages (`docs/07-roadmap.md`), WP-6.1 to 6.9 done.** The vertical slice works end to end: sign in with
OAuth 2.0 + PKCE, build a document type with tabs and properties, write a template,
create a page, publish it, and see it rendered at its URL — then roll it back.
**554 tests green on both SQLite and Postgres**, and 22 browser tests driving
the real backoffice; 459 of 513 API operations
implemented, the rest route and answer `501`.
See [`docs/07-roadmap.md`](docs/07-roadmap.md) for what remains.

---

## Getting started

### Prerequisites

|                                               |                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Bun** ≥ 1.3                                 | runs everything: the build, the scripts and the tests (built against 1.4.2)          |
| **Docker** with Compose v2                    | the default way to run the stack, and where Postgres comes from                      |
| An `Umbraco-CMS` checkout at `release-18.2.0` | optional — only to re-seed vendored static files when bumping the backoffice version |

There is deliberately **no Node, npm-script, or .NET/NuGet dependency** anywhere
in the build, test or run path.

Bun alone is enough to build the project and run the SQLite half of the suite, so a
clone without Docker is not stuck — but Postgres and the containerised test runs
both need it.

### Setup

```bash
bun install
bun run vendor:backoffice     # builds packages/backoffice-dist/dist (~90 MB, ~2s)
bun run generate:types        # contract types -> packages/contracts/generated/
bun run check                 # format + lint + typecheck
```

These run on the host even when you go on to run the stack in Docker: the
repository is bind-mounted into the container, so the vendored client and the
generated contract types are the same files either way.

`vendor:backoffice` assembles a browser-runnable backoffice from the pinned npm
package into `packages/backoffice-dist/dist`, then verifies that every one of its
~6,555 modules will actually link in a browser and fails if any will not. It is
required before the server can serve the editor, and the output is not committed
— see
[`docs/04-backoffice-hosting.md`](docs/04-backoffice-hosting.md) for why the npm
package alone is not loadable.

### Run it

```bash
bun run start:local          # runs `bunbraco start` in apps/site
```

One process on SQLite, on port 8080. It migrates and seeds the database, **resets
the administrator's password, and prints the credentials**:

```
┌─────────────────────────────────────────────────────┐
│ Bunbraco is running                                 │
│                                                     │
│   backoffice  http://localhost:8080/bunbraco        │
│   site        http://localhost:8080/                │
│                                                     │
│   Sign in with                                      │
│     username  admin@bunbraco.local                  │
│     password  23whoMrmWsZP3DF                       │
│                                                     │
│   A fresh password is generated on every start; set │
│   BUNBRACO_ADMIN_PASSWORD to keep one.              │
└─────────────────────────────────────────────────────┘
```

It resets the password on every start so that what it prints is always true, and
it clears any lockout. Changing the password ends existing sessions, so other tabs
are signed out. Set `BUNBRACO_ADMIN_PASSWORD` to keep a stable one:

```bash
BUNBRACO_ADMIN_PASSWORD=localdev123 bun run start:local
```

Use `bun run start:local:watch` to reload on change; it passes `--keep-admin`, so a
reload keeps the password and your sessions. A restart with an unchanged
`BUNBRACO_ADMIN_PASSWORD` keeps sessions too. Or use `bun run dev` for the
plain server with no password handling — that one prints a generated password only
on the run that _creates_ the database, and because seeding is idempotent it can
never print it again. If you have locked yourself out of an existing
`bunbraco.sqlite`, `bun run start:local` is the way back in.

A port already in use is reported before the database is touched, so nothing is
migrated or seeded on a run that cannot serve:

```
error: Port 8080 is already in use, so this server cannot start.
  The container stack publishes the same port — "bun run docker:down" stops it.
  Otherwise set PORT (or BUNBRACO_PORT for the stack) to something else.
```

Give it another port with `PORT=3000 bun run start:local`.

#### On Postgres instead

```bash
bun run db:up                # Postgres on localhost:5433, from compose.yaml
```

Then point the site at it with `BUNBRACO_DB=postgres` and
`BUNBRACO_POSTGRES_URL`. This is the same database the Postgres half of the test
suite uses — see [Running the tests](#running-the-tests).

#### Running a multi-node topology

A split deployment — an editor node, a pool of renderers and a load balancer in
front of them — is what `BUNBRACO_ROLE` exists for, and the CMS implements it
here. The containers that *compose* that topology are not in this repository:
they are part of the Kineco enterprise distribution. What this repo gives you is
the capability and its tests; see
[Splitting a deployment](#splitting-a-deployment) for what the roles mean and
what the nodes have to share.

### Start a site of your own

`apps/site` is this repository's reference site. A new one is three files plus its
views and its schema, and `bunbraco init` writes them:

```bash
mkdir my-site && cd my-site
bunx bunbraco init --name "My Site"     # add --postgres for a Postgres .env
bun install && bun start
```

That gives you a site with no content types, so the first thing it serves is a
holding page saying nothing is published yet, with a link to the backoffice. To
start from something instead, scaffold a **starter template**:

```bash
bunx bunbraco init --template list                   # what there is
bunx bunbraco init --template basic                  # a home page type, a view, one page
bunx bunbraco init --template demo/harbourstone      # a whole brochure site, content and all
```

A template brings `schema/`, `Views/`, a stylesheet, its images — and its content as
a **bundle**, the same artifact `bunbraco content export` writes. `init` puts it in
`bundles/` and wires the import into the scaffolded `start` script:

```json
"scripts": { "start": "bunbraco start --bundle bundles/demo-harbourstone --publish" }
```

`start --bundle <dir>` is not template-only: it applies any bundle before the site
serves anything, taking the flags `content import` takes. It imports **once per
bundle** — a run still standing here means this site already has that content, so
restarts cost a query and a line in the banner — and if the import is refused it
says why and does not start, rather than serving a site missing the content you
asked for.

The demo is a fictitious coastal distillery: a range with tasting-note elements, a
journal, media with crops, and a list view. Its content is regenerated, never
hand-edited, by `bun run build:template` — which builds a throwaway site from the
template's own schema files, creates the content through the repositories and
exports it, so the committed bundle is a real export.

### Walk the slice in the editor

Open the backoffice at `http://localhost:8080/bunbraco` and sign in.

1. **Settings → Templates → Create.** Name it `Home Page`. The editor opens with
   Umbraco's Razor starter; save it unchanged and it becomes a TSX view, written
   to `apps/site/Views/homePage.tsx`. Reopen it and give it something to render:

    ```tsx
    export default function HomePage({ model, nav }) {
        return (
            <html lang="en">
                <head>
                    <title>{model.text("title")}</title>
                </head>
                <body>
                    <h1>{model.text("title")}</h1>
                    <div
                        setInnerHTML={{
                            __html: model.text("bodyText"),
                            dangerously: true,
                        }}
                    />
                    <nav>
                        {nav.children(model).map((child) => (
                            <a href={child.url}>{child.name}</a>
                        ))}
                    </nav>
                </body>
            </html>
        );
    }
    ```

2. **Settings → Document Types → Create.** Alias `homePage`, tick _Allow as root_,
   add a `title` (Textstring) and a `bodyText` (Richtext editor) property, and set
   the template from step 1 as allowed and default.
3. **Content → Create → Home Page.** Name it `Home`, fill the fields, **Save**.
   Nothing is public yet: `http://localhost:8080/` returns 404.
4. **Publish.** `http://localhost:8080/` now renders your template: as in Umbraco,
   the first root page is the site root, and its children sit directly below it.
5. Edit and save again — the page shows _published with pending changes_, and the
   site still serves the published version, not your draft.
6. **Info → History** and roll back to restore the earlier values.

`model.text()` escapes. For markup there are two routes: `model.html('bodyText')`,
which is the short one and what a rich-text value usually wants, and the
`setInnerHTML` attribute above for markup from somewhere else. It takes React's
`{ __html }` shape plus a `dangerously` flag, and **without that flag the content is
escaped** — unlike React's `dangerouslySetInnerHTML`, where the only guard is the
name. Views are re-read per request in development, so editing a `.tsx` file and
refreshing is enough.

### Schema as code

Document, media and member types, data types and languages are files:
`schema/schema.toml` holds the version, `schema/document-types/*.toml`,
`schema/media-types/*.toml`, `schema/member-types/*.toml` and
`schema/data-types/*.toml` the definitions,
`schema/languages.toml` the cultures. Boot syncs them into the
database under a distributed lock, version-gated (`docs/09-schema-as-code.md`):

- **development** — files without keys get them written back on first sync; the
  directory is watched and re-synced on change; saving a document type in the
  backoffice writes its file; removing a property retires it and its values
  survive; removing a type with content refuses to boot.
- **production** — every element must carry a key, a change needs a version
  bump (or a newer `BUNBRACO_SCHEMA_REVISION`), and the backoffice editor
  answers 409 pointing at the file. A node whose files are older than the
  database runs in compatibility mode: reads only, writes refused with 409.

```bash
bunx bunbraco schema new document-type article --at-root   # the file, with keys, and its view
bunx bunbraco schema add-property article summary --type textarea --mandatory
bunx bunbraco schema check --static   # parse and validate, no database
bunx bunbraco schema check            # …and report what a sync would do
bunx bunbraco schema sync             # apply (a deploy step, or leave it to boot)
bunx bunbraco schema export           # database → canonical files (adopting an existing site)
bunx bunbraco generate                # schema/content-types.d.ts for typed views
```

`schema new` writes the type file — keys filled in, so it passes the production
rules — and the `Views/<alias>.tsx` it points at, then applies it. `--element`
writes a Library element type instead, which has no URL and so no view.
`add-property` appends one property and applies that; it re-emits the file
canonically, as `schema rewrite` does, so a comment in it is not kept and the
command says so. `--dry-run` prints the file instead of writing it.

### What an environment is

```bash
bunx bunbraco status          # and --json for a deploy step to assert on
```

```
  site       Harbourstone Distillery   /app
  database   postgres db:5432/bunbraco   reachable
  schema     files 1.1.0  database 1.1.0+4573   up to date
  framework  no migration pending
  content    11 document(s), 5 media, 9 element(s); last import 2026-10-01T06:24:14Z
  findings   0 blocking, 0 need a person, 25 automatic, 0 resolved
  versions   bunbraco 0.2.0, backoffice 18.2.0, bun 1.4.2
```

It exits non-zero when something would stop the site working — the database
unreachable, framework migrations pending, compatibility mode, or findings that
need a person — so a pipeline can use it as a gate. It opens the database rather
than bootstrapping it, and on SQLite will not even create the file: asking a
node what it is must never be the thing that changes it.

### Splitting a deployment

One process serves everything, which is every single-box site and all local
development. `BUNBRACO_ROLE` splits that process in two when you want the editor
off the public internet, or the renderer scaled on its own:

| Role | Serves | Owns |
| --- | --- | --- |
| `all` (the default for a process) | the public site, the backoffice, the Management API | the schema sync, `domains.toml` and redirect convergence, the background jobs |
| `api` | the backoffice and the Management API; renders **only** for preview | the same as `all` |
| `web` | the public site, media, assets, member sign-in | nothing — it neither migrates nor seeds |

Both halves still hold a database connection and stay coherent through
`cache_instruction`, exactly as a load-balanced set already does. What the split
buys is the editor on a private address and renderers you can add without adding
schema syncs; what it does not buy is a public box with no database credentials,
which would need the published cache served over HTTP instead.

Three consequences worth knowing before you reach for it:

- **It needs Postgres.** `packages/data/src/locks.ts` coordinates SQLite writers
  with an in-process queue, which two processes do not share. It is sound in
  practice only because a split puts every content write on the `api` node, and
  nothing enforces that.
- **The `api` node still renders.** Preview is rendering — the backoffice opens a
  site URL with a preview cookie — so the renderer has to be there. A public path
  without a preview session gets a bare 404, so traffic routed to the editing box
  by mistake is not a second copy of the site. If the two end up on different
  hostnames, the preview cookie and the backoffice session are cross-origin; that
  is not solved here.
- **The `web` node refuses to boot** against a database nothing has migrated, and
  resets no admin password on start. Start `api` first; in compose that is a
  `service_healthy` dependency.

The roles, the `cache_instruction` poll that keeps the nodes coherent, and the
write gate that makes a node behind the current schema read-only are all part of
this repository, and `tests/server-roles.test.ts` and
`tests/integration/server-roles.integration.ts` are what hold them honest — the
second runs two real processes against one database and watches a publish travel
between them.

**The containers that compose a split deployment are not here.** The editor and
renderer services, the pooled renderer, the nginx balancer in front of it and the
script that starts a given shape are part of the Kineco enterprise distribution,
which consumes this repo's published packages. If you are assembling your own
topology, what you need from this repository is `BUNBRACO_ROLE`, a shared
Postgres, a shared media store and a shared schema store — the next two sections
are the constraints that apply however you orchestrate it.

`bunbraco start` on your own machine is unaffected — it is one process on
`role: all`, and there is nothing about the split to know locally. The topology
is a property of the deployment, not of the toolchain.

#### What the nodes have to share

More than one node means every path that is written at runtime, or read after
someone else wrote it, has to be the same storage for all of them. There are two
kinds, and they want different answers:

| | Compose | Deployed |
| --- | --- | --- |
| **Media** — uploads and the resized-image cache under `.cache/` | the `cms_media` volume, mounted at `apps/site/media` on all three nodes | `BUNBRACO_MEDIA_STORE=s3` plus `BUNBRACO_MEDIA_S3_*`, or `azure` |
| **Code** — `Views/*.tsx`, `css/`, `scripts/`, `schema/*.toml` | the repository bind mount, which is already one shared source | a bucket mounted at those paths, or `schemaStore` for the schema |

Media is a **store**, not a path, and that is deliberate: the S3 store gives
presigned URLs, a public URL prefix and content types, which a filesystem view of
a bucket cannot. It is also why `cms_media` is a volume rather than part of the
bind mount — uploads are runtime data, `apps/site/media` is gitignored, and
without the volume every upload would land in your checkout.

Code is the opposite: `viewsDir`, `stylesheetsDir`, `scriptsDir` and `schemaDir`
are plain paths, so a mounted bucket needs nothing configured beyond the path.
Every write in the codebase is a whole-file `writeFile`, never a
write-then-rename, which is the pattern a FUSE layer over S3 handles best.

**`Views/` has one more condition, and it is easy to get wrong.** JSX compiles to
an import of `bunbraco/jsx-runtime`, which resolves by walking up from the file
that needs it. A view outside the site's tree therefore cannot load at all:

```
Cannot find package 'bunbraco' imported from /mnt/views/homePage.tsx
```

So mount the bucket **at** `<site>/Views` rather than somewhere else and pointing
`BUNBRACO_VIEWS_DIR` at it. `css/`, `scripts/` and `schema/` are data — served or
parsed, never imported — so they have no such constraint and may live anywhere.

Before relying on a mount at all: FUSE needs `SYS_ADMIN` and `/dev/fuse` in a
container, or a host mount bind-mounted in; Fargate cannot do it, and on EKS it is
the Mountpoint CSI driver. Mountpoint also caches file metadata briefly, so one
node's write is not instantly visible to another — which sets how quickly a
renderer notices a template that changed underneath it.

#### How a changed view reaches a running node

A view is a module, and `import()` caches modules in the runtime keyed on the
resolved path. There is no eviction; a cache-busting query works on Node but not
on Bun; and on every runtime the graph *beneath* a re-imported file stays pinned,
so re-reading `homePage.tsx` would still render the layout it first imported.
Sharing the files changes none of that — the node is not reading them any more.

Only a **new path** is read fresh. So each node renders from a content-addressed
copy of the tree:

```
<site>/.bunbraco/views/<hash>/homePage.tsx          ← imported
<site>/.bunbraco/views/<hash>/components/layout.tsx ← resolves inside the snapshot
```

The hash is of the whole tree, because a template's behaviour is its import
graph: `homePage.tsx` can be byte-identical while the layout it uses changed.
Structure is preserved, so a view's own relative imports resolve unchanged, and
no request can mix a new template with an old layout.

A node notices a change two ways. A template saved in the backoffice is snapshot
before the save returns, and announced to the other nodes as a `views` cache
instruction carrying the resulting hash. Anything else — a deploy, a bucket
synced underneath, a file written in the container — is caught by a periodic
re-hash on the render path, behind a TTL, single-flight, with the current
snapshot serving while it runs. One render after a change may still be the old
generation; the next is not.

Because the name is the content, nothing is wasted: an unchanged tree yields the
same hash, so no copy and no re-import, and reverting a change returns to a
generation already loaded. It also takes the mount off the request path entirely
— the bucket is read when the tree changes, never per render.

| Setting | Default | Development |
| --- | --- | --- |
| `BUNBRACO_VIEWS_CACHE_DIR` | `<site>/.bunbraco/views` | same |
| `BUNBRACO_VIEWS_GATE_MS` — how often a node looks | 5,000 | 500 |
| `BUNBRACO_VIEWS_SWAP_MS` — floor between generations | 10,000 | 0 |
| `BUNBRACO_VIEWS_GENERATION_LIMIT` | 250 | 250 |
| `BUNBRACO_VIEWS_KEEP` — generations left on disk | 3 | all, until boot |

Three things to know before changing them:

- **The cache directory must sit inside the site**, for the `jsx-runtime` reason
  above, and outside `Views/`, or it would snapshot itself. Both are refused at
  boot, and `bunbraco status` reports the same check so a deploy learns first.
- **It is per node, never shared.** A node clears the directory at boot, which
  would delete generations another node is serving. Compose gives each CMS
  service its own tmpfs.
- **Each generation stays in the runtime's registry until restart** — about 88 KB
  for a small tree. That is what the generation limit bounds: at the limit a node
  **freezes**, keeps serving the views it has, refuses newer ones and says so in
  its log and on `/health`. It stays `ok` deliberately: every node would freeze at
  once under the same runaway writer, and draining them all would turn a stale
  template into an outage. Restarting the node clears it.

Orchestrating the shapes is the enterprise distribution's job, and it has one
constraint worth repeating here: a compose service with no profile always starts,
so bringing up one shape without naming its services would start another
alongside it and the two would fight for port 8080.

### Views

A view is reached only through a document type's template alias, and it is
loaded when a request renders it — so a view that does not compile is a 500 that
waits for a visitor to find it. `views check` is that failure brought forward:

```bash
bunx bunbraco views check             # compile every view; report a template with no file
bunx bunbraco views list              # what is in Views/, and which type declares each
bunx bunbraco views new header --partial     # Views/Partials/header.tsx
bunx bunbraco assets list             # the stylesheets and scripts beside them
bunx bunbraco assets new stylesheet print.css
```

Every `.tsx` is transpiled and then imported, which is what a render does, so an
import that does not resolve is caught as well as a syntax error. Types need the
compiler: when the site has `typescript` installed — `bunbraco init` puts it in
`devDependencies` — it also runs `tsc --noEmit` over the site, and says so when
it cannot. Only the top level of `Views/` holds templates, so a shared component
belongs in a subdirectory, where the template scan never looks.

### Hostnames

Schema travels between environments; hostnames cannot, because they mean
something different in each one. A site may keep them in `domains.toml` beside
`bunbraco.config.ts`, with `${VAR}` read from the environment when it is
applied, so one committed file serves them all:

```toml
[[domain]]
node = "/"
host = "${SITE_HOST}"

[[domain]]
node = "/Home/French"
host = "fr.harbourstone.example"
culture = "fr-FR"
```

```bash
bunx bunbraco domains                 # what the file declares, and what is bound here
bunx bunbraco domains set / --host '${SITE_HOST}'      # writes the file, then applies it
bunx bunbraco domains set /Home/French --host fr.example=fr-FR
bunx bunbraco domains apply           # what a deploy step runs; what boot does
bunx bunbraco domains undo            # put back the file the last write replaced
```

The file is the truth: boot converges the `domain` table onto it, so deleting an
entry unbinds that hostname. A site with no `domains.toml` is left alone, and
the backoffice stays the only way — and on a site that has one, a save in the
backoffice writes the file too, so the next boot does not undo it.
`docs/05-rendering.md` has the routing rules.

### Upgrades

Framework releases and a site's own schema changes go through one process
(`docs/10-packaging-and-upgrades.md`): a read-only **check** that classifies
the change and lists what the data needs, a **fix** that applies the additive
part and every conversion early — under a state no live node reads — and an
**upgrade** that refuses over anything outstanding, runs the framework's
migrations, and cuts over. Findings land in the backoffice's **Changes**
dashboard (Settings), each linked to its page and grouped by where it came from
— a pending upgrade or an arriving content bundle; a server that has fallen
behind shows a read-only banner, answers 409 to writes and 503 on `/health`.

```bash
bunx bunbraco upgrade check                 # read-only: classification and findings, into the dashboard
bunx bunbraco upgrade check --fix           # backup; apply the additive part and conversions early
bunx bunbraco upgrade check --set article.summary="tbc"   # one value everywhere it is missing
bunx bunbraco upgrade                       # re-check, backup, framework steps, cut over, ledger
bunx bunbraco upgrade --plan                # the DDL pending framework migrations would run
bunx bunbraco upgrade ledger                # migration_history
bunx bunbraco schema purge --older-than 90  # delete long-retired properties and their values
```

Migration 020 renames API users' client IDs from `umbraco-back-office-<name>` to
`bunbraco-back-office-<name>`. Secrets are untouched, so an integration keeps
its secret and needs only its client ID updated — but it will get
`invalid_client` until it is. The backoffice's own `client_id` is unrelated and
unchanged; see `docs/04-backoffice-hosting.md`.

### Moving content between environments

A deploy promotes files, never content. Moving content is a separate, explicit
act producing a **bundle**: one JSON file per node plus a manifest, reviewable
in a diff, committable, and carrying no integer ids — only keys and aliases
(`docs/13-content-transfer.md`). There is no connection between environments and
no credentials for one stored in another; the bundle travels as a file does.

```bash
# where the content is
bunx bunbraco content export --root "/Campaigns/Autumn 2026" --out bundles/campaign-x
bunx bunbraco content export --root 9a1f3c2e-… --only --drafts --out bundles/one-page
bunx bunbraco content export --root "/Campaigns" --with-blobs --out bundles/campaign-x
                                      # …and the media bytes, so the bundle is self-contained

# where it is going: read-only, and non-zero while anything is outstanding
bunx bunbraco content check bundles/campaign-x
bunx bunbraco content check bundles/campaign-x --under "/Campaigns"
bunx bunbraco content check bundles/campaign-x --resolve-all take-bundle --save

# apply it: re-checks, backs up, then writes in one transaction
bunx bunbraco content import bundles/campaign-x
bunx bunbraco content import bundles/campaign-x --publish --label "autumn campaign"
bunx bunbraco content runs

# going live, separately from landing the content
bunx bunbraco content publish "/Campaigns/Autumn 2026" --descendants
bunx bunbraco content publish "/Campaigns/Autumn 2026" --at 2026-10-01T09:00
bunx bunbraco content unpublish "/Campaigns/Autumn 2026"

```

`--root` and `--under` both take a path by name or a uuid, and the resolved uuid
is what lands in the manifest, so the artifact is identity-stable either way. A
published node carries its **published** values — what the site actually serves —
and an unpublished one carries its draft and says so. Members never travel, nor
does anything true of exactly one environment: domains, users, tokens, sessions,
redirects, schedules or access rules.

`check` is the dry run, and it runs before every import too: nothing is written
until the conflicts have been named and answered. It sorts each one into
**blocking** (the destination cannot honour the bundle — deploy `schema/`, or
re-root it), **needs a person** (importable once somebody picks `take-bundle`,
`keep-local` or `skip`) or **automatic** (what will happen, said out loud).
`--save` commits the answers to `resolutions.json` beside the bundle, by node
key, so a decision made once promotes with it rather than being worked out again
in every environment. Findings land in the **Changes** dashboard under the
bundle's own scope, so two bundles in flight do not resolve each other's.

`import` re-runs the check inside the content-tree lock, backs up as `upgrade`
does, and then writes in **one transaction** — so a failure anywhere leaves
nothing behind. Documents and elements arrive as **drafts** for a person to
publish; media is live as soon as it lands. `--publish` publishes what the
bundle says was live at the source, parents first. Values are applied as an
**overlay**, so a bundle carrying `title` cannot empty `summary`, and importing
the same bundle twice writes nothing the second time.

Each run is recorded with, per node, the event it was at and the event it was
serving, so `content revert <run-id>` can put the site back: values restored,
the published state restored (a page that was live goes live again with the old
values; one that was a draft stays a draft), and nodes the run created
unpublished and moved to the recycle bin rather than deleted. It refuses to
discard an edit somebody made since, or to undo a run a later one built on,
until told to. The revert is itself a run, so it can be reverted in turn.

```bash
bunx bunbraco content runs
bunx bunbraco content revert 5192ca80-…
bunx bunbraco content revert 5192ca80-… --resolve-all discard   # over later edits

# the dictionary stays in the database, so it moves on its own
bunx bunbraco dictionary export --out dictionary.udt
bunx bunbraco dictionary import dictionary.udt
```

Site-authored value migrations live in `schema/migrations/*.ts`:

```ts
import { defineValueMigration } from "@bunbraco/schema";

export default defineValueMigration({
    from: { type: "article", property: "summary" },
    to: { property: "intro" },
    convert: (summary) => `Intro: ${String(summary)}`,
});
```

### Environment variables

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
| `BUNBRACO_VIEWS_CACHE_DIR`                  | `<site>/.bunbraco/views`                       | where views are snapshotted so an edit needs no restart; inside the site, outside `Views/`, per node     |
| `BUNBRACO_VIEWS_GATE_MS`                    | `5000`, `500` in development                   | how often a node looks for a changed views tree                                                          |
| `BUNBRACO_VIEWS_SWAP_MS`                    | `10000`, `0` in development                    | the floor between generations, which absorbs a flapping sync; an announced save is never delayed by it    |
| `BUNBRACO_VIEWS_GENERATION_LIMIT`           | `250`                                          | generations a node loads before it freezes, keeps serving and refuses newer ones                         |
| `BUNBRACO_VIEWS_KEEP`                       | `3`                                            | generations left on disk, for an instant return to one                                                   |
| `BUNBRACO_BACKOFFICE_PATH`                  | `/bunbraco`                                    | where the editor is mounted; the Management API stays at `/umbraco/management/api/v1`                  |
| `BUNBRACO_INSECURE_COOKIES`                 | `false`                                        | drops the `__Host-` prefix and `Secure`, for plain-http hosts that are not localhost                   |
| `BUNBRACO_SCHEMA_DIR`                       | `schema`                                       | where `*.toml` definitions live; sync is skipped when absent                                           |
| `BUNBRACO_SCHEMA_REVISION`                  | `0`                                            | set by the deploy; orders deploys within one schema version                                            |
| `BUNBRACO_NODE_ID`                          | `host:pid`                                     | this node's identity in `server` and on cache instructions                                             |
| `BUNBRACO_ROLE`                             | `all`                                          | `api` serves the editor and owns the boot's writes; `web` serves only the public site. See [Splitting a deployment](#splitting-a-deployment) |
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
| `BUNBRACO_MEDIA_STORE`                      | `filesystem`                                   | where media bytes live: `filesystem`, `s3` or `azure` (see [Media storage](#media-storage))            |
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

### Running the tests

Every test command comes in two forms: on the host, and the same suite inside a
container over the mounted source.

| On the host             | In Docker                      | Runs                                                                |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------- |
| `bun test`              | `bun run docker:test`          | the default dialect, SQLite                                         |
| `bun run test:sqlite`   | `bun run docker:test:sqlite`   | SQLite, pinned; starts no database                                  |
| `bun run test:postgres` | `bun run docker:test:postgres` | Postgres; brings the `db` container up itself                       |
| `bun run test:all`      | `bun run docker:test:all`      | both dialects in sequence — **the real gate**                       |
| `bun run test:browser`  | `bun run docker:test:browser`  | the Playwright suite; Chromium in the container, Chrome on the host |
| `bun run test:integration` | `bun run docker:test:integration` | the CLI end to end — creating a site, content transfer, a split deployment and the upgrade; `bun test` does not collect these |

Each container service takes a command override, so a single file is
`docker compose run --rm cms-test-sqlite bun test tests/redirects.test.ts`.

The host and container runs set identical environments, from one anchor in
`compose.yaml`, so they test the same thing. The container is slower — the source
is a bind mount, which costs roughly 50% on macOS — so the host commands are the
ones to use while working, and the Docker ones when you want to know it passes
somewhere other than your machine.

`test:ci` is the one command with no twin, on purpose: it exists so the CI workflow
can supply the dialect through job environment, and in a container the dialect *is*
the service you pick, so `docker:test:sqlite` and `docker:test:postgres` together
are that matrix.

The browser suite has its own image (`docker/Dockerfile.browser`): Playwright's
official image, which pins the browser system libraries to the Playwright version,
with Bun copied in to run the server under test. Its tag must track the
`@playwright/test` version, and `tests/docker.test.ts` fails if it drifts. It also
gets its own `node_modules` volume, because that image is Debian and the CMS image
is Alpine — one install cannot serve both. **One behaviour differs there**: the host
run drives installed Google Chrome (`channel: 'chrome'`), and the container cannot,
because Google publishes no Linux arm64 build of Chrome. The container sets
`BUNBRACO_BROWSER_CHANNEL=''` and gets Playwright's bundled Chromium instead.

The suite drops and recreates the `public` schema between servers, so it is given
a database of its own: the stack provisions `bunbraco` for the CMS and
`bunbraco_test` for the tests. The CMS container can stay up during a test run
without the two colliding. Don't run a host and a container Postgres suite at the
same time, though — they share that one database.

The Postgres runs use `--timeout 20000`. They are roughly four times slower than
SQLite's private in-memory databases and every test boots a server — migrations,
then a seed — so several sit at one to two seconds. Bun's 5s default leaves too
little headroom, and the heaviest tests time out when the host is busy rather than
when anything is wrong. The SQLite runs keep the default.

Both dialects are exercised from day one, and it has paid for itself: it caught
`SET search_path` not surviving Bun's connection pool, Postgres refusing to infer
a type for `? IS NULL`, and — the subtle one — Postgres normalising `uuid` values
to lowercase while SQLite stores them verbatim.

Individual Postgres tests **skip** rather than fail when no server is reachable,
so a clone without Docker can still run `bun test` and `test:sqlite` and is never
blocked. A skip is not a pass, though: `test:all` is the gate. To point at a
Postgres of your own instead, set `BUNBRACO_POSTGRES_URL` and run `bun test`
directly with `BUNBRACO_DB=postgres`.

### How the test containers work

`compose.yaml` holds Postgres and one service per test shape, and nothing else.
The multi-node topology that used to live here — the editor and renderer
services, the pooled renderer and the nginx balancer — belongs to the enterprise
distribution now; see [Splitting a deployment](#splitting-a-deployment).

The three test services sit behind the `test` profile, so `docker compose up`
never starts them; they run only when a `docker:test:*` script asks for one.
`cms-test-sqlite` is built from an anchor that carries the image and the mount but
no `depends_on`, so a SQLite run starts no Postgres at all — whereas `cms-test`
declares the database and `docker compose run` brings it up and waits for its
health check.

`db:up` deliberately does **not** tear anything down: `test:postgres` calls it,
and a test run is meant to leave anything else you have running alone. Postgres
is on `localhost:5433` rather than 5432, which is normally a local install, so the
stack stays clear of one.

Running a single Postgres test file, override the command **with the timeout**:

```sh
docker compose run --rm cms-test bun test --timeout 20000 tests/users.test.ts
```

`docker compose run` replaces the service's `command`, so omitting it silently
drops back to bun's 5s default — which most Postgres tests in this suite cannot
meet.

The teardown passes `--remove-orphans`, which also clears the one-off containers
`docker compose run` leaves behind when it is interrupted: every `docker:test:*`
script uses `run`, and a plain `down` does **not** remove those. A survivor keeps
its old environment, so it will happily answer `docker compose exec` and `logs`
with stale values long after the compose file changed. It names the `test` profile
for the same reason `down` needs one at all — `docker compose down` acts on the
**active profile selection only**.

The repository is **bind-mounted** at `/app` rather than copied into the image, so
an edit on the host is visible in the container, in `packages/**` as much as in
`apps/site`. The image itself holds only the Bun runtime and the entrypoint, so it
is rebuilt only when `docker/Dockerfile.cms` or the entrypoint changes.

`node_modules` is the exception: it is a named volume, not part of the mount,
because the host's install holds macOS binaries that cannot run in the container.
The first boot populates it with `bun install --frozen-lockfile`.

The browser suite has an image of its own, because it needs browsers and because
that image is Debian where the CMS image is Alpine — one install cannot serve
both, hence a second `node_modules` volume. Its Playwright tag must match the
`@playwright/test` the project installs, which `tests/docker.test.ts` asserts.

One thing worth knowing about `output/`: the test services put their views, media
and logs there, and `output/` is inside the mounted repository — so anything else
running under `bun --watch` against the same checkout sees every file a test run
writes as a source change. When the dev server and a suite shared a checkout this
way, the SQLite suite went from 140 seconds to **1,834**, and Postgres from five
minutes to **three and a half hours**, with tests failing on timeouts that had
nothing wrong with them. Worse, a timeout landing inside `resetPostgresSchema`
left the database with no `public` schema and every later file failed with `no
schema has been selected to create in`. The reset is one transaction now, so an
interrupted one rolls back instead of cascading.

---

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
| `bun run release:version <v>`                         | set one version across every published package, `bun.lock` and the `VERSION` constant; `--backoffice-dist <v>` bumps the vendored client instead              |
| `bun run release:dry-run`                             | pack every package and check the tarballs, publishing nothing                                                                                                 |
| `bun run release:publish`                             | pack and publish to npm; skips versions the registry already holds                                                                                            |

---

## Structure

```
bunbraco/
├── docs/                          # design documents (start at 00-overview.md)
├── packages/
│   ├── bunbraco/                  # ✅ the package a site installs: `bunbraco()`, the JSX runtime,
│   │                              #    and a `bunbraco` bin that delegates to cli/
│   ├── cli/                       # ✅ the command line, installable on its own;
│   │                              #    templates/ holds the starter sites `init --template` writes
│   ├── server/                    # ✅ the composition root: config, ports, adapters, createServer;
│   │                              #    background jobs, oEmbed, the event hubs, member sign-in and public access,
│   │                              #    the media store seam (file system, S3, Azure) and imaging
│   ├── core/                      # ✅ domain primitives — problem details, notifications, paging
│   ├── contracts/                 # ✅ OpenApi.json (vendored from Umbraco release-18.2.0) + generated types
│   ├── data/                      # ✅ dialect seam, drivers, migrations, repositories
│   ├── auth/                      # ✅ OAuth2 + PKCE, reference tokens, cookie redaction
│   ├── api-management/            # ✅ contract-first router, authorization, ports, handlers
│   ├── assistant/                 # ✅ optional AI helper: tool definitions, guardrails, changesets,
│   │                              #    the agent loop, the MCP server and the Bedrock provider
│   │                              #    (server/ also holds the optional schema store and git integration)
│   ├── backoffice-host/           # ✅ SPA shells, import map, static serving, graphics; plugin/ = the Changes dashboard, the banner,
│   │                              #    the template editor's TSX scaffold and layout, and the assistant drawer
│   │                              #    plugin/branding/ = theme, logos and the overrides that de-Umbraco the client;
│   │                              #    plugin/localizations/ is generated by `localizations:build`
│   ├── schema/                    # ✅ schema-as-code: TOML model, parser, validator, writer, sync, export, generate, check/fix/upgrade
│   ├── transfer/                  # ✅ content transfer: the bundle format, canonical writer, reader, exporter
│   ├── backoffice-dist/           # ✅ the built Umbraco backoffice; dist/ is generated, upstream-static/ is committed
│   └── render/                    # ✅ JSX→HTML runtime, published cache (one view per culture),
│                                  #    URL and hostname routing, language fallback, the dictionary,
│                                  #    value converters (pickers, links, blocks, media and crops)
├── apps/site/                     # the reference site: bunbraco.config.ts, server.ts, Views/, schema/
├── scripts/                       # vendoring, module-graph check, coverage, versioning and publishing
├── .github/workflows/             # ci.yml on every push to main; release.yml on a v* tag
├── docker/                        # Dockerfile.cms and .browser, the entrypoint, the Postgres init script
├── compose.yaml                   # Postgres, and the three test services behind a profile
├── LICENSE, NOTICE                # MIT, and the attribution for everything redistributed with it
└── tests/                         # the suite; tests/support/ holds the dialect harness and signed-in server
```

A site is three files plus its views and its schema: `bunbraco.config.ts`, a
three-line `server.ts`, `Views/*.tsx`, and `schema/*.toml`. Everything else — the composition root, the
migrations, the backoffice — arrives with `bun add bunbraco`. `apps/site` is
exactly that shape and nothing more; `bunbraco init` scaffolds the same.

### Dependency rules

- `core` depends on nothing but its own types — all business rules live here
- `data` implements `core`'s repository interfaces and is the only package that
  knows SQL exists
- `api-management` depends on `core`, never on `data`
- `assistant` depends on `contracts` for its tool surface and on nothing that can
  write: it is handed a function that issues Management API calls, so every read
  it makes is authorised as the signed-in user and it has no path of its own to
  the database
- `render` depends on `core` and a content source interface; it never queries drafts
- `transfer` depends on `core` and `data`, mirroring `schema`: it owns the bundle
  format and reads content through the repositories rather than any SQL of its own
- `auth` owns identity and tokens; the API packages receive a resolved principal
- `cli` depends on `server` for the site operations it drives and owns no rules of
  its own; `bunbraco` depends on `cli` only to expose the bin, so a site that
  never shells out still gets the same binary
- composition happens in `apps/site` and the CLI
- file I/O a save needs (placing uploads) reaches the repository as a
  _value intake_ the server supplies, so `data` stays free of the file system
- image processing adds no dependency: Bun's `Image` resizes and encodes, and
  crops and padding go through a small PNG codec in `server/imaging.ts`

### How the contract is enforced

Every route comes from `contracts/OpenApi.json`, so:

- a path not in the contract **cannot be served** — it 404s
- an operation in the contract with no handler answers **501**, and
  `bun run coverage:api` counts it
- `router.handle('GetNonsense', …)` **throws** — you cannot register an operation
  that is not in the contract, so handler drift fails loudly
- response bodies are typed as `ResponseOf<'OperationId'>` from the generated
  types, so drifting from the wire shape fails to compile
- **authentication is derived from the contract**: the document requires a
  back-office user globally and exactly 10 operations opt out with
  `security: []`, so a newly added endpoint is secured by default (plus the
  three password-reset operations Umbraco's `DenyLocalLoginIfConfigured`
  policy opens while local login is allowed)
- **authorization is one table** (`api-management/src/authorization.ts`),
  consulted on every call before its handler runs: the sections each area's
  controllers demand in Umbraco, then, for documents and media, the caller's
  start nodes and the permission verbs each operation needs on the nodes it
  names — calculated per node as Umbraco does, the nearest explicit setting
  replacing a group's defaults. A refusal is Umbraco's bare `403`. Rules about
  people (only admins touch admins; a non-admin hands out only groups and start
  nodes they hold) live with the users port

Two groups of endpoints the backoffice needs are _not_ in the contract, because
Umbraco excludes their controllers from the OpenAPI document: the security
endpoints (`…/security/back-office/token`, `authorize`, `login`, …) and the
branding graphics. Those are matched by path ahead of the contract router.

### Templates

A template is a `.tsx` file in the site's `Views/`, executed by Bun with
`jsxImportSource: "bunbraco"` (the `init` scaffold sets it). There is no virtual
DOM: the JSX runtime renders straight to an HTML string. A page names its layout in the file rather than the database — the same
choice Umbraco makes, which parses `Layout = "…"` back out of the Razor source:

```tsx
export const layout = 'siteLayout'
export default function ChildPage({ model, nav }) { … }
```

A layout receives the rendered page as `children`. Templates get `model` (an
Umbraco-shaped published-content object with `value()`/`text()`/`html()` and
ambient culture, `fallback: 'language'` following each language's fallback),
`nav` (parent/children/ancestors/root in the page's culture, kept out of the
model as Umbraco does), `culture` and `dictionary(key)` (a dictionary item in
the page's culture, then its fallback languages).

Partial views live in `Views/Partials/` as components a template imports and
renders (`<Breadcrumb model={model} nav={nav} />`). The Settings section edits
them, and stylesheets (`css/`) and scripts (`scripts/`), as files; a new partial
view starts from a TSX skeleton, and "from snippet" offers TSX versions of
Umbraco's snippets.

The editor reads TSX rather than Razor, and type-checks it against the site's
own types: `bunbraco`'s and the schema's generated `content-types.d.ts`, served
to monaco by `<backoffice>/bunbraco/api/editor-types`. So `model.` completes,
and a mistake is underlined in the editor rather than found on the next
`typecheck` — see `docs/04-backoffice-hosting.md`.

### Publishing

Storage follows Umbraco exactly: `content_version.current` marks the draft,
`document_version.published` marks the published version, and publishing is
_freeze the draft as published, then fork a new draft_. Saving a draft creates no
new version; only publishing does. Rollback copies an old version's values into
the current draft and never rewrites history. A publish beneath an unpublished
ancestor is refused rather than creating an unreachable route. A page that
varies by culture publishes culture by culture: each culture points at the
publish it went live with, so publishing Danish never publishes English's newer
draft, and every mandatory language must be published.

---

## Media storage

Where uploaded bytes live is one interface — `MediaStore` in
`packages/server/src/media-store.ts` — so a site can move its media library off
the local disk without anything above it changing. It has four verbs (`get`,
`put`, `delete`, `list`) plus an optional `publicUrl`, and that is all the media
library, the image processor and the temporary-upload flow use.

Three stores ship:

| Store                     | Helper                                       | Notes                                                                                                            |
| ------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **File system** (default) | `fileSystemMediaStore(dir)`                  | files under `mediaDir`, exactly where Umbraco puts them                                                          |
| **S3**                    | `s3MediaStore({ bucket, … })`                | via Bun's own S3 client — no dependency; works with AWS, Cloudflare R2, DigitalOcean Spaces, MinIO, Backblaze B2 |
| **Azure Blob Storage**    | `azureMediaStore({ account, container, … })` | the REST API with Shared Key or SAS auth — no SDK dependency                                                     |

A site picks one in `bunbraco.config.ts`:

```ts
import { defineConfig, s3MediaStore } from "bunbraco";

export default defineConfig({
    mediaStore: s3MediaStore({
        bucket: "my-site-media",
        region: "ap-southeast-2",
    }),
});
```

…or leaves it to the environment, which is what a container deployment wants:

```sh
BUNBRACO_MEDIA_STORE=s3
BUNBRACO_MEDIA_S3_BUCKET=my-site-media
BUNBRACO_MEDIA_S3_REGION=ap-southeast-2
# BUNBRACO_MEDIA_S3_ENDPOINT=…  for R2, Spaces or MinIO
# BUNBRACO_MEDIA_S3_PREFIX=uploads
# BUNBRACO_MEDIA_S3_PUBLIC_URL=https://cdn.example.com   redirect browsers to a CDN
# BUNBRACO_MEDIA_S3_PRESIGN_SECONDS=300                  or to a signed bucket URL
```

```sh
BUNBRACO_MEDIA_STORE=azure
BUNBRACO_MEDIA_AZURE_ACCOUNT=mysite
BUNBRACO_MEDIA_AZURE_CONTAINER=media
BUNBRACO_MEDIA_AZURE_KEY=…          # or BUNBRACO_MEDIA_AZURE_SAS=?sv=…
```

Credentials left unset fall back to whatever the underlying client would find
anyway, so a machine with an instance role needs none configured. An
unrecognised `BUNBRACO_MEDIA_STORE` degrades to the file system rather than
losing the media library.

Three things follow from the interface rather than from any one store:

- **Serving.** By default this server streams the bytes, which keeps a bucket
  private; it streams from the local file when the store has one, so a
  disk-backed site still gets `sendfile`. A store that returns a `publicUrl`
  gets browsers redirected to it instead.
- **Image variants.** Crops and resizes are cached _in the store_, under
  `.cache/`, keyed by the source's etag — so a replaced original invalidates its
  crops with nothing tracking that, and one node's work serves every node.
- **Temporary uploads.** These go to the store too, under `.temp/`, so a
  load-balanced set can place an upload a different node received.

Writing another store is implementing those four verbs;
`tests/media-store.test.ts` drives the whole media library against one backed by
a `Map`, which is the check that the seam is real.

---

## Redirects

A URL that has worked keeps working. Two things feed one table, `redirect_url`,
and one matching pass.

**The URL tracker.** Renaming or moving a published page records a 301 from the
URL it answered on, for the page and every published descendant, per culture —
Umbraco's behaviour, including the parts that are easy to get wrong: a recycle-bin
move records nothing (there is no new URL to point at), a rename that is reverted
removes the rule that would otherwise redirect the live URL to itself, and the 301
is sent uncacheable on purpose, because browsers cache them hard enough that a
rename-and-rename-back would otherwise stick for anyone who saw the first answer.
A tracked rule names the _document_, so two successive renames leave the oldest
URL pointing at where the page is now rather than chaining redirects. Set
`trackRedirects: false` to turn it off, as Umbraco's `DisableRedirectUrlTracking`
does.

One case goes further than Umbraco: **re-ordering root pages**. Under
`HideTopLevelNodeFromPath` the first root is `/` and the others are `/<segment>`,
so sorting the roots moves them — and Umbraco's tracker listens only to publish
and move, which leaves that one silent. Sorting is tracked here for the same reason
renaming is.

**Redirects in code.** A site declares its own with `redirect()`, which Umbraco
has no equivalent for — its answer is a rewrite rule in front of the site:

```ts
import { defineConfig, redirect } from 'bunbraco'

export default defineConfig({
  redirects: [
    redirect('/contact-us', '/contact'),
    redirect('/old-blog/*', '/news/$1'), //     a subtree; $1 is the tail
    redirect('/*', 'https://new.example.com/$1'), // the whole site
    redirect(/^\/product\/(\d+)$/, '/products/$1'), // captures substitute
    redirect('/docs/*', 'https://docs.example.com/$1', { status: 302 }),
    redirect('/legacy', { document: 'a3f1…' }), // follows the page's renames
  ],
})
```

A target may be a path, an absolute URL, or `{ document }` — a document key,
resolved when the request arrives, so the redirect follows the page when someone
later renames or moves it, and stops matching if the page is unpublished rather
than sending visitors to a dead URL.

Three consequences of how these are wired:

- **Page routing wins.** Redirects are matched only once route resolution has
  found nothing, so a rule can sit in config for years without ever hiding a live
  page. Declaring one for a URL that a page occupies is allowed and simply inert
  until the page goes.
- **The database follows the file.** Configured rules are synced into
  `redirect_url` at boot, so the backoffice lists everything in force in one
  place. They are marked as owned by the configuration and the API refuses to
  delete one (409) — the next boot would put it back.
- **Hostnames scope a tracked rule by document, not by name.** A rule recorded
  under a hostname stores the key of the document that hostname roots, so
  changing the hostname leaves every redirect below it working.

In the backoffice this is Umbraco's own **Redirect URL Management** dashboard in
the Content section, plus the redirects listed on each page's Info tab. The
tracker's on/off switch there is read-only, matching Umbraco, which deprecated
the endpoint in v17 and made it a no-op in favour of configuration.

## Schema in shared storage

By default `schema/` is a directory in the image, which is why `schemaWritable` is
off in production: a container's disk does not survive a redeploy, so a type
changed there would be silently reverted. That makes metadata a developer's job.

A **schema store** changes that. Point it at S3 or Azure and the schema lives
there instead:

```ts
export default defineConfig({
  schemaStore: s3SchemaStore({ bucket: 'my-site', region: 'ap-southeast-2' }),
})
```

The store is copied into `schemaCacheDir` at boot and everything downstream —
loading, validation, hashing, sync, the writer — carries on against files exactly
as before. `loadSchemaDirectory` is synchronous and used by the boot path, the
sync, the validator and the CLI; making it reach a network would have rippled
through all of it for no gain. The local copy is a cache, the store is the truth,
and "the files are the schema" stays literally true.

Configuring a store turns `schemaWritable` on, because that is what it is for: an
editor changes a document type on a deployed site, the canonical TOML is published
back, and the next node to boot has it. A store is any `MediaStore`, so the S3 and
Azure implementations serve both with nothing duplicated.

### Importing at runtime

Files are the source of truth, so a TOML changed by a commit, published by another
node, or written by the backoffice has to reach the database without a restart:

```
GET  <backoffice>/bunbraco/api/schema-import    what it would do, changing nothing
POST <backoffice>/bunbraco/api/schema-import    do it
```

Both re-materialise the store first. The GET runs the same check that gates an
upgrade and reports its classification; the POST applies it and refreshes this
node's state in place, so a node that has just imported its own change does not
then judge itself behind and drain.

Deliberately never automatic. Importing a half-finished schema underneath an
editor mid-save is worse than importing a minute later, so it runs when somebody
asks or when an operation needs it.

### The version moves by what the change costs

`compareStates` reads the schema version first, so it is how other nodes learn
they are behind, and a production sync refuses a changed hash at an unchanged
version — the guard that makes silent drift impossible. A change made through the
backoffice therefore has to move it, and how far is decided by the same check that
gates an upgrade:

| Classification | Version | Why |
| --- | --- | --- |
| `breaking` | **major** | a property's editor changed under live content: getting here converted data |
| `data-requiring` | minor | a newly mandatory property, or a migration to run |
| `additive` | minor | a new type or property |
| `none` | unchanged | nothing to apply |

Classification happens **before** the database is written, comparing the type as
it is against the type it is about to become. Afterwards there is nothing left to
compare, which is why the save path classifies first and saves second.

Removing a property is none of these: properties are *retired* rather than
deleted, and their values come back if the property does.

## Source control from the backoffice

Optional, like everything else here. Configured, an editor can see what the
repository is missing and send it, without ever meeting git:

```ts
export default defineConfig({
  git: { provider: gitHub({ repository: 'kineco-au/site', token: process.env.GITHUB_TOKEN }) },
})
```

```
GET  <backoffice>/bunbraco/api/git/status    where it would send
GET  <backoffice>/bunbraco/api/git/diff      what the repository is missing
POST <backoffice>/bunbraco/api/git/commit    send it
```

A pull request by default — a schema change arriving as a PR is reviewable, one
arriving on `main` is not; `pullRequest: false` commits straight to the branch.

Over GitHub's REST API rather than a `git` binary, because the CMS image has no
git and should not grow one, and a shallow clone per diff to compare a handful of
TOML files would be absurd. The commit is built the long way — blobs, a tree, a
commit, then moving a ref — so the whole change lands as one commit, which is what
a reviewer wants, and a partly-applied change is not a state that can happen.
`GitProvider` is the seam; GitHub is the implementation that ships.

## The assistant

An optional AI helper in the backoffice that can build pages, document types, data
types and templates — and cannot do anything else, cannot change anything on its
own, and cannot publish. Absent from the config it does not exist: no route, no
tools, no model client, no extension in the backoffice.

```ts
import { bedrock, defineConfig } from 'bunbraco'

export default defineConfig({
  assistant: {
    provider: bedrock({ model: 'apac.anthropic.claude-…', region: 'ap-southeast-2' }),
    mcp: true,
  },
})
```

Three properties of the codebase do the securing, so the feature adds very little
trust surface of its own:

- **The tool surface is the contract.** Tools come from the vendored
  `OpenApi.json`, so there is no shell tool, no file tool and no fetch tool —
  Umbraco's management contract has no such operation. `READABLE_AREAS` is an
  allowlist, and users, members and security are not in it.
- **Authorization is untouched.** Every call is re-issued through
  `ManagementApiRouter.dispatch()` carrying the signed-in user's own cookies, so
  the same section, start-node and permission checks apply. An editor whose start
  node is `/Products` cannot get the assistant near `/Settings`.
- **It has no mutating tool.** Two verbs exist: `query`, and `propose`. A proposal
  is a prepared Management API request recorded in a changeset; it touches nothing.

Publish, unpublish, delete, move, copy and sort are not proposable either — making
content live is a person's act, done in the normal UI. Approving a page proposal
saves a **draft**; you publish it yourself. Approving a template or a type takes
effect at once, because neither has a draft state, so the review shows a diff
first and the drawer says which of the two you are about to do. A proposal records
what the entity looked like when it was made and is refused if it moved since,
rather than overwriting whoever got there first.

Proposed TSX is scanned before you see it — imports limited to `bunbraco` and
files beside it, and no `Bun`, `process`, `fetch`, `eval`, `new Function` or
`node:` — because `render/renderer.ts` imports templates as real ES modules. The
assistant may deliberately write less than a person can. It is defence in depth
behind human approval, not a sandbox.

`mcp: true` serves the same tools at
`<backoffice>/bunbraco/api/assistant/mcp` over JSON-RPC, so Claude Code and Claude
Desktop drive the CMS through the identical definitions and the identical
approval model. MCP clients get `query` and `propose` and **not** apply: an agent
approving its own changeset would defeat the point of having one.

Bedrock is the shipped provider, via the `Converse` API.
`@aws-sdk/client-bedrock-runtime` is the one place this repository takes a
third-party runtime dependency, and it is here for credentials rather than for
signing: a developer's AWS access is an SSO profile, not a pair of long-lived keys,
and resolving one means the shared config file, `source_profile` chains, the SSO
token cache and its refresh. Resolving credentials alone costs 13 MB against the
full client's 14 MB, so the client comes too and the hand-rolled SigV4 goes with
it. `AssistantProvider` is still the seam, which is how the tests drive the whole
loop with no network.

### Credentials for local development

`AWS_PROFILE` and the standard chain, as for any other AWS tool. Put it in `.env`,
which is gitignored and which both Bun and Docker Compose read, so one file serves
a host run and the container stack:

```sh
BUNBRACO_ASSISTANT_MODEL=apac.anthropic.claude-…   # naming a model is what enables it
AWS_PROFILE=my-sso-profile
AWS_REGION=ap-southeast-2
```

Then `aws sso login --profile my-sso-profile` on the host, and `bun run db:up`
or `bun run start:local`. Static `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are
still read when there is no profile, and take precedence when both are set.

`apps/site/bunbraco.config.ts` builds the provider only when
`BUNBRACO_ASSISTANT_MODEL` is set, so AWS credentials you already have for
something else never quietly turn on an AI feature. It is the *site's* choice, not
the framework's: `BunbracoConfig.assistant` has no environment variable, because
enabling it takes a provider and a provider is code.

The container mounts `~/.aws` **read-only**, which is what makes `AWS_PROFILE` mean
anything inside it, SSO token cache included. Those tokens are short-lived and the
mount cannot write back, so `aws sso login` stays something you do on the host.

### Is it actually going to work?

Boot answers both halves of that, and says so in the log:

```
Assistant credentials resolved: apac.anthropic.claude-… in ap-southeast-2,
  using profile my-sso-profile, model reachable, expiring 2026-09-29T06:11:00Z
```

or, when they are not:

```
Assistant cannot reach its model: Token is expired. To refresh this SSO session
  run 'aws sso login' with the corresponding profile.
  Run `aws sso login --profile my-sso-profile`, or set AWS_ACCESS_KEY_ID …
```

The same answer is served at `<backoffice>/bunbraco/api/assistant/status` and shown
in the drawer when it opens, so an expired session is visible **before** you type a
request rather than as a failed message after it. A failure never stops the site
booting; the assistant is optional and the rest of the CMS is untouched.

The check has two halves because credentials resolving says nothing about whether
this account may invoke this model in this region. The deep half sends the smallest
real `Converse` there is — one word in, `maxTokens: 1` out — which is the only thing
that proves access has been granted and the model id is right for the region. It
runs at boot and on an explicit re-check, not on every read, and the result is
cached. An `AccessDeniedException` is reported as "grant this account access in the
Bedrock console", and a `ValidationException` as "most Anthropic models need an
inference profile id such as `apac.…` rather than a bare id" — which is the mistake
worth catching early.

To find out what a given account can actually use, list the inference profiles and
let the boot check judge them — a profile existing is not the same as access to it
having been granted:

```sh
aws bedrock list-inference-profiles --region ap-southeast-2 \
  --query 'inferenceProfileSummaries[].inferenceProfileId' --output text
```

A `au.…` or `apac.…` id keeps inference in that region; a `global.…` id may route
anywhere, which is a data-residency decision rather than a performance one.

Resolving credentials is bounded at ten seconds. The chain ends at the instance
metadata endpoint, which does not answer on a laptop or in a container without a
route to it, and is in no hurry to say so: an unresolvable profile took two and a
half minutes to fail in a container before the bound went in.

See [`docs/11-assistant.md`](docs/11-assistant.md).

## Members and public access

Members are content nodes with a sign-in facet: `node` + `content` +
`content_version` + a `member` row, so member types, properties and versioning
are machinery that already exists. The backoffice manages them through the
contract; the front end signs them in through four endpoints of ours, since
Umbraco has no fixed URLs for this (a site writes a surface controller):

|                                  |                                                     |
| -------------------------------- | --------------------------------------------------- |
| `POST /umbraco/members/login`    | `username`, `password`, `rememberMe?`, `returnUrl?` |
| `POST /umbraco/members/logout`   |                                                     |
| `POST /umbraco/members/register` | off unless `allowMemberRegistration`                |
| `GET /umbraco/members/current`   | the signed-in member, or `401`                      |

A form post is answered with a redirect, a JSON post with JSON, so the same
endpoint serves a plain `<form>` in a template and a `fetch` from the page. A
`returnUrl` must be a local path, which closes the open redirect a login form
would otherwise be.

A session is a signed ticket in a cookie — no server-side session table, so a
load-balanced set needs only the shared signing key (generated once into
`key_value`). The ticket carries the member's security stamp and it is checked on
every request, so changing a password or locking an account ends every session it
had, immediately.

Public access protects a branch by member group or by named member. As Umbraco
does, a protected page is **rewritten** to its login or error page rather than
redirected, so the visitor keeps the URL they asked for; the nearest protected
ancestor governs, and a login page inside the branch it protects still renders.
A template receives the member as a prop:

```tsx
export default function Page({ model, member }) {
    return member ? (
        <Article model={model} />
    ) : (
        <SignInForm returnUrl={model.url} />
    );
}
```

## Security

The posture is Umbraco's where the contract sets it, and stricter where the
contract says nothing. What is worth knowing as an operator:

| Area                    |                                                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backoffice sessions     | Reference tokens, stored hashed, in `__Host-` HttpOnly cookies; PKCE is mandatory; a reused refresh token or a replayed code ends the whole session                       |
| `returnUrl`             | Reduced to a local path by `localReturnUrl`, server-side and again in the login page — resolved against an origin, so `/\host` and a tab-smuggled `//host` are caught too |
| Lockout                 | Checked before the password, so a locked account cannot be used to confirm which guess was the real one                                                                   |
| Plugin routes           | The endpoints outside the contract answer to the same authority as the operations beside them: Settings for git, schema import and the upgrade findings                    |
| List views              | `collection/document/{id}` and `collection/media` need Read on the parent, so a start node bounds them as it bounds the tree                                               |
| Media                   | Content types come from the file name, never from the uploader's header; served with `nosniff` and `Content-Security-Policy: sandbox`, which denies script to SVG and HTML  |
| Member endpoints        | Cross-site form posts are refused via fetch metadata, since these act on a cookie and have no antiforgery token; registration uses the configured type and a password policy |
| Request bodies          | Capped at 32 MiB (`BUNBRACO_MAX_REQUEST_BODY_MB`) rather than Bun's 128 MB default                                                                                        |
| Assistant               | Read-and-propose only; the transcript a browser returns is capped before it is billed; provider configuration is shown to Settings holders only                            |
| Proposed templates      | Scanned for the globals and the roads to `eval` — `Function`, `.constructor`, `import.meta` — behind human approval, which is the real gate                               |

Two things follow Umbraco rather than improving on it, deliberately, and are
worth a decision per site:

- **Rich text is not sanitized.** Umbraco's default is `NoopHtmlSanitizer`, and
  `model.html('alias')` renders what an editor stored. A careless or compromised
  editor account is therefore a stored-XSS vector for visitors. Closing this
  properly means choosing a sanitizer, which is a dependency decision rather than
  a default we should pick for a site — link URLs are already scheme-checked, so
  `javascript:` from the link picker does not survive.
- **SVG and HTML may be uploaded** to the media library, as Umbraco's own
  disallow-list allows. The `sandbox` header above is what makes that safe to
  serve; a site wanting them refused outright should narrow the upload settings.

## Documents

|                                                                     |                                                                                                                                         |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [`00-overview.md`](docs/00-overview.md)                             | mission, decisions, non-goals, Umbraco→bunbraco glossary                                                                                |
| [`01-architecture.md`](docs/01-architecture.md)                     | module boundaries, server composition, cross-cutting infrastructure                                                                     |
| [`02-data-model.md`](docs/02-data-model.md)                         | schema, naming map, the versioning model, dialect strategy, migrations                                                                  |
| [`03-api-contract.md`](docs/03-api-contract.md)                     | routing, response conventions, the document payload, build order                                                                        |
| [`04-backoffice-hosting.md`](docs/04-backoffice-hosting.md)         | serving the SPA, import map, the auth contract, boot sequence                                                                           |
| [`05-rendering.md`](docs/05-rendering.md)                           | TSX templates, the published-content model, URL routing                                                                                 |
| [`06-features.md`](docs/06-features.md)                             | must-have / could-have / out-of-scope inventory                                                                                         |
| [`07-roadmap.md`](docs/07-roadmap.md)                               | phases with exit criteria, and the risk register                                                                                        |
| [`08-testing.md`](docs/08-testing.md)                               | test strategy and what Phase 0 covers                                                                                                   |
| [`09-schema-as-code.md`](docs/09-schema-as-code.md)                 | document types, data types and languages as TOML files; sync; the backoffice writes them                                                |
| [`10-packaging-and-upgrades.md`](docs/10-packaging-and-upgrades.md) | how a site consumes the framework; migration ledger, `--plan`, expand/contract; the pre-upgrade check and `--fix` that gate the upgrade |
| [`11-assistant.md`](docs/11-assistant.md)                           | the optional AI helper: why the boundary is real, query and propose, approval and staleness, TSX guardrails, MCP, providers                |
| [`12-schema-at-runtime.md`](docs/12-schema-at-runtime.md)           | the shared schema store, importing files at runtime, how the version moves with the change, and getting it back into git                   |
| [`13-content-transfer.md`](docs/13-content-transfer.md)             | moving content between environments: the bundle format, what travels and what never does, dependency classification, naming a node         |

## Toolchain

| Tool                   | Version  | Why                                                                                                                                                                             |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bun**                | ≥ 1.3    | runtime, test runner, bundler and package manager — the whole build; built and tested against 1.4.2                                                                             |
| **TypeScript**         | ^7.0     | typecheck only (`tsc --noEmit`)                                                                                                                                                 |
| **Biome**              | ^2.5     | format and lint, one tool, one config                                                                                                                                           |
| **openapi-typescript** | **^6.7** | generates `contracts/generated/` from the vendored contract — see below                                                                                                         |
| **LogTape**            | ^2.3     | the server's logging: message templates with properties, as Serilog's, written as Serilog's compact JSON for the log viewer — zero dependencies of its own                      |
| **Docker Compose**     | v2       | supplies Postgres for the test suite, runs the stack and the test suites in containers — `oven/bun:1-alpine`, `postgres:18-alpine` and Playwright's image for the browser suite |

Docker is optional: it supplies Postgres for the test suite and can run the stack,
but `bun test` against SQLite needs nothing but Bun. Nothing in the build, test or
run path needs Node, npm scripts, or .NET/NuGet.

### Why openapi-typescript is held at v6

TypeScript 7 is the native port, and its package no longer exposes the JavaScript
compiler API:

```js
// typescript@7.0.2 package.json
"exports": { ".": "./lib/version.cjs", "./unstable/ast": …, … }
```

The main entry now provides `version` and `versionMajorMinor` and nothing else, so
any tool reaching for `ts.factory` fails. `openapi-typescript@7` builds its output
as a TypeScript AST and dies with `Cannot read properties of undefined (reading
'createKeywordTypeNode')`.

**v6 emits strings and has no `typescript` dependency at all**, so TypeScript's
version is irrelevant to it. The output shape is compatible with everything
`packages/contracts/src/types.ts` consumes — `responses[200].content['application/json']`
is identical between the two majors — and generation takes ~50 ms.

The trade-off is that v6 is superseded. Its output omits the `parameters` and
`requestBody` placeholder members v7 emits for operations that have none, which is
harmless for `ResponseOf`/`RequestOf`/`ParamsOf` today but is the thing to check
first if a future need seems to hit a gap. The alternative, when it matters, is a
small emitter of our own rather than reintroducing a second TypeScript.

## Releasing to npm

The workspace publishes as **one fixed-version set**: thirteen packages, one
version, released together. `bunbraco` is the only package a site installs; the
`@bunbraco/*` packages are its dependencies, pinned to the exact same version.
`@bunbraco/cli` is the one worth installing alone — on a machine that runs
commands against a site rather than serving it.
Independent semver was rejected because none of these packages is independently
useful — `@bunbraco/data` means nothing without `core`'s entity shapes — so a
version matrix would buy flexibility nobody wants.

`@bunbraco/backoffice-dist` is the exception. It is 84 MB of built client, it only
changes when the pinned Umbraco version does, and its **major and minor track the
`@umbraco-cms/backoffice` release it vendors** while the patch is ours. So
`18.2.0` says the thing that actually matters about it, and a bunbraco patch
release does not drag 84 MB along.

Packages ship **TypeScript source**, not compiled JS: `exports` points straight at
`src/index.ts`. Bun runs it, types come free, and there is no build step, no dual
ESM/CJS and no sourcemaps. The cost is that bunbraco is Bun-only — `engines.bun`
says so — and a consumer's `tsc` typechecks our source rather than declarations.

Runtime dependencies are `@logtape/logtape`, and the AWS SDK behind
`@bunbraco/assistant` — which a site installs only if it depends on that package,
since the umbrella re-exports `bedrock()` but nothing else reaches for it. The
thirty browser packages in the root manifest (tiptap, monaco, lit, the Umbraco
client) are build-time only: `vendor:backoffice` bundles them into
`backoffice-dist`, so a site never installs them.

### Cutting a release

```sh
bun run release:version 0.2.0   # manifests, bun.lock and the VERSION constant
bun run check && bun run test:all
bun run release:dry-run         # pack and verify, publish nothing
git commit -am "release 0.2.0" && git tag v0.2.0 && git push --follow-tags
```

The tag is what publishes. `release.yml` runs the whole of `ci.yml` first, checks
the tag matches `packages/bunbraco/package.json`, then runs `release:publish`,
which packs with Bun — that is what substitutes `workspace:*` for a real version —
and uploads each tarball with npm, which signs provenance from the workflow's
OIDC identity. It needs an `NPM_TOKEN` secret with publish rights to the
`@bunbraco` scope.

A version the registry already holds is skipped rather than failing the run, so a
tag that only moves some packages is safe to push — which is exactly what happens
when `backoffice-dist` stays put.

Two traps the tooling closes, both of which publish a broken package silently:

- **`bun.lock` records each workspace package's version**, and `bun install` will
  not refresh it — not even with `--force`. Since `bun pm pack` resolves
  `workspace:*` from the lockfile, a manifest bump without a lockfile bump
  publishes packages pinned to a version nobody released.
  `release:version` updates both, `tests/packaging.test.ts` asserts they agree,
  and `release:publish` re-reads every packed manifest before uploading it.
- **Two artefacts are generated and git-ignored** — `packages/contracts/generated/`
  and `packages/backoffice-dist/dist/`. `release:publish` refuses to start unless
  both are present.

### Continuous integration

`ci.yml` runs on every push to `main`, on pull requests, and as a called workflow
from `release.yml`, so a release runs exactly the build that guards `main`:

| Job       | Does                                                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `check`   | Biome + `tsc --noEmit`, after generating the contract types                                                            |
| `test`    | the full suite twice over, once per dialect, Postgres in a service container                                           |
| `client`  | builds the 84 MB client (cached), runs `check:modules`; the test jobs restore it, since about twenty tests skip without it |
| `integration` | the CLI end to end: creating a site, content transfer, a split deployment and the upgrade. Not gated — it takes seconds                                 |
| `browser` | the Playwright suite — opt-in on `main`, always on a tag (see below)                                                   |

The browser suite is the one job that does not run every time. It takes ~7 minutes
at one worker and is the most sensitive to a busy runner, so on `main` it runs only
when the commit message contains **`--browser-tests`**, and on a **tag push it always
runs** — `release.yml` calls `ci.yml` with `browser_tests: true`, so nothing is
published without it. Pull requests never run it.

It installs Chromium onto the runner rather than running inside Playwright's image,
because every other piece of that job is one the jobs above already prove works.
Chromium rather than Chrome means a CI failure reproduces anywhere with
`bun run docker:test:browser`, Apple silicon included, where Chrome has no Linux
build to install. The config retries twice on CI only — a flake on a laptop is still
a flake worth chasing — and the HTML report and traces are uploaded as artefacts on
failure, without which a CI-only failure cannot be diagnosed.

## Where this is going

Three decisions taken after Phase 4 reshape the project, and they are designed
before any more code lands:

- **Schema is code.** Document types, data types and languages live in
  `schema/*.toml` in the site's repo; the database caches them. The backoffice
  type editor writes the files. Comments are stripped on write; `description` and
  `notes` fields survive instead.
- **A site installs `bunbraco`.** Done in 5a: the composition root lives in
  `@bunbraco/server`, the built backoffice in `@bunbraco/backoffice-dist`, every
  package declares its dependencies and an `exports` map, and there are no
  tsconfig `paths` anywhere. A directory outside this repo with `bun add
bunbraco`, a config file and a three-line `server.ts` boots the backoffice and
  renders a page.
- **Metadata promotes through environments the way code does.** A schema
  change moves dev → test → production as files; when it needs data moved, a
  value migration in `schema/migrations/` is written once and runs in every
  environment against that environment's content. Removing a property never
  deletes its data — it is retired, and reintroducing the field brings the
  values back. A framework upgrade is the same process with one more source of
  change.
- **Changes are proven and prepared before they run.** Schema migrations are
  expand/contract with a ledger and a `--plan`. `bunbraco upgrade check` reports
  what a release needs from the data — auto-fixable, needs a person, or blocking
  — and `check --fix` applies the additive part on the live site, so a new
  required field appears in the backoffice to be filled in before the deploy.
  `bunbraco upgrade` refuses until the check is clean. Values are append-only
  and tagged with the schema state that wrote them, and only a node at the
  current state may write — so old nodes keep serving reads through a rolling
  deploy and there is never a maintenance page. Production never auto-upgrades.

Details in `docs/09` and `docs/10`; the plan is Phase 5 in `docs/07-roadmap.md`.

What is **not** built yet is listed and ranked in
[`docs/07-roadmap.md`](docs/07-roadmap.md#what-is-still-missing-ordered), measured
rather than remembered: `bun run coverage:api` reports the contract side
(`docs/api-coverage.md`), and the same section names the things the contract does
not cover — e-mail, search over property values, the Delivery API, external
identity providers — along with the divergences that are deliberate rather than
missing.

## Reference implementation

Umbraco 18 at `release-18.2.0`. Two things make this tractable: the backoffice is
a standalone Lit SPA published to npm, and its API contract is a committed
artefact that the client's own HTTP layer is generated from. Neither is
.NET-specific.

`Umbraco.Web.UI.Client/mocks/` in the Umbraco repo is an MSW mock server covering
~45 endpoint groups — the best available reference for exact response shapes when
the OpenAPI schema is ambiguous.

## Licence

bunbraco is MIT licensed — see `LICENSE`.

Umbraco CMS is MIT licensed too. Three things here are redistributed rather than
merely depended on, and `NOTICE` covers all three:

- `packages/backoffice-dist/dist/` is built from the MIT-licensed
  `@umbraco-cms/backoffice` npm package, and bundles the browser packages the
  client needs — monaco, tiptap, lit, rxjs and the rest, all permissively
  licensed
- `packages/backoffice-dist/upstream-static/` holds three CSS files copied
  unmodified from the Umbraco CMS repository
- `packages/contracts/OpenApi.json` is the Umbraco Management API document, copied
  unmodified from `release-18.2.0`

`NOTICE` ships inside every published package, because `bunbraco` is what a site
installs and what a downstream redistributor reads. `tests/packaging.test.ts`
asserts that each manifest lists it, since npm adds `LICENSE` automatically but
not `NOTICE`.

**No Umbraco trademark is redistributed.** MIT grants copyright permission and
says nothing about trademarks, so the Umbraco wordmark, the "U" roundel favicon
and the installer illustration are deliberately not in this repository.
`BRANDED_ASSETS` in `@bunbraco/backoffice-host` serves bunbraco's own marks at
those paths instead, and `tests/backoffice-host.test.ts` asserts that none of the
three resolves to a vendored file.

bunbraco is an independent project. It is not affiliated with, endorsed by, or
sponsored by Umbraco A/S, which owns the Umbraco trademark.

The enterprise distribution — the container topology, the renderer pool and the
operations tooling — is a separate, proprietary repository. It consumes these
packages; nothing in it is required to run bunbraco.
