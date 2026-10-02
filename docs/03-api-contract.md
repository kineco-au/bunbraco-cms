# API contract

`packages/contracts/OpenApi.json` — vendored from
`git show release-18.2.0:src/Umbraco.Cms.Api.Management/OpenApi.json` — is the
contract. OpenAPI 3.1.1, 1.44 MB, 428 paths, **513 operations**, 507 schemas,
52 tags, `info.version = "Latest"`, no `servers` block (paths are absolute from
the host root).

We serve our copy at **`GET /umbraco/management/api/openapi.json`**, which is
where Umbraco serves the committed contract unconditionally (the reflection-generated
`/umbraco/openapi/management.json` is a dev-only Swagger concern we skip).

## Routing

```
/umbraco/management/api/v{version}/{template}      Management
/umbraco/delivery/api/v{version}/{template}        Delivery (later)
```

URL-segment versioning, default `v1`, unversioned URLs resolve to v1. Exactly one
endpoint is `v1.1`: `PUT /v1.1/document/{id}/validate`. Its operation id must stay
`PutDocumentByIdValidate` or generated client method names shift.

Operation ids follow `{Verb}{Path}By{Param}…` — `GetDocumentById`,
`PutDocumentByIdPublish`, `GetTreeDocumentChildren`. Schema ids strip the
`Umbraco.Cms` namespace and flatten generics: `PagedViewModel<DocumentTreeItemResponseModel>`
→ `PagedDocumentTreeItemResponseModel`.

## Handler registration

Types are generated from the vendored spec into `packages/packages/contracts/generated/`. Handlers
register against a typed table keyed by `operationId`:

```ts
defineOperation('GetDocumentById', async ({ path, auth }) => { … })
```

- an operation in the spec with no handler resolves to a `501` stub and is counted
  by `bun run coverage:api`
- a handler whose response shape drifts from the schema is a type error
- in test mode every response is validated against its schema

## Cross-cutting conventions

These are the ones that break the client silently if you get them wrong.

**Mutations never return the entity.** `POST`/`PUT`/`PATCH` return status only.
Creates return **201 with an empty body**, `Location` (absolute URL) and
`Umb-Generated-Resource` (the bare new id). Clients re-`GET`, or use
`{resource}/batch?id=…&id=…`.

**The notifications header is `Umb-Notifications`** — not `Umbraco-Notifications`.
Set on every non-GET response including 4xx, skipped on GET. Value is a JSON
array of `{ message, category, type }` where `type` is a string enum. The client
turns these into toasts and strips the header.

**Problem Details (RFC 7807) with `type: "Error"`** — a literal string, not a URI —
plus Umbraco's extensions:

```jsonc
{
  "type": "Error",
  "title": "The document could not be found",
  "detail": "…",
  "status": 404,
  "operationStatus": "NotFound",
  "errors": { "$.values[0].value": ["Required"] },
  "invalidProperties": ["bodyText"],
  "failedBranchItems": [ { "id": "…", "operationStatus": "…" } ]
}
```

Validation error keys are **JSON-path expressions into the request model**:
`$.values[3].value` for an entry that was sent, and
`$.values[?(@.alias=='x' && @.culture==null)].Value` for one that was omitted.
Matching request entries to errors by the `(alias, culture, segment)` triple is
how those paths are computed — without it the editor cannot highlight fields.

**Paging** is `{ total, items }` with `skip` (default 0) and `take` (default 100).
**`skip` must be a multiple of `take`** or Umbraco returns 400 `"Invalid
skip/take"`; the client relies on that contract.

**No ETag, no If-Match, no concurrency tokens anywhere.** Last write wins. Do not
invent them.

**Serialization**: camelCase, string enums, `Umb-` headers, and
`Cache-Control: no-store` on the Management API.

## Three distinct read models

Deliberately different, with **different authorization** — do not merge them.

