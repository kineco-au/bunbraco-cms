# Bunbraco

A content management system for [Bun](https://bun.sh). Pages are **React-style
components** in `.tsx` files, rendered on the server. The content model lives in
your repository as files. The site, the editing UI and the API are one Bun process
on SQLite or Postgres.

```tsx
import type { PageProps } from 'bunbraco'
import { Layout } from './components/layout.tsx'

export default function Article({ model, nav }: PageProps) {
  return (
    <Layout model={model} nav={nav}>
      <h1>{model.text('title')}</h1>
      <div className="prose">{model.html('bodyText')}</div>
      <ul>
        {nav.children(model).map((child) => (
          <li>
            <a href={child.url}>{child.name}</a>
          </li>
        ))}
      </ul>
    </Layout>
  )
}
```

That file is a template. An editor creates a page of that type in the backoffice,
publishes it, and the component renders it at the page's URL.

---

## What it is

A full CMS, not a headless content store with a rendering problem left over:

- **For editors**, a complete backoffice: a content tree, drafts and publishing,
  version history and rollback, media with crops, block editors, languages and
  variants, members, users and permissions. The editing UI is the open-source
  Umbraco backoffice, served by Bunbraco
- **For developers**, a site is a small Bun project: `Views/*.tsx` for templates,
  `schema/*.toml` for document types, a config file and a three-line `server.ts`.
  Everything else arrives with `bun add bunbraco`

### Templates are React components, without React

A template is a function from props to JSX, exactly as you would write it for
React: components, props, `children`, fragments, `.map()` over a list, TypeScript
throughout. Shared markup is an ordinary component in an ordinary import.

What differs is what happens to the JSX. It compiles against Bunbraco's own JSX
runtime and comes out as an HTML string — there is **no React dependency, no
virtual DOM and no hydration**, so nothing is shipped to the browser unless you
add a script yourself. The practical consequences:

- components are plain functions called once per request, so there are no hooks,
  state or effects
- `className` and `htmlFor` work, and so do plain `class` and `for`
- `model.text()` escapes, `model.html()` emits a rich-text value as markup, and
  `setInnerHTML` stands in for `dangerouslySetInnerHTML` — it escapes unless you
  also pass `dangerously: true`

[`docs/05-rendering.md`](docs/05-rendering.md) has the model API, layouts,
partials and routing.

---

## Why use it

- **Templates in the language your team already writes.** No Razor, Liquid or
  Twig to learn: a view is TSX, type-checked, and composed from components
- **Fast pages by default.** Server-rendered HTML from a published cache, with no
  client bundle and no hydration step
- **Schema as code.** Document and media types are TOML files in `schema/`,
  diffable and reviewed in a pull request. The backoffice type editor writes the
  same files, and `bunbraco generate` turns them into a TypeScript interface per
  document type
- **One runtime, one process.** Bun runs the server, the build and the tests. No
  Node, no .NET, and with SQLite no database server either — `bunx bunbraco init`
  to a running site is three commands
- **A mature editing experience from day one.** Editors get a backoffice that has
  years of real use behind it, rather than a new admin UI
- **Upgrades that do not need a maintenance page.** A read-only check classifies
  every change, the additive part is applied early, and a node behind the current
  schema serves reads and refuses writes rather than corrupting anything
- **Content promotion as files.** Move content between environments as a
  reviewable bundle of JSON, with no connection between environments and no
  credentials for one stored in another

It is a poor fit if you need Umbraco packages or plugins (they do not run here),
Razor views, SQL Server, or client-side React with hydration out of the box.

Bunbraco is in active development. What is built and what is not is tracked in
the [roadmap](docs/07-roadmap.md).

### What is in the box

| | |
| --- | --- |
| **Templates** | React-style `.tsx` components rendered on the server, with layouts and partials. Editing one is picked up without a restart |
| **The editor** | The `@umbraco-cms/backoffice` SPA, vendored unmodified and served by Bun: content, media, members, document and media types, templates, data types, dictionary, log viewer, users and permissions |
| **The API** | The Management API the backoffice speaks, built contract-first from its OpenAPI document — a handler cannot drift from the contract without failing a test |
| **Schema as code** | Document and media types as TOML in `schema/`. The backoffice writes the files; `schema sync` applies them |
| **Upgrades** | Check, fix, then cut over, with old nodes serving reads throughout a rolling deploy |
| **Content transfer** | Export, check and import content between environments as a bundle of files |
| **Bundles** | Build a bundle from a slice of the site — schema, views, content and media — and install it into another with `bundle install`. Installable bundles are npm dependencies in the site's `package.json`, published under the `bunbraco-bundle` keyword. A bundle may also carry server endpoints, which run only once the site imports it into `bunbraco.config.ts` |
| **Storage** | SQLite by default, Postgres as an option. Media on the file system, S3 or Azure |
| **Forms** | Form building in core, not an add-on: definitions as TOML in `schema/forms/`, a Forms section with a designer and an entries view, rendering and submission with no JavaScript required, and workflows on a retrying queue |
| **E-mail** | Opt-in, over a provider's HTTPS API — Resend, Postmark, Amazon SES, or an endpoint of your own. Off by default, and what needs it says so rather than failing |
| **Umbraco import** | A compatibility report for an existing Umbraco site, then its content types, content and media converted into a new site |
| **Also** | Redirects that follow a moved page — and a Settings screen to manage them, as a bundle — members and public access, hostname routing, an optional AI assistant, and git integration from the backoffice |

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
bun run hooks:install         # pre-push hook: the same gate, before you push
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

### Bring an existing Umbraco site

An Umbraco 15 or later site can be imported from a backup: its database as a
`.bacpac` (or Umbraco's own SQLite file), and its files if you have them.

```bash
bun add -d bunbraco @bunbraco/import-umbraco     # the importer is opt-in
bunx bunbraco import umbraco report site.bacpac --site ./site-files
bunx bunbraco import umbraco apply  site.bacpac --site ./site-files --out my-site
cd my-site && bun install && bun start
```

`report` is read-only, and is the thing to run first: it says what will come
across and what will not. Content types, data types, content, media and
languages migrate. Packages, plugins and custom C# do not, and are listed by
name. Every Razor template becomes a TSX stub that renders the page's name, with
the original kept beside the report for whoever rewrites it.

`apply` writes a site directory, not a database: schema files, the view stubs,
the media, and the content as a bundle that `bun start` imports on the first
boot. Members, users, redirects and protected pages are counted in the report
and not imported yet. [`docs/16-umbraco-import.md`](docs/16-umbraco-import.md)
has the detail and what is left.

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

The view is a React-style component, with the differences listed under
[Templates are React components, without React](#templates-are-react-components-without-react):
`model.text()` escapes, `model.html('bodyText')` is the short route for a rich-text
value, and `setInnerHTML` above is for markup from somewhere else — **without its
`dangerously` flag the content is escaped**. Views are re-read per request in
development, so editing a `.tsx` file and refreshing is enough.

### Running the tests

```bash
bun run check                 # Biome + tsc, the gate
bun run docker:test:sqlite    # the suite in a container
bun run docker:test:all       # both dialects, the real gate
```

`bun run hooks:install` points git at `.githooks`, whose `pre-push` runs the host
gate — contract types, `check`, then the SQLite suite — so a push that would fail
CI's first two jobs fails locally instead. It skips Postgres and the browser suite
because both need Docker; `git push --no-verify` skips the hook entirely.

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
| [05-rendering](docs/05-rendering.md) | TSX templates and the JSX runtime, the published cache, views, hostnames, cultures |
| [06-features](docs/06-features.md) | what is implemented, and what is out of scope |
| [07-roadmap](docs/07-roadmap.md) | what is built, what is not, and what is planned |
| [08-testing](docs/08-testing.md) | the test layers, the containers, the browser suite |
| [09-schema-as-code](docs/09-schema-as-code.md) | the TOML format, sync, retirement, coherence across nodes |
| [10-packaging-and-upgrades](docs/10-packaging-and-upgrades.md) | environments, the upgrade process, releasing to npm |
| [11-assistant](docs/11-assistant.md) | the optional AI helper, its guardrails and its credentials |
| [12-schema-at-runtime](docs/12-schema-at-runtime.md) | the shared schema store, and importing at runtime |
| [13-content-transfer](docs/13-content-transfer.md) | the bundle format, and moving content between environments |
| [14-configuration](docs/14-configuration.md) | every environment variable, and every script |
| [15-operations](docs/15-operations.md) | media storage, redirects, git, security, members; running a cluster: health during upgrades, pausing editing, the commands as functions |
| [16-umbraco-import](docs/16-umbraco-import.md) | importing an existing Umbraco site: the report, what converts, and what is left |
| [17-bundles](docs/17-bundles.md) | created bundles, extensions as npm dependencies instead of App_Plugins, and bundles with a server half |
| [18-forms](docs/18-forms.md) | form building in core: the TOML definition, entries, workflows, and the e-mail port |

---

## Structure

```
bunbraco/
├── docs/                          # the detail: design documents, configuration, operations
├── packages/
│   ├── bunbraco/                  # the package a site installs: `bunbraco()`, the JSX runtime,
│   │                              #    and a `bunbraco` bin that delegates to cli/
│   ├── cli/                       # the command line, installable on its own;
│   │                              #    templates/ holds the starter sites `init --template` writes
│   ├── server/                    # the composition root: config, ports, adapters, createServer;
│   │                              #    background jobs, oEmbed, the event hubs, member sign-in and public access,
│   │                              #    the media store seam (file system, S3, Azure) and imaging
│   ├── core/                      # domain primitives — problem details, notifications, paging
│   ├── contracts/                 # OpenApi.json (vendored from Umbraco release-18.2.0) + generated types
│   ├── data/                      # dialect seam, drivers, migrations, repositories
│   ├── auth/                      # OAuth2 + PKCE, reference tokens, cookie redaction
│   ├── api-management/            # contract-first router, authorization, ports, handlers
│   ├── assistant/                 # optional AI helper: tool definitions, guardrails, changesets,
│   │                              #    the agent loop, the MCP server and the Bedrock provider
│   │                              #    (server/ also holds the optional schema store and git integration)
│   ├── backoffice-host/           # SPA shells, import map, static serving, graphics, npm extension discovery;
│   │                              #    plugin/ = the Changes dashboard, the Bundles views, the banner,
│   │                              #    the template editor's TSX scaffold and layout, and the assistant drawer
│   │                              #    plugin/branding/ = theme, logos and the overrides that de-Umbraco the client;
│   │                              #    plugin/localizations/ is generated by `localizations:build`
│   ├── schema/                    # schema-as-code: TOML model, parser, validator, writer, sync, export, generate, check/fix/upgrade
│   ├── transfer/                  # content transfer: the bundle format, canonical writer, reader, exporter
│   ├── import-umbraco/            # opt-in: an Umbraco backup → a compatibility report, schema files,
│   │                              #    a content bundle and view stubs; reads a .bacpac without .NET
│   ├── bundle-redirects/          # opt-in bundle: manage redirects in Settings; the reference example
│   │                              #    of a bundle with a server half (docs/17-bundles.md)
│   ├── backoffice-dist/           # the built Umbraco backoffice; dist/ is generated, upstream-static/ is committed
│   └── render/                    # the JSX→HTML runtime behind TSX templates, published cache (one view per culture),
│                                  #    URL and hostname routing, language fallback, the dictionary,
│                                  #    value converters (pickers, links, blocks, media and crops)
├── apps/site/                     # the reference site: bunbraco.config.ts, server.ts, Views/, schema/
├── scripts/                       # vendoring, module-graph check, coverage, versioning and publishing
├── .github/workflows/             # ci.yml on every push to main; release.yml on a v* tag
├── .githooks/                     # pre-push: the host gate, wired by `bun run hooks:install`
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

## Relationship to Umbraco

Bunbraco is its own CMS: its own server, data layer, schema-as-code, upgrade
process, content transfer and rendering. Two things come from Umbraco, both
MIT-licensed and neither .NET-specific:

- **the backoffice**, a standalone Lit SPA published to npm as
  `@umbraco-cms/backoffice`, vendored unmodified at 18.2.0
- **the Management API contract** that SPA speaks, a committed OpenAPI document
  from `release-18.2.0`, which the server here implements

That is the extent of it. Bunbraco does not run Umbraco packages or plugins, does
not render Razor, and does not open an Umbraco database, so it is not a drop-in
replacement for an Umbraco install. An existing site comes across with
[`bunbraco import umbraco`](#bring-an-existing-umbraco-site), which converts what
can be converted and reports what cannot.

For contributors: `Umbraco.Web.UI.Client/mocks/` in the Umbraco repository is an
MSW mock server covering ~45 endpoint groups — the best reference for exact
response shapes when the OpenAPI schema is ambiguous.

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

One more thing is in the repository without being in any package:
`tests/fixtures/umbraco/` holds the Umbraco Commerce demo store's database, MIT
licensed, which the importer's tests run against. Its licence is beside it.

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
