# Bunbraco

An Umbraco-based CMS with a Bun + TypeScript backend.

The editor experience _is_ Umbraco's: the real `@umbraco-cms/backoffice` SPA,
unmodified, talking to a Bun server that implements Umbraco 18's Management API
contract over an Umbraco-shaped relational model. SQLite by default, Postgres as
an option.

**Status: phases 0–5 complete; Phase 6 is planned as work packages
(`docs/07-roadmap.md`), WP-6.1 to 6.9 done.** The vertical slice works end to end:
sign in with OAuth 2.0 + PKCE, build a document type with tabs and properties,
write a template, create a page, publish it, and see it rendered at its URL — then
roll it back. **974 tests green on both SQLite and Postgres**, 28 browser tests
driving the real backoffice, and 459 of 513 API operations implemented — the rest
route and answer honestly rather than 404.
See [`docs/07-roadmap.md`](docs/07-roadmap.md) for what remains.

---

## What it is

| | |
| --- | --- |
| **The editor** | The real `@umbraco-cms/backoffice` SPA, vendored unmodified and served by Bun. Content, media, members, document and media types, templates, data types, dictionary, log viewer, users and permissions |
| **The API** | Umbraco 18's Management API, contract-first from the vendored `OpenApi.json` — a handler cannot drift from the contract without failing a test |
| **Templates** | `.tsx` rendered on the server by a JSX runtime, with typed `PageProps` generated from your schema. Editing one is picked up without a restart |
| **Schema as code** | Document and media types live as TOML in `schema/`, diffable and committable. The backoffice writes the files; `schema sync` applies them |
| **Upgrades** | A read-only check classifies every change, applies the additive part early, then cuts over. A node behind the current schema serves reads and refuses writes rather than corrupting anything |
| **Content transfer** | Promote content between environments as a reviewable bundle of JSON — no connection between environments, no credentials for one stored in another |
| **Storage** | SQLite by default, Postgres as an option. Media on the file system, S3 or Azure |
| **Also** | Redirects that follow a moved page, members and public access, hostname routing, an optional AI assistant, and git integration from the backoffice |

Built on Bun alone — no Node, no npm scripts, and **no .NET**.

---

## Getting started

### Prerequisites

|                                               |                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Bun** ≥ 1.3                                 | runs everything: the build, the scripts and the tests (built against 1.4.2)          |
| **Docker** with Compose v2                    | optional: where Postgres comes from, and how the containerised runs work             |
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

#### In containers instead

```bash
bun run docker:up            # Postgres and one CMS node, on the same port 8080
bun run docker:logs          # follow it, including the sign-in banner
bun run docker:down          # stop; docker:reset also discards the database
```

The same single node — site, backoffice and Management API in one process — on
Postgres rather than SQLite, with nothing to install but Docker. `docker:up` waits
for the health check, so when it returns the site is actually serving.

The admin password is fixed at `bunbraco-dev-password` here rather than generated,
so a watch reload neither changes it nor ends your session; set
`BUNBRACO_ADMIN_PASSWORD` to override. The repository is bind-mounted and the
server runs under `bun --watch`, so editing a file on the host — in `packages/**`
as much as in `apps/site` — reloads the server in the container.

**Only one of the two can run at a time**, since they share port 8080 — which is
the point: the backoffice is at one address either way. Whichever starts second
fails and says so.

#### On Postgres, without containers

```bash
bun run db:up                # just Postgres, on localhost:5433
```

Then point a host run at it with `BUNBRACO_DB=postgres` and
`BUNBRACO_POSTGRES_URL`. This is the same database the Postgres half of the test
suite uses — see [Running the tests](#running-the-tests).

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

### Running the tests

```bash
bun run check                 # Biome + tsc, the gate
bun run docker:test:sqlite    # the suite in a container
bun run docker:test:all       # both dialects, the real gate
```

The host twins (`bun run test`, `test:all`) run the same suites outside Docker.
Postgres tests skip themselves when no server is reachable, so a clone without
Docker is never blocked — but a skip is not a pass.
[`docs/08-testing.md`](docs/08-testing.md) has the layers, the containers and the
browser suite.

---

## Documentation

Design documents, in reading order:

| | |
| --- | --- |
| [00-overview](docs/00-overview.md) | what this is, the decisions behind it, and the non-goals |
| [01-architecture](docs/01-architecture.md) | repo layout, dependency rules, server composition, the toolchain |
| [02-data-model](docs/02-data-model.md) | the relational model, and why a node behind the schema may not write |
| [03-api-contract](docs/03-api-contract.md) | the vendored contract, and how a handler is held to it |
| [04-backoffice-hosting](docs/04-backoffice-hosting.md) | vendoring the SPA, the shells, the auth wire contract, de-branding |
| [05-rendering](docs/05-rendering.md) | the JSX runtime, the published cache, views, hostnames, cultures |
| [06-features](docs/06-features.md) | what is implemented, and what is out of scope |
| [07-roadmap](docs/07-roadmap.md) | the work packages, and where this is going |
| [08-testing](docs/08-testing.md) | the test layers, the containers, the browser suite |
| [09-schema-as-code](docs/09-schema-as-code.md) | the TOML format, sync, retirement, coherence across nodes |
| [10-packaging-and-upgrades](docs/10-packaging-and-upgrades.md) | environments, the upgrade process, releasing to npm |
| [11-assistant](docs/11-assistant.md) | the optional AI helper, its guardrails and its credentials |
| [12-schema-at-runtime](docs/12-schema-at-runtime.md) | the shared schema store, and importing at runtime |
| [13-content-transfer](docs/13-content-transfer.md) | the bundle format, and moving content between environments |
| [14-configuration](docs/14-configuration.md) | every environment variable, and every script |
| [15-operations](docs/15-operations.md) | media storage, redirects, git, security, members |

---

## Structure

```
bunbraco/
├── docs/                          # the detail: design documents, configuration, operations
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
├── compose.yaml                   # Postgres, one CMS node, and three test services behind a profile
├── LICENSE, NOTICE                # MIT, and the attribution for everything redistributed with it
└── tests/                         # the suite; tests/support/ holds the dialect harness and signed-in server
```

A site is three files plus its views and its schema: `bunbraco.config.ts`, a
three-line `server.ts`, `Views/*.tsx`, and `schema/*.toml`. Everything else — the composition root, the
migrations, the backoffice — arrives with `bun add bunbraco`. `apps/site` is
exactly that shape and nothing more; `bunbraco init` scaffolds the same.

---

## Reference implementation

Umbraco 18 at `release-18.2.0`. Two things make this tractable: the backoffice is
a standalone Lit SPA published to npm, and its API contract is a committed
artefact that the client's own HTTP layer is generated from. Neither is
.NET-specific.

`Umbraco.Web.UI.Client/mocks/` in the Umbraco repo is an MSW mock server covering
~45 endpoint groups — the best available reference for exact response shapes when
the OpenAPI schema is ambiguous.

---

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

The enterprise distribution — the container topology and the operations tooling
around it — is a separate, proprietary repository. It consumes these packages;
nothing in it is required to run bunbraco.