| | Routes | Auth | Purpose |
| --- | --- | --- | --- |
| **Tree** | `/tree/{entity}/{root,children,ancestors,siblings,search}` | section/tree policy | sidebar navigation |
| **Item** | `/item/{entity}?id=&id=`, `/item/{entity}/{ancestors,search}` | **only back-office access** — deliberately looser | hydrating pickers |
| **Collection** | `/collection/{entity}/{id}?dataTypeId=&orderBy=&orderDirection=&filter=` | full section + per-resource | the list view |
| **Filter** | `/filter/{entity}` | | faceted search |

Rule inherited from upstream: **never widen an `/item/*` response** — it sits on a
looser auth boundary. Tree/item variant models are the reduced
`DocumentVariantItemResponseModel` (`name`, `culture`, `id`, `flags`, `state`) —
no values, no segment.

## The document editing payload

Values are a **flat array keyed by `(alias, culture, segment)`**, not a nested map.
Variance lives on each entry.

```jsonc
// POST /umbraco/management/api/v1/document
{
  "documentType": { "id": "<uuid>" },          // required
  "template":     { "id": "<uuid>" } | null,   // required key, nullable value
  "parent":       { "id": "<uuid>" } | null,   // null => root
  "id": "<uuid>" | null,                       // client-supplied key
  "values":   [ { "culture": null, "segment": null, "alias": "bodyText", "value": <any> } ],
  "variants": [ { "culture": "en-US", "segment": null, "name": "Home" } ]
}

// GET /umbraco/management/api/v1/document/{id}
{
  "id": "<uuid>", "isTrashed": false,
  "documentType": { "id": "<uuid>", "icon": "icon-document", "collection": null },
  "template": null,
  "flags": [ { "alias": "…" } ],
  "values":   [ { "editorAlias": "Umbraco.RichText", "culture": null, "segment": null,
                  "alias": "bodyText", "value": <any> } ],
  "variants": [ { "id": "<uuid>", "flags": [], "state": "Published",
                  "publishDate": "…", "scheduledPublishDate": null,
                  "scheduledUnpublishDate": null, "createDate": "…", "updateDate": "…",
                  "culture": "en-US", "segment": null, "name": "Home" } ]
}
```

`PublishableVariantState` is a string enum: `NotCreated`, `Draft`, `Published`,
`PublishedPendingChanges`, `Trashed`. `ReferenceByIdModel` = `{ "id": uuid }` is
the universal reference envelope; `FlagModel` = `{ "alias": string }` is a generic
extensibility slot present on every entity, variant, tree and item response.

Related payloads:

```jsonc
PUT …/{id}/publish     { "publishSchedules": [ { "culture": "en-US"|null,
                           "schedule": { "publishTime": …, "unpublishTime": … } | null } ] }
PUT …/{id}/update-and-publish   UpdateDocumentRequestModel + { "culturesToPublish": [...] }
PUT v1.1 …/{id}/validate        UpdateDocumentRequestModel + { "cultures": [...]|null }
PUT …/{id}/move        { "target": { "id": … } | null }
POST …/{id}/copy       { "target": …|null, "relateToOriginal": bool, "includeDescendants": bool }
PUT …/sort             { "parent": …|null, "sorting": [ ItemSortingRequestModel ] }
PATCH …/{id}/patch     { "operations": [...] }   // application/json-patch+json
```

## Document routes in full

