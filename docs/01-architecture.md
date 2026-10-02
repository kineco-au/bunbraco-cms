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

- `core` depends on nothing but its own types. It declares repository and service
  *interfaces* and the notification bus. All business rules live here.
- `data` implements `core`'s repository interfaces. It is the only package that
  knows SQL exists.
- `api-management` / `api-delivery` depend on `core` only — never on `data`.
  They are thin: parse → validate → call a core service → map to a response model.
- `render` depends on `core` and the published cache; it never queries drafts.
- `auth` owns tokens and identity; the API packages consume a resolved principal.
- `backoffice-host` serves bytes and HTML; it has no domain knowledge.

Composition happens once, in `@bunbraco/server`, which wires concrete `data`
implementations into `core` services; a site never sees it, and `apps/site` is
only a consumer.

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
