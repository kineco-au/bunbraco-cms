# Architecture

## Repo layout

```
bunbraco/
├── docs/
├── packages/
│   ├── bunbraco/                 # the package a site installs: bunbraco() + the CLI
│   ├── server/                   # composition root: config, ports, adapters, createServer
│   ├── core/                     # domain: entities, services, notifications — no I/O
│   ├── contracts/                # OpenApi.json + generated types
│   ├── data/                     # dialect seam: schema, migrations, repositories
│   ├── auth/                     # OAuth2 server, token store, cookies, providers
│   ├── api-management/           # /umbraco/management/api/v1/** handlers
│   ├── backoffice-host/          # SPA shell, importmap, static assets, manifests
│   ├── schema/                   # schema-as-code: model, parser, validator, writer, sync
│   ├── backoffice-dist/          # the built backoffice (dist/ generated, upstream-static/ committed)
│   └── render/                   # TSX renderer, published cache, front-end routing
├── apps/site/                    # the reference site: config, server.ts, Views/, schema/
├── scripts/
└── tests/
```

Bun workspaces. Every package is `@bunbraco/<name>` with an `exports` map and its
dependencies declared as `workspace:*`; the umbrella `bunbraco` depends on all of
them. There are no tsconfig `paths` — resolution is ordinary package resolution,
which is what makes the packages consumable outside this repo.

## Dependency rules

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

## Server composition

One Bun `serve()` with an ordered router:

| Order | Prefix | Handled by |
| --- | --- | --- |
| 1 | `/umbraco/backoffice/*`, `/umbraco/login/*`, `/App_Plugins/*` | `backoffice-host` static |
| 1 | `…/security/back-office/graphics/*` | `backoffice-host` (not in the contract) |
| 2 | `/umbraco/management/api/v1/security/back-office/*` | `auth` (not in the contract) |
| 2 | `/umbraco/management/api/v1/*` | `api-management` |
| 3 | `/umbraco/management/api/v1/security/back-office/*` | `auth` |
| 4 | `/umbraco`, `/umbraco/login` | `backoffice-host` HTML shells |
| 5 | `/umbraco/delivery/api/*` | `api-delivery` (later) |
| 6 | `*` | `render` — front-end content routing |

## Contract-first handlers

`packages/contracts/OpenApi.json` is vendored, and types are generated from it with the
same generator the client uses. Handlers are registered in a typed route table
keyed by `operationId`:

- an operation present in the spec with no handler is a **compile-time** gap
  (it resolves to a `501` stub that the coverage report counts)
- a handler whose response shape drifts from the schema is a **type error**
- in test mode every response is validated against its schema at runtime

`bun run coverage:api` emits `docs/api-coverage.md` — implemented vs. total
operations per area — and fails CI if an implemented operation regresses.

## Cross-cutting infrastructure

- **Notification bus** (`core/notifications`): synchronous, ordered, typed
  publish/subscribe mirroring Umbraco's `INotificationHandler`. Publishing,
  cache invalidation, indexing and webhooks all hang off this rather than calling
  each other.
- **Lock abstraction** (`data/locks`): named write locks around content-tree
  mutation. SQLite → WAL plus a single-writer queue; Postgres → advisory locks.
- **Background jobs** (`core/jobs`): interval scheduler for version cleanup,
  scheduled publishing, temporary-file cleanup, log scrubbing, keep-alive.
- **Problem details**: RFC 7807 responses and the `Umb-Notifications` header
  convention the backoffice reads for toast messages.

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