| Verb | Route | Notes |
| --- | --- | --- |
| POST | `/document` | 201 + `Location` + `Umb-Generated-Resource` |
| POST | `/document/create-and-publish` | 201 |
| GET | `/document/{id}` | `DocumentResponseModel` |
| PUT | `/document/{id}` | 200, **empty body** |
| PUT | `/document/{id}/update-and-publish` | |
| DELETE | `/document/{id}` | |
| PATCH | `/document/{id}/patch` | `application/json-patch+json`, may 422 |
| PUT | `/document/{id}/publish` · `/unpublish` | |
| PUT | `/document/{id}/publish-with-descendants` | returns a task id |
| GET | `/document/{id}/publish-with-descendants/result/{taskId}` | poll |
| PUT | `/document/{id}/move` · `/move-to-recycle-bin` | |
| POST | `/document/{id}/copy` | **201** |
| PUT | `/document/sort` · `/{id}/sort-children` · `/root/sort-children` | |
| POST | `/document/validate` | create-shaped |
| PUT | `/v1.1/document/{id}/validate` | update-shaped |
| GET | `/document/{id}/published` · `/urls` · `/{id}/preview-url` | |
| GET/PUT | `/document/{id}/domains` · `/notifications` | |
| GET/POST/PUT/DELETE | `/document/{id}/public-access` | |
| GET | `/document/{id}/audit-log` · `/referenced-by` · `/referenced-descendants` · `/are-referenced` | |
| GET | `/document/configuration` · `/{id}/available-segment-options` | |

Versions (`/document-version`, mirrored by `/element-version`):
`GET ?documentId=&culture=&skip=&take=`, `GET /{id}`,
`PUT /{id}/prevent-cleanup`, `POST /{id}/rollback`.

Recycle bin: `GET recycle-bin/document/{root,children,siblings,referenced-by}`,
`GET …/{id}/original-parent`, `PUT …/{id}/restore`, `DELETE …/{id}`,
`DELETE recycle-bin/document` (empty).

## Endpoints outside the spec

`BackOfficeController` is `[ApiExplorerSettings(IgnoreApi = true)]` — the auth
endpoints are **absent from `OpenApi.json`** but mandatory. See
`04-backoffice-hosting.md`. Likewise the three SignalR hubs
(`/umbraco/serverEventHub`, `/umbraco/backofficeHub`, `/umbraco/PreviewHub`) and
the back-office shell routes.

`POST …/security/back-office/login` has non-obvious status codes:
200 / **401** invalid / **402 Payment Required** = 2FA required (body
`RequiresTwoFactorResponseModel`) / **403** locked or not allowed. Umbraco
timing-normalises the whole handler; we should too.

## Build order

**Tier 0 — boot the backoffice at all.** `openapi.json`; the shell routes;
`GET /server/status` and `/server/configuration` (both anonymous, both fatal on
failure); the auth chain `login → authorize → token → signout/revoke`;
`GET /user/current` + its sub-resources; `GET /manifest/manifest{,/private,/public}`;
`GET /culture`, `/language`, `/item/language/default`, `/object-types`, `/segment`;
and all the cross-cutting middleware above. Stub the SignalR hubs — the client
connects regardless.

**Tier 1 — core editing.** Document tree/item/collection; document CRUD;
publish/unpublish/create-and-publish/update-and-publish/publish-with-descendants;
move/copy/sort/recycle-bin; both validate endpoints **including the JSON-path
`errors` shape**; the schema reads the editor needs (`document-type` incl.
`allowed-at-root` and `{id}/allowed-children`, `data-type` incl. `/configuration`
and `/batch`, `template`); `/document/urls`, `/{id}/preview-url`,
`DELETE /preview`; media enough to pick images (`temporary-file` multipart,
`imaging/resize/urls`); document versions + rollback; segment/domain endpoints.

**Tier 2 — everything else**, in descending value: users and user groups (43 + 10
operations), content-type editing in full, members and member groups, Elements
(44 operations — large but self-contained), dictionary/blueprints/relations/tags/
webhooks/redirects, the file-system trees (script, stylesheet, partial-view,
static-file, with their `{path}` routing), ops and diagnostics (log viewer, health
checks, indexer, searcher, published cache, profiling, telemetry, packages),
install/upgrade wizards, then the long tail.

**Delivery API** is independent of the backoffice and small — 9 endpoints. The
expensive parts are the `expand`/`fields`/`fetch`/`filter`/`sort` query grammar
and tag-based output caching, not the routes.

## How the contract is enforced

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
