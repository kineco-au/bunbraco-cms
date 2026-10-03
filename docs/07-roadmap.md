# Roadmap

Each phase has a hard exit criterion. No phase is done until it is met, and the
criterion is always "works in the actual Umbraco backoffice", never "returns 200".

## Phase 0 — Skeleton & contract ✅

Repo layout and Bun workspaces; TypeScript strict; Biome for format/lint;
`contracts/OpenApi.json` vendored from `release-18.2.0`; types generated from it;
a typed route table with `501` stubs for all 513 operations; the dialect seam with
both drivers connecting; the migration runner; `vendor:backoffice`; `bunbraco dev`.

**Exit:** `bun run check` (format + lint + typecheck) and `bun test` are green;
`bun run coverage:api` reports 513 operations with a known implemented count;
`vendor/backoffice/` contains a browser-runnable client.

**Done.** 53 tests green on both dialects; 0/513 operations implemented, with all
513 routable and answering 501; `vendor/backoffice/` builds in 0.8 s with 140
import-map entries.

## Phase 1 — Backoffice boots ✅

Static serving with the cache-bust prefix; import-map generation; the SPA shell;
`manifest/*`; `server/status`, `server/configuration`, `server/information`;
`culture`, `language`; a `user/current` shape good enough to render the chrome.

**Exit:** `<umb-app>` renders its shell with no console errors and redirects an
unauthenticated visitor to the login page.

**Built.** `packages/backoffice-host` (cache-busted static serving, import-map
generation from package manifests, both SPA shells, branding graphics),
`packages/auth` (definitive token rejection so the client stops retrying), the
Phase 1 handlers (`server/status|configuration|information`,
`manifest/manifest{,/public,/private}`, `culture`, `language`,
`item/language/default`, `user/current`), contract-driven authorisation, and
`bun run dev`. 10/513 operations implemented; 104 tests green on both dialects.

**Evidence so far:** the whole module graph resolves — 6,556 modules crawled from
the entry point through the served import map, **0 broken, 0 unresolved** — and
the boot probes return contract-correct bodies.

**Closed in Phase 2** except for one caveat: "no console errors" needs a real
browser, and none was available in the session that built this, so that half of
the criterion is verified only by the module-graph crawl. The login redirect now
works: authorize sends an anonymous browser to `/umbraco/login`, which signs in
and resumes the flow.

## Phase 2 — Auth ✅

OAuth2 authorization-code + PKCE server; reference tokens in `__Host-` cookies
with redaction; our own login page against `…/security/back-office/*`; user and
user-group CRUD; permissions evaluated on every Management API call.

**Exit:** a real login, and the session survives a reload and a second tab.

**Done**, with one scope decision: user and user-group *administration* CRUD (53
operations) was deferred to Phase 5 as agreed — none of it is needed to sign in.
Built: the identity schema with Umbraco's five seeded groups and their section
grants, argon2id password hashing behind the `password_config` marker column,
timing-normalised login, the authorization-code + PKCE flow, reference tokens
stored hashed, refresh-token rotation with reuse detection that kills the session,
single-use authorization codes, and contract-driven authorisation on every
request. Our own login page is built from the UUI components the npm package does
ship, so R2 cost no Node toolchain.

**2FA is not implemented.** The endpoint exists and answers definitively; the 402
path in the login UI is wired but unreachable.

## Phase 3 — Schema & content types ✅

The full Tier 1–2 migration; content-type services (compositions, groups, allowed
children, variance); data types and core property-editor value handling;
`tree`/`item` endpoints for types and folders.

**Exit:** create a document type with tabs, properties and a template in the real
backoffice, reload, and it persists.

**Done.** `node` as the universal polymorphic tree, the content-type aggregate
(groups, properties, compositions, allowed children, allowed templates) written as
one document, 13 seeded data types keyed with Umbraco's own GUIDs, and templates
whose views live on disk. Variance is stored as the flags byte on both the type
and the property, so the intersection rule holds.

Content-type **folders**, copy, move, import/export and the media/member type
trees are not implemented.

## Phase 4 — The vertical slice ✅

Documents: create/update/validate/publish/unpublish; draft vs published storage;
versioning, rollback and `prevent_cleanup`; tree, collection and recycle bin;
publish notifications; the published cache; URL routing; the TSX renderer;
templates as files.

**Exit:** create a page → edit → save draft → publish → see it rendered at its
URL → roll back a version.

**Done**, and verified end to end over real HTTP as well as in tests. The
publish model is Umbraco's: saving a draft creates no version, publishing freezes
the draft and forks a new one, `edited` is recomputed by comparing draft against
published, rollback writes into the draft without touching history, and a publish
below an unpublished ancestor is refused. Rendering resolves a route by walking the
published tree, executes a `.tsx` template through a JSX-to-HTML runtime, and
applies the layout chain declared in the file.

Not implemented: `validate` endpoints and the JSON-path `errors` shape, move/copy/
sort, the recycle-bin endpoints (`move-to-recycle-bin` works; restore and empty do
not), scheduled publishing, publish-with-descendants, preview, segments, and the
`umbracoUrlAlias` and domain/culture routing paths. Culture variants are stored
and returned but only exercised invariantly.

## Phase 5 — Foundations for the split

Inserted after Phase 4, before any widening, because every widening area would
otherwise be built on a model that is being replaced. Three slices, in this
order; the full design is in `09-schema-as-code.md` and
`10-packaging-and-upgrades.md`.

### 5a — Packaging ✅

Move the composition root out of `apps/site` into `@bunbraco/server`; declare
every inter-package dependency and an `exports` map; publish the built backoffice
as `@bunbraco/backoffice-dist` and resolve it from `node_modules`; an umbrella
`bunbraco` package with the CLI (`init`, `start`, `migrate`, `schema`, `generate`,
`upgrade`, `admin`); turn `apps/site` into a genuine reference site.

**Exit:** a fresh directory with `bun add bunbraco`, a config file and a
three-line `server.ts` boots the backoffice and renders a page. No tsconfig
`paths` in the site.

**Done.** `@bunbraco/server` holds the composition root; `@bunbraco/backoffice-dist`
holds the built client and is resolved as a dependency; `@bunbraco/contracts`
carries its own `OpenApi.json`; every package declares dependencies and an
`exports` map; the root tsconfig has no `paths`; `bunbraco` ships `bunbraco()`
and the CLI (`start`, `init`, `admin reset-password`, with `upgrade`, `schema`
and `generate` stubbed until 5b/5c). Verified with a site in `/tmp` whose only
dependency is `bunbraco`: `init`, boot, login, a template in the site's own
`Views/`, and a rendered page.

The exit test earned its keep on the first run: everything passed except the
render, because a view's JSX imported `@bunbraco/render/jsx-dev-runtime` — a
name that resolves inside the monorepo (the root depends on every package) but
not from a site that depends only on `bunbraco`. The umbrella package now exports
the JSX runtime itself and `jsxImportSource` is `bunbraco` everywhere. Nothing
in the test suite could have caught that; only a consumer outside the repo could.

### 5b — Schema as code, and the value layer

First the **append-only value model** (`02-data-model.md`) — **done**:
`property_value` with `is_current`, events for save/publish/rollback,
`schema_state` as a history with `prepared`/`current`, publish without copying,
rollback by appending, and write gating on the current state, all in migration
003 with the document repository rewritten on top. Pinned by `tests/values.test.ts`:
an unchanged value appends nothing; a cleared value is a version; the published
read is as-of the publish event; a conversion appended under a newer state is
invisible to a node reading as-of the older one; a prepared state does not gate
and the cut-over does. Two Umbraco-visible behaviours changed on purpose: every
save is a recoverable version (Umbraco versions only on publish), and rollback
appends rather than rewrites. Cleanup that respects pinned events is designed
but has no job runner yet. Then the TOML schema package — its pure core is **done** in
Then **schema-as-code** (`09-schema-as-code.md`) — **done**. `@bunbraco/schema`:
a strict parser (unknown keys are errors, every problem reported with file and
path), whole-set validation, a canonical writer that round-trips byte-for-byte,
a directory loader, an order-independent hash, and `syncSchema` — the
version-gated sync under `Locks.Schema`: older files skip into compatibility
mode, same version with a different hash applies in development and refuses in
production, production refuses any element without a key, removal retires and
re-adding revives by key or by alias, a type removed while it has content
refuses (`--force-retire-types` overrides), and every apply appends a
`schema_state` row and a `cache_instruction`. The server boots through it,
writes minted keys back in development (and re-hashes the state so the next
node sees the files as applied), watches `schema/` for changes, and gives the
document-type editor a file writer that refuses with 409 when the directory is
read-only. `schema export` walks the database back into canonical files —
built-ins only when the site changed them — and `generate` emits
`schema/content-types.d.ts`. Multi-node plumbing landed with it: `server`
identity, publish and sync appending `cache_instruction`, and a poll that drops
the published cache on another node's instruction. Media and member types
follow when those areas arrive; data types and languages are file-defined but
not yet written by the backoffice.

**Exit:** the Phase 3 and Phase 4 test suites pass with every type defined in
`schema/*.toml` and no content-type rows created through the API; a type created
in the backoffice appears as a new file; deleting a file with content refuses to
boot; two server instances on one Postgres database, one with newer files, end
with the database at the newer version, the older instance in compatibility
mode, and both caches coherent after a publish; and after `upgrade` advances
the state, the older instance still serves every page it did before while
refusing writes with 409.

**Met.** `tests/documents.test.ts` boots every Phase 4 case from a TOML type;
`tests/schema-sync.test.ts` pins the sync rules at the data layer;
`tests/schema-boot.test.ts` covers the rest — the file a backoffice save
produces, the 409 in a read-only environment, the boot refusal for a removed
type with content, and (Postgres only) two servers on one database: the newer
files win, the older node reads and renders, answers 409 to writes, and sees
the other node's publish after one poll; restarted with its old files it reports
compatibility mode. The last clause — `upgrade` advancing the state — belongs
to 5c and is exercised at the repository level in `tests/values.test.ts`.

### 5c — Upgrade machinery — **done**

The design is `10-packaging-and-upgrades.md`, Part 2. This was the build plan for
it, written after 5b landed, with the decisions that 5b's code forces or makes
easy. What 5c stands on: `schema_state` rows with `prepared`/`current` status
and `makeStateCurrent` as the cut-over; write gating (`assertNodeMayWrite`, 409);
append-only values tagged with the state that wrote them and read as-of a
state; `since_state_id` on every element; retirement; the version-gated sync
with a dry run; `server` + `cache_instruction` + the poll; the backup-free
GUID-chain migrator in `migrations.ts`.

Four slices, each green on both dialects before the next starts.

#### 5c.1 — Framework migrations, hardened

- **Ledger.** `migration_history(name, kind, from_state, to_state, applied_at,
  duration_ms, checksum, applied_by)` written by `migrate()` per step, and by
  the value-migration runner (kind `value`) so "which converters ran here" is
  one table. `checksum` is a hash of the migration's source text where it is
  a file, or of its name for built-ins.
- **Expand/contract, linted.** `Migration` gains `kind: 'expand' | 'contract'`
  and `release: string` (the framework version that ships it). A `contract`
  must name `contracts: <expand migration name>`, and the `MigrationPlan`
  constructor throws unless that expand's `release` is lower than the
  contract's. The three existing migrations are `expand`, release `0.1.0`.
- **`bunbraco upgrade --plan`.** A `RecordingDb` implements `Db`: `exec`
  captures rendered SQL, `query` throws `Unplannable`, `transaction` recurses.
  Each pending step runs against it; the output is the DDL per step, or
  "unplannable: <step> reads data". Migrations 001–003 are plannable.
- **Boot rules.** `readState()` not in the plan → `UpgradeStateError` naming
  both states ("database is newer than this code"). In production
  (`NODE_ENV=production`), pending steps on an existing database refuse to
  boot with the command to run; a database at the initial state is an install
  and proceeds everywhere. Development migrates at boot as today.
- **Schema operations on the dialect seam.** `db.schema.addColumn/dropColumn/
  renameColumn/addIndex/dropIndex/renameTable`. Bun's SQLite supports `ALTER
  TABLE … DROP/RENAME COLUMN`, so no copy-table dance is needed; the helper
  exists so a migration is written once.
- **Backups.** `backupBefore(db, config, what)`: SQLite copies the file to
  `<file>.<timestamp>.bak` beside it; Postgres runs `BUNBRACO_PG_DUMP` when
  set, else refuses unless `--backup-taken`. Used by `check --fix`, `upgrade`
  and `schema purge`.

#### 5c.2 — Pending elements at runtime

An element is **pending** on a node when the state that created it
(`since_state_id`) is newer than the node's `(version, revision)`, or when its
file says `since` newer than the node's version. `since` from the file is
stored as `since_version` on the row by the sync, so the rule is one comparison
in one place: `isPending(row, nodeState)` in `@bunbraco/data`.

- `ContentTypeRepository` takes `nodeState` (as `DocumentRepository` does) and
  marks each property and type `pending: { version, revision } | null`.
- **Editor**: no client change. The document-type and document endpoints
  append ` (goes live in 2.1)` to a pending property's name and prepend the same
  to its description, so the field is visible, editable and explained in the
  editor Umbraco ships. Pending *types* are left out of `allowedAtRoot` and
  `allowedChildren`, which is the create menu.
- **Validation**: the document save/publish validation skips `mandatory` and
  regex for pending properties.
- **Rendering**: `createPublishedContentSource` drops pending properties from
  the published model, so a template on the old version cannot render a
  half-filled field.
- **Prepared states**: `syncSchema` gains `status: 'prepared' | 'current'`;
  `check --fix` syncs under `prepared`, so everything it creates is pending on
  every live node and nothing gates writes until `upgrade` cuts over.

#### 5c.3 — Check, fix, upgrade

- **`upgrade_report`** — the stable shape the dashboard reads:
  `(id, run_id, kind: auto|person|blocking, code, subject_type, subject_key,
  subject_name, property_alias, culture, message, link, status: open|resolved,
  first_seen, last_seen, resolved_at)`. A run upserts by `(code, subject_key,
  property_alias, culture)` and marks anything it no longer reports `resolved`.
  *Renamed `change_report` by migration 018, with `source` and `scope` added, when
  content transfer began sharing it — see `docs/13-content-transfer.md`.*
- **The check** (`packages/schema/src/check.ts`), one function used by
  `upgrade check` and `schema check`: framework steps pending (plan), the site
  diff (dry-run sync report), and the data findings over that diff —
  a type removed with content → *blocking*; a new mandatory property on a
  type with documents: *auto* when the file declares `default` or `--set`
  names it, else one *person* finding per document and culture, with the
  backoffice link; a property whose data type changed editor → run the
  converter read-only over every current value: convertible → *auto*, failing
  → *person* per value, no converter → *blocking*; a reference (composition,
  allowed child, template) that resolves to nothing → *blocking*. Classifies
  the whole change: additive / data-requiring / breaking / contract.
- **Converters** — one construct for site and framework:
  `defineValueMigration({ id, since, from: {type, property}, to: [{property}],
  convert })` in `schema/migrations/*.ts`, loaded by the CLI from the site;
  framework converters are the same objects in a registry keyed by editor
  alias. `convert` returns a value or throws — a throw is a *person* finding.
- **`check --fix`** — backup; sync under a *prepared* state; append defaults,
  `--set type.property=value`, and every applicable value migration as
  `migrate` events under that state (old nodes read as-of their own state and
  never see them); record the run in the ledger; re-run the check and write
  the report. **Decision:** conversions run here and only here — append-only values
  make that safe, and it removes the editor pause. A value an old node writes
  *after* the fix that still needs converting is a finding on the next check,
  and `upgrade` refuses until `check --fix` has been run again.
- **`upgrade`** — take the content-tree and schema locks; re-run the check;
  refuse on *person* or *blocking* findings under policy `strict` (default in
  production; `pending-allowed` in development/test, or `--force`, which
  records who and why) — including values left unconverted since the last
  fix; backup; framework `contract` steps for this release; `makeStateCurrent` — the cut-over; ledger;
  `cache_instruction`. Old nodes see the state advance on their next poll,
  switch to read-only, and `/health` (non-contract) answers 503 so the balancer
  drains them; `server/status` reports the same.
- **Development boot** syncs as today and then runs the check and writes the
  report; it does not stop — that is `pending-allowed`. Production boot never
  syncs a schema change with data findings; it refuses and names `upgrade check`.

#### 5c.4 — Dashboard, static check, the rest

- **Upgrade dashboard** (the Changes dashboard since migration 018): a
  framework-shipped backoffice package
  (`packages/backoffice-host/plugin/`, served at `<backoffice>/bunbraco/*` and
  merged into the manifests like an `App_Plugins` package): a Settings-section
  dashboard reading `GET <backoffice>/bunbraco/api/change-report` (non-contract,
  same footing as the auth routes) — counts by kind, each finding with its
  link, resolved ones greyed; and a header app that shows a *read-only* banner
  when `server/status` reports compatibility mode. Plain Lit modules against
  the importmap, no build step.
- **`schema check --static`** adds the PR rules: keys present, classification
  of the diff against the last exported state, and "this rename has no
  migration".
- **`schema purge --older-than <days>`** deletes retired property types and
  their values (contract; ledgered; backup first). **`upgrade schema`**
  rewrites every file canonically.

**Exit:** as written below, minus the browser: the dashboard is proved by its
endpoint and its manifest being served, not by clicking it (UI tests only when
asked). A site change renaming a property, with a value migration, promotes
through two databases with different content and moves every value in both;
removing a property from its file hides it without touching a single value, and
re-adding the alias by hand brings every value back; a release adding a
required property without a default and breaking three values: `check` reports
the property as needing a person and the three values with links; `upgrade`
refuses; `check --fix` creates the property so it shows in the running
backoffice badged as pending, and an existing page still publishes without it;
after filling it in and fixing the values, `check` is clean and `upgrade`
cuts over and records the run in the ledger, with a
backup on disk — with an older instance serving reads throughout, no
maintenance page, and its `/health` going 503 after the cut-over; and the
findings are readable from the report endpoint, resolving as they are fixed.

**Met**, with these departures from the plan above, all recorded in
`10-packaging-and-upgrades.md` Part 3:

- `upgrade` writes no content. Conversions run only at `check --fix`; a value
  an old node writes after the fix is an `unconverted-value` finding, and
  `upgrade` refuses until the fix runs again (the user's call, over the plan's
  "remainder at upgrade").
- A prepared sync defers three things to the cut-over, not one: an existing
  property's editor change, a property *becoming* mandatory, and every
  retirement — so old nodes stay fully writable until `upgrade`.
- A node's *draft* reads are also as-of its own state, and an unchanged value
  re-saved on an old node no longer overwrites a conversion: equality is judged
  against what the node sees, the row superseded is the true current one.
- Live mandatory gaps on published pages are reported (`mandatory-unfilled`)
  for the dashboard but never gate an upgrade.
- `schema check --static` enforces keys and well-formed migrations; it cannot
  classify a rename without a previous state to diff against, so "this rename
  has no migration" is what the database-backed check says.

Pinned by `tests/migrations.test.ts` (5c.1), `tests/pending.test.ts` (5c.2),
`tests/upgrade.test.ts` (5c.3: both exit scenarios, the policy, `--set`, and
an old instance through a cut-over) and `tests/dashboard.test.ts` (5c.4).

## Phase 6 — Widen, as work packages

Phase 6 is cut into packages ordered by one question: what does the **create
content type → publish page** journey still hit that answers 501, or that a
real editor would reach for and find missing? The first three packages
complete that journey in the real backoffice; the rest widen outward from it.
Each package has its own exit criterion, updates `docs/api-coverage.md`, and
is green on both dialects before the next starts.

What the journey calls today that is not there (found by reading the client's
data sources, not by guessing): the document workspace loads
`GetDocumentConfiguration`, validates through `PostDocumentValidate` /
`PutDocumentByIdValidate` before every save, and its "Save and publish" is
`PostDocumentCreateAndPublish` / `PutDocumentByIdUpdateAndPublish`; the content
tree renders a Recycle Bin node (`GetRecycleBinDocumentRoot`) and deep-links
through `GetTreeDocumentAncestors`; the document-type workspace loads
`GetDocumentTypeConfiguration`, its Compositions tab posts
`PostDocumentTypeAvailableCompositions`, "Create template" posts
`PostDocumentTypeByIdTemplate`, and pickers search with
`GetItemDocumentTypeSearch`; the property editor picker lists data types with
`GetFilterDataType`. All 501 today.

### WP-6.1 — The document workspace, end to end — **done**

- `GetDocumentConfiguration`; `PostDocumentValidate` and
  `PutDocumentByIdValidate` with Umbraco's JSON-path `errors` shape — mandatory,
  regex and the pending rule, so a field the editor shows red is exactly the one
  the server refuses; `PostDocumentCreateAndPublish` and
  `PutDocumentByIdUpdateAndPublish`; `GetDocumentByIdPublished`.
- Tree completeness: `GetTreeDocumentAncestors`, `GetTreeDocumentSiblings`,
  `GetItemDocumentAncestors`, `GetItemDocumentSearch`; the recycle bin tree
  (`GetRecycleBinDocumentRoot`/`Children`, `OriginalParent`) so the node the
  tree always renders answers — restore and empty come with 6.5.
- The `Umbraco-Notifications` header on save/publish responses, so the
  client's toasts say what happened.

**Exit:** in the real backoffice, with `apps/site`'s TOML type: create a page
with "Save and publish" and a mandatory field empty → the field is marked and
nothing is created; fill it → the page is created, published and rendered;
reload deep-linked to the page; the tree shows it and the Recycle Bin without
an error toast. API tests cover each endpoint; the UI steps are a manual
checklist in `08-testing.md` (browser tests only when asked).

**Built:** all of the above; `tests/documents.test.ts` "WP-6.1" pins it —
validation errors by index and by filter expression exactly as Umbraco emits
them, create-and-publish refusing before creating anything, the published
read against a newer draft, ancestors/siblings/search, and the recycle bin
with the original parent (migration 006 records it). The content tree now
returns the contract's `DocumentTreeItemResponseModel` in full (document type,
variants with state, ancestors, dates) rather than the generic item. The
manual checklist is in `08-testing.md`. API coverage 61/513.

### WP-6.2 — The Settings section, end to end — **done**

- Document types: `GetDocumentTypeConfiguration`,
  `PostDocumentTypeAvailableCompositions`,
  `GetDocumentTypeByIdCompositionReferences`, `GetDocumentTypeByIdAllowedParents`,
  `GetItemDocumentTypeSearch`, `GetTreeDocumentTypeSiblings`, `GetDocumentTypeBatch`,
  `PostDocumentTypeByIdTemplate` (creates `Views/<alias>.tsx` from the
  scaffold), copy and move; **folders** — decision below.
- Data types: `GetFilterDataType` (the editor picker), `GetItemDataTypeSearch`,
  `GetTreeDataTypeAncestors`, `GetDataTypeByIdReferencedBy`, copy, folders;
  and the 5b deferral: a data type saved in the backoffice is written to
  `schema/data-types/<alias>.toml` (alias derived from the name, as export does).
- Templates: `GetTreeTemplateChildren`/`Ancestors`/`Siblings`,
  `GetItemTemplateSearch`; the editor's "master template" maps to
  `export const layout`. The query builder stays 501 (Razor-specific).
- Every tree the Settings section renders answers — partial views,
  stylesheets, scripts, dictionary, languages, relation types, log viewer,
  webhooks: empty roots where the area is unbuilt, real ones where it is — so
  the section loads with no red toast. Languages get their real CRUD here
  (`language`, 5 ops) since the document workspace reads them.

**Exit:** in the real backoffice, create a document type with a tab, three
properties on three editors (one via "Select editor → create new data type"),
a composition, an allowed child and "Create template"; reload: it persists,
its file is in `schema/document-types/`, the data type's in
`schema/data-types/`, the view in `Views/`. Settings opens clean.

**Built:** everything above, pinned by `tests/settings.test.ts`. Folders live in
the files as `folder = "Pages/Blog"`: the sync creates the path, a folder
rename or a type move rewrites every file from the database, and the
composition picker shows the path. A data type saved in the backoffice gets an
alias from its name (once) and its own file; a built-in gets a file only once
it is changed; one in use refuses to delete. "Create template" scaffolds the
view and attaches it. The template tree hangs a view under the layout its
`export const layout` names. Languages have their CRUD and `languages.toml`
follows. Every tree the backoffice renders for an area not yet built answers an
honest empty result in its declared shape (`handlers/settings-stubs.ts`, 54
operations): root, children, ancestors and siblings for media types, member
types, partial views, scripts, stylesheets, blueprints, media and elements;
the media and element recycle bins; the dictionary, member-group and
static-file trees; the dictionary, relation-type and webhook lists; and a 404
for "original parent" in the bins that cannot hold anything yet. The coverage
report counts them apart. The first cut stubbed only Settings roots; the
manual walk-through hit ancestors and then blueprints, so the stubs now cover
every unbuilt section by sweeping the contract for unimplemented tree and
recycle-bin reads rather than waiting for the next toast. Real with them:
document-type and data-type tree search (with `itemKind`) and the document
recycle bin's siblings.
Deferred: partial views, scripts and stylesheets as real file trees (their
roots answer empty), and the template query builder (Razor-specific, stays 501).
*Since built:* partial views (`Views/Partials/*.tsx`), stylesheets (`css/`,
served at `/css/`) and scripts (`scripts/`, at `/scripts/`) — tree, items,
CRUD, rename and folders, one handler for all three over path-safe file
stores; the editor's `.cshtml` names are stored as `.tsx`; a new partial view
starts from the `Empty` snippet, and the snippets are TSX components. Pinned by
`tests/file-systems.test.ts`.
API coverage 155/513, 99 real; the news dashboard answers `{ items: [] }` (no umbraco.com feed to relay).

**Found in the walk-through, fixed after:** the Content section offered no
Create action. The backoffice gates every document action on the current
user's permission verbs, and `user/current` sent `fallbackPermissions: []`;
the seed had never granted the built-in groups any verbs either. The seed now
grants Umbraco's installer set verbatim (`BUILT_IN_GROUP_PERMISSIONS`),
migration 007 backfills databases seeded before that, and `user/current`
sends the principal's real verbs. Picking a type in the create dialog then
asks for its blueprints (`GetDocumentTypeByIdBlueprint`), which answers an
empty page until WP-6.5.

**Development aid:** in development the server logs the first request to
each operation that answers 501 (`501 GetUser  GET /umbraco/management/api/v1/user
(3 missing so far)`), and keeps the list on `server.notImplemented`, so one
walk through a section shows everything it still needs.

### WP-6.3 — Property editors that need the server — **done**

- Temporary files (`temporary-file`, 5 ops) backing the Upload and Image
  Cropper editors, with a file store under the site (`media/`), served on the
  front end; the value converters and rendering model for Block List, Block
  Grid, Multi-URL Picker, Content Picker (`model.value()` returns typed
  content, not JSON); Tags (`GetTag`); the RTE's `oembed` proxy.
- `bunbraco generate` types the block values.

**Exit:** a page using every built-in editor round-trips through the editor
and renders; an uploaded file is served at its URL.

**Built:**

- **Uploads.** A file goes up as a temporary file (`MediaFileStore`, kept a
  day, swept hourly). Saving a value that names one runs it through the
  repository's *value intake*: the file is placed at
  `media/<8 hex>/<safe name>` and the value stores its path, served at
  `/media/…`. An upload that has expired is refused (400), never dropped.
  Upload values are stored as the path, as Umbraco stores them, and edited as
  `{ src }`; the cropper keeps `{ src, crops, focalPoint }`.
- **Every built-in data type.** The seed now matches Umbraco 18's installer
  exactly: 37 data types, key for key, with its configuration (labels of each
  kind, checkbox and radio lists, dropdowns, colour, date/time with zone,
  member picker, multi URL picker, four media pickers, list views). Existing
  databases gain the missing ones at boot. True/false reads back as a boolean
  and dates as the wall-clock time the picker sent, not shifted by the
  server's zone.
- **Values as templates receive them** (`@bunbraco/render` values): a content
  picker yields the page, a tree picker the pages, a multi URL picker links
  with resolved URLs, block list and block grid their elements
  (`PublishedElement`, with the same `value()`), the media picker media with
  crops (one or many, as its data type says), the cropper an
  `ImageCropperValue`, and rich text has its `{localLink:…}` links resolved.
  A reference to something unpublished or gone is dropped.
- **Tags** are read from the current values of Tags properties, grouped by the
  data type's configuration, with stable ids; no table of their own.
- **oEmbed**: Umbraco's providers, each asked for JSON; photos become `<img>`.
- **`bunbraco generate`** types pickers, links and blocks, down to the element
  types a block editor allows (`TypedElement<Feature>`), and imports only the
  value types it uses.

Pinned by `tests/uploads.test.ts`, `tests/value-converters.test.ts`,
`tests/editor-services.test.ts` and `tests/every-editor.test.ts` (every built-in,
sent as the editor sends it, read back unchanged, re-saved without a new
version, and rendered); in the real backoffice by `tests/browser/media.browser.ts`
(every property editor on one page renders, and an upload saves as a served
file).

### WP-6.4 — Media — **done**

**Started — media types done.** Saving a media type in the backoffice hit
`PostMediaType`, and a write cannot honestly be stubbed, so the Settings half
landed first: media types share `content_type` with document types (told
apart by node object type, one alias space), `ContentTypeRepository` and the
type handlers take a kind, and the schema package reads and writes
`schema/media-types/*.toml` under `[media-type]` — the same vocabulary
without templates or cleanup, synced, exported, written back, folders
included. The API shape differs only where the contract does: references
keyed `mediaType`, `allowedMediaTypes`, `isDeletable`, a smaller
configuration. Pinned by `tests/media-types.test.ts`. Then **Umbraco's
seven built-in media types**, key for key from its installer, by your
decision: Folder, Image and File are system types — shipped, ensured at every
boot (before the sync, so files may reference them, and after, so Folder
allows whichever built-ins the site has), not deletable, alias fixed, a file
may override one only by its key; Video, Audio, Article and Vector Graphics
are site files that `bunbraco init` scaffolds (and `apps/site` now has), which
a site may delete. Their seven supporting data types (pixel and byte labels,
four upload variants, the media list view) are built-ins, ensured in older
databases at boot. The vocabulary gained a top-level `[[group]]` — Umbraco's
media types use a group with no tab — and export no longer folds such groups
into an invented "Content" tab. Pinned by `tests/built-in-media-types.test.ts`.
Remaining below: media itself.

**Found in the walk-through:** the Content section's create button spun
forever — the dialog waits on the upload settings
(`GetTemporaryFileConfiguration`), which answered 501. It now reports
Umbraco's defaults (image types, the executable-extension blocklist, an empty
allow-list, no size limit) from `DEFAULT_UPLOAD_SETTINGS` in `@bunbraco/core`,
the same lists WP-6.3's upload endpoints will enforce.

Media types as files (`schema/media-types/*.toml`, same parser vocabulary),
seeded built-ins (Image, File, Folder, …); media tree, items, CRUD, collection
and search; temporary file → media; `GetImagingResizeUrls` with an on-disk
resize cache; crops and focal point; the Media Picker in documents; images in
the RTE; `model.media()` in views. **Exit:** upload an image in Media, pick it
on a page, publish, and the page renders a resized crop.

**Built:**

- **Media items** are stored as documents of the media object type (the
  repository's `kind`), never published: create, edit and validate, the tree,
  items, ancestors, search, the collection view (filter, order, creator), sort
  and move, the recycle bin (restore, delete, empty, original parent) and the
  audit log. Each type reports its collection, so Folder opens in the media
  list view. Deleting an item for good deletes its file; replacing a file
  deletes the old one.
- **Uploads become media** through the same intake as 6.3, which fills an
  Image's width, height, size and extension from the file, as Umbraco's
  `AutoFillImageProperties` does. The dropzone's lookups answer as Umbraco:
  which media type an extension becomes (`item/media-type/allowed`, with
  `matchedFileExtension`) and which types are folders.
- **Imaging.** `/media/…` understands the query Umbraco's ImageSharp URL
  generator writes — `width`, `height`, `rmode` (crop, max, stretch, pad,
  boxpad, min), `rxy`, `cc`, `format`, `quality` — and caches each variant on
  disk under `media/.cache`. Bun decodes, resizes and encodes; it cannot crop
  or pad, so those go through a small PNG codec on raw RGBA (`imaging.ts`), no
  dependency added. `GetImagingResizeUrls` answers thumbnails in the same
  vocabulary.
- **In pages:** the Media Picker resolves to `MediaWithCrops` (`url`,
  `cropUrl('alias')` or `cropUrl({ width, height })` around the focal point),
  `model.media(alias)` lists picks whatever the picker allows, the cropper's
  named crops cut by their stored coordinates, and rich text images and media
  links render. The published cache knows media, so a trashed item drops out
  of the pages that picked it.
- **Deferred:** media type import and export (`…/export`, `…/import`), with
  package import in the could-haves.

Pinned by `tests/media.test.ts`, `tests/imaging.test.ts` (crops and focal
points checked pixel by pixel) and `tests/media-rendering.test.ts`; in the real
backoffice by `tests/browser/media.browser.ts`: an image dropped in Media,
picked on a page and inserted into its rich text, published, and its 40×40
crop served.

**Then the storage seam**, so a site can move its media library off the local
disk. Umbraco abstracts this as `IFileSystem` with a `MediaFileManager` over it;
ours is narrower — `MediaStore` has `get`, `put`, `delete`, `list` and an
optional `publicUrl`, and that is everything the media library, the image
processor and the temporary-upload flow use. Three stores ship: the file system
(the default, unchanged on disk), **S3** through Bun's own client — so no
dependency, and any S3-compatible service works — and **Azure Blob Storage**
through the REST API with Shared Key or SAS auth, rather than pulling in
`@azure/storage-blob` for four verbs. A site picks one in `bunbraco.config.ts`
with `fileSystemMediaStore`, `s3MediaStore` or `azureMediaStore`, or leaves it to
`BUNBRACO_MEDIA_STORE`, which is what a container deployment wants.

Three consequences follow from the interface rather than from any one store, and
each is a small improvement on what was there:

- **Image variants cache in the store**, under `.cache/`, keyed by the source's
  etag — so replacing an original invalidates its crops with nothing tracking
  that, and one node's work serves every node. Before, the cache was local and
  keyed by mtime.
- **Temporary uploads go to the store**, under `.temp/`, so a load-balanced set
  can place an upload a different node received. Before, an upload was stranded
  on the node that took it.
- **Serving** streams the bytes by default, from the local file when the store
  has one so a disk-backed site keeps `sendfile`; a store that returns a
  `publicUrl` gets browsers redirected to a CDN or a presigned URL instead.

Pinned by `tests/media-store.test.ts`, which drives the whole media library —
upload, place, serve, crop, redirect, delete — against a store backed by a `Map`
with no file system behind it. That is the check that the seam is real rather
than shaped around the disk.

### WP-6.5 — Content editing completion — **done**

Move, copy, sort; the recycle bin (restore, delete, empty, original parent);
publish with descendants (with the task-result poll); scheduled publishing
and the version-cleanup job (respecting pinned events, designed in 5b) as
the first background jobs; preview (`preview` cookie, draft rendering for a
signed-in editor, `GetDocumentByIdPreviewUrl`); the Info panel: audit log,
referenced-by, notifications; domains and hostnames with culture routing;
blueprints. **Exit:** the Phase 4 page journey plus every action in the
document's action menu works in the real backoffice.

**Built:**

- **Move, copy, sort.** Move re-parents a branch and refuses a target below
  itself. Copy takes the current draft, unpublished, with a free name among
  its new siblings (`Home (1)`), with or without its branch. Sort takes an
  explicit order, or re-sorts every child by name or date.
- **Recycle bin.** Restore returns a branch to where it was trashed from, or
  to a chosen target, unpublished. Delete from the bin and empty the bin
  remove branches for good.
- **Publish with descendants** runs inline: its task is complete when first
  reported. It publishes the node, then its already-published descendants, or
  all of them when asked, shallowest first. A descendant that cannot publish
  is reported and its branch skipped.
- **Scheduled publishing** (migration 010, `content_schedule`): a future
  publish time schedules instead of publishing, an unpublish time schedules
  the expiry, and the variant reports both dates. A job runs every minute.
  Each schedule is claimed with `DELETE … RETURNING`, so on several nodes it
  still runs once.
- **Version cleanup**, hourly when `BUNBRACO_VERSION_CLEANUP=true`, off by
  default as in Umbraco. It keeps the current draft, the published version,
  pinned versions, everything newer than keep-all days, then each day's latest
  for keep-latest days; a content type's own policy wins. Values are
  append-only, so a pruned version's value row that a kept version still
  reads is re-pointed at the earliest kept version after it rather than
  deleted: every kept version reads exactly what it did.
- **Preview.** Asking for the preview URL sets `UMB_PREVIEW` and returns
  Umbraco's `preview?id=…`, which the backoffice's own preview app opens. It
  frames `/<document key>`; with the cookie and a signed-in editor the front
  end renders drafts, for routed URLs too. `/umbraco/PreviewHub` tells an open
  preview to refresh when its document changes; `DELETE /preview` leaves.
- **Culture and hostnames** (`domain`): a hostname, with an optional path
  prefix, roots the site at its document in its culture; the longest match
  wins and other hosts route without domains. A page under a hostname reports
  a protocol-relative URL (`//example.com/about`). Names are unique site-wide
  (409), cultures must exist (400).
- **Notifications** (`user_notification`): Umbraco's eleven actions, each
  user's subscriptions kept per page. Nothing is sent until the site has
  e-mail.
- **Blueprints:** create, edit, delete and move; folders; the tree and items;
  "Create Document Blueprint" from a page; the list the create dialog offers
  for a type; and the scaffold a new page starts from. They are stored as
  documents of their own object type (the repository takes a kind), never
  published or routed.
- **The Info tab:** the audit log from the page's versions, which record who
  made them; user names; a past version read as it stood (the rollback
  preview). Item ancestors for documents, types, data types and templates.
- **Server events for every change** (see `04-backoffice-hosting.md`), which
  the client's entity cache depends on.

**Public access landed with WP-6.8**, once there were members and member groups
for its rules to name. Referenced-by arrived with WP-6.9; the page's redirects
answer empty until the URL tracker does.

Pinned by `tests/content-editing.test.ts` (both dialects) and, in the real
backoffice, `tests/browser/document-actions.browser.ts`: every action in a
page's menu done through its dialog, plus save and preview and publish with
descendants from the workspace.

### WP-6.6 — Variants and localisation — **done**

Culture variants end to end (per-culture publish, fallback, mandatory
languages), segments, `GetDocumentByIdAvailableSegmentOptions`; dictionary
(8 ops); backoffice UI language files. **Exit:** a two-language site publishes
one culture, falls back for the other, and renders both under their domains.

**Built:**

- **Publishing by culture.** Each culture of a page records the publish it
  went live with and the name it had (migration 011). Invariant values read as
  of the latest publish, each culture's own values as of its own, so publishing
  Danish never publishes English's newer draft. A culture's state is its own:
  `PublishedPendingChanges` only when its values, the invariant ones or its
  name moved on since it was published. Every mandatory language must be
  published or be publishing (Umbraco's rule), only created variants publish,
  and unpublishing a mandatory culture unpublishes the page.
- **Rendering by culture.** The published cache holds one view per language:
  a page that varies by culture appears in each culture it is published in,
  with that culture's name, URL segment (its `umbracoUrlName`, else its name)
  and URL; an invariant page appears in every culture. A hostname serves its
  culture's view; without one the default language's. `model.value(alias,
  { fallback: 'language' })` follows each language's fallback chain; pickers,
  links and `nav` resolve within the page's culture; `GetDocumentUrls` lists a
  URL per culture. Preview renders the culture the backoffice asks for.
- **Dictionary** (migration 011, Umbraco's `cmsDictionary`/`cmsLanguageText`):
  the Translation section's tree, list (with translated cultures), items,
  create, edit, move (never below itself), delete with the branch, and `.udt`
  export and import in Umbraco's format — translations for languages the site
  lacks are skipped, as Umbraco does. Templates get `dictionary(key)`, in the
  page's culture then its fallbacks. Database only, not schema files: it is
  translators' content, like pages.
- **Segments:** without a segment provider Umbraco offers none, and so do
  `GetSegment` and `GetDocumentByIdAvailableSegmentOptions`; segment values
  still round-trip.
- **UI languages:** the backoffice's 28 language files ship with the vendored
  client and are served; a user's choice is saved by `PutUserCurrentProfile`.

Pinned by `tests/variants.test.ts` (both dialects) and `tests/dictionary.test.ts`;
in the real backoffice by `tests/browser/variants.browser.ts` — a page written
and published in English, then in Danish through the publish dialog, each
rendered under its hostname with Danish falling back to English — and the
dictionary step of `tests/browser/users.browser.ts`.

### WP-6.7 — Users and user groups — **done**

`user` (41) and `user-group` (8): CRUD, invite (degrading without email),
enable/disable/unlock, avatar, `user-data`, permissions and start nodes
**enforced** on every Management API call, MFA endpoints answering honestly.
**Exit:** an editor in a restricted group sees only their start node and
cannot delete.

**Built:**

- **Enforcement on every call** (`api-management/src/authorization.ts`),
  before a handler runs: the sections each area demands, from Umbraco's
  controller policies (a writer reaches content and reads document types but
  cannot change them; users need the Users section; the dictionary, Translation);
  then per-node rules for documents — each operation's verb on the node it
  names (Create on the parent, Move and Create on the target, Publish on the
  branch, Delete on the bin...) and path access below the caller's start nodes,
  with the languages a group may publish. Verbs are calculated as Umbraco does:
  per group, the nearest node on the path the group sets explicitly replaces its
  defaults (an empty set denies), unioned over groups. Start nodes combine as
  Umbraco's `CombineStartNodes`. Media checks path access. Refusal is a bare
  403. Administrators are not exempt, as in Umbraco; their group holds everything.
- **Trees for restricted users:** the root shows the way to each start node
  (`noAccess`), children below an unreachable node only the way on, and the
  recycle bins are empty without root access.
- **Users:** list and filter (text, groups, states, ordering), batch, CRUD
  with Umbraco's validation (username is e-mail, duplicates, a group
  required), states derived as Umbraco does (`Invited`, `LockedOut`, `Disabled`,
  `Inactive`, `Active`), disable/enable/unlock, delete only for users who never
  signed in, set groups, change password (your own needs the old one),
  reset (a generated password, which Create shows once), avatars (five crop
  sizes served by the imaging route), calculated start nodes, and API users'
  client credentials with the `client_credentials` grant. Only admins see or
  touch admins; the super user is hidden from everyone else; a non-admin may
  hand out only groups they hold and start nodes they reach.
- **User groups:** CRUD with sections, languages, start nodes, default verbs
  and granular permissions (document, property-value and unknown contexts,
  stored as Umbraco stores them); members added and removed; system groups keep
  their alias and cannot be deleted; the admin group is never emptied;
  non-admins see and edit only their own groups and join groups they create.
  Built-in groups and the super user now seed with Umbraco's keys.
- **User data** per user, **the current user** (permissions per node, profile
  language, configuration), **two-factor** answering that no provider is
  installed, and login providers empty until WP-6.8.
- **Invitations and resets** degrade without e-mail: with no `sendUserLink`
  `canInviteUsers` is false and Invite answers Umbraco's `CannotInvite`; with
  one (in development, the console) the link lands on our login page, which now
  verifies the token and sets the first password, and offers "Forgotten
  password?" when `allowPasswordReset` is on. `user_account.is_disabled` is
  renamed `is_locked_out`, which is what it meant.

Pinned by `tests/users.test.ts` and `tests/authorization.test.ts` (both
dialects); in the real backoffice by `tests/browser/users.browser.ts` — a user
created in the Users section, their group opened and saved, and that editor
seeing only their branch with no Delete offered — and
`tests/browser/login.browser.ts` — an invitation accepted and a forgotten
password reset on the login page. API coverage 339/513.

### WP-6.8 — Members, federated — **done but for the providers**

**Member types first**, ahead of the rest because saving one in the
backoffice hit `PostMemberType`. They follow media types: the same table told
apart by node object type (`MemberTypeContainer` added for their folders),
`schema/member-types/*.toml` under `[member-type]` — no templates, cleanup or
allowed children — and three property keys only member types accept:
`member-can-view`, `member-can-edit`, `sensitive`, stored in
`member_property_type` (migration 008; Umbraco's `cmsMemberType`). Umbraco's
default "Member" type arrives with members. Found on the way: a property
removed in the backoffice and re-added under the same alias (a new key) broke
the save on the unique index; the repository now reuses that row, retired or
live, so its values come back — the design's revival rule, which the file
sync already followed. Pinned by `tests/member-types.test.ts`.

**Then the store — migration 013.** A member is a node facet exactly like a
document (`node` + `content` + `content_version` + `member`), so member types,
properties and versioning are machinery that already exists; the columns are
Umbraco's `cmsMember` snake-cased, with the password columns nullable because a
member who only ever signs in through a provider has none. Member groups are
plain `node` rows with the MemberGroup object type and `member_group_member`
between them. `external_login` is polymorphic on `user_or_member_key` as
Umbraco's is, so federation built for members also serves back-office users;
`external_login_token` holds per-login tokens.

**Then member groups**, the whole seven the contract declares: CRUD, the item
lookup pickers use, and a flat tree root — no children, ancestors or siblings
operation exists, because a member group never has any. A name already taken is
a 400 `DuplicateName`, renaming a group to what it is already called is not.
Pinned by `tests/member-groups.test.ts`.

**Then members themselves**, all ten remaining operations: the editor
(`GET`/`POST`/`PUT`/`DELETE` plus both validate calls), the Members collection
(`filter/member`, which is Umbraco's own member filter with the same columns and
the same default order — username ascending), and the three lookups a member
picker makes. Members are not a tree: the contract declares no `tree/member`
operations, and `item/member/ancestors` answers an empty list per id because a
member never has any.

Three rules live in the adapter rather than the repository, because each is a
policy and not a fact about storage:

- **Uniqueness.** A duplicate username or e-mail is a 400, and the columns are
  case-insensitive in both dialects, so `A@b.com` clashes with `a@b.com`.
- **Sensitive values.** A member property marked `sensitive` is withheld from a
  user outside the Sensitive data group, compositions followed. The seeded
  administrator is in that group, as Umbraco's installer puts it, so the editor
  sees everything by default.
- **Passwords.** Plaintext reaches the adapter and no layer below it; a change
  rotates the security stamp.

`kind` is always `Default`: Umbraco reports `Api` only for a Delivery API
client-credentials member and `ExternalOnly` only for one in its lightweight
external-member table, and we have neither. `isTwoFactorEnabled` is always false
because no second factor is offered yet — reporting it honestly rather than
storing a flag nothing enforces.

**Umbraco's default "Member" type** now ships as a *system* type, like the
Folder, Image and File media types: alias `Member`, no properties (since Umbraco
18 the standard property stubs are empty and everything a member always has is a
column), ensured at every boot and exempt from schema retirement. Without it a
fresh install cannot create a member until someone writes a TOML file, which
Umbraco does not require.

**Front-end sign-in.** Umbraco has no fixed URLs for this — a site writes a
surface controller — so four endpoints are ours, under the fixed `/umbraco`
namespace rather than the movable backoffice path, because they belong to the
framework and not to the editor: `POST /umbraco/members/{login,logout,register}`
and `GET /umbraco/members/current`. A form post is answered with a redirect, a
JSON post with JSON, so one endpoint serves both a plain `<form>` in a template
and a `fetch` from the page.

A session is a **signed ticket in a cookie**, not a server-side session row: the
ticket names the member, its expiry and the security stamp it was issued
against, signed with HMAC-SHA256 over a key generated once into `key_value` and
so shared by every node. Nothing is stored, which suits a load-balanced set, and
because the stamp is checked on every request a password change or a lockout ends
every session that member had, immediately — which is how ASP.NET Identity's
security stamp works, without the framework. The ticket is signed and not
encrypted deliberately: it carries no secret, and tampering is the only threat.

Two decisions worth stating. **Registration is off by default** — an endpoint
that creates accounts is a decision a site makes, not one a framework makes for
it — and it takes a member type alias and default group names from config.
And a **`returnUrl` must be a local path**; an absolute or protocol-relative one
is ignored, which closes the open redirect a login form would otherwise be.

**Public access — migration 014.** Umbraco's `umbracoAccess` and
`umbracoAccessRule`, snake-cased. The rules are *values, not foreign keys* — a
member group's name or a member's username, as Umbraco stores them — because a
rule is evaluated against what a signed-in member carries, so renaming the group
is what breaks the rule, not deleting a row. Reading an entry back resolves each
name to the member or group the editor should show, and a name that no longer
resolves simply drops out, which is exactly what the rename means.

Enforcement is Umbraco's: a protected page is **rewritten** to its login or error
page, not redirected, so the visitor keeps the URL they asked for. The nearest
protected ancestor governs (resolved against `node.path`, not by walking
parents), the login and error pages render even when they sit inside the branch
they serve — without that exception the substitution would not terminate — and
the renderer caps substitutions at 8, as Umbraco does. A rule naming both groups
and members is refused as ambiguous, and one naming neither as empty; both are
Umbraco's own errors. Preview is exempt, since only a signed-in editor reaches it.

Templates receive the member as a prop alongside the model, with `roles` as group
*names* — the same currency the rules deal in.

Pinned by `tests/members.test.ts` and `tests/public-access.test.ts` (both
dialects), the latter asserting the body served at a protected URL for an
anonymous visitor, a signed-in outsider and a member of the group.

Still to come: **external identity providers** (OIDC/OAuth) linked to local
members with auto-linking. `external_login` is already there for them.
**Exit:** a page protected by a member group is served only after signing in
through an external provider.

**Decided for the provider work:** the integrations are typed config presets
exported from `bunbraco` — `entra(...)`, `awsIdentityCenter(...)` and a generic
`oidc(...)` — each knowing its issuer, scopes and claim mapping. Not separate
packages: the plan defers a plugin ecosystem, and a preset is an import rather
than an install.

### WP-6.9 — Cross-cutting

Relations and relation types, tags administration, redirect management (the
URL tracker on rename), search (`searcher`/`indexer`/`filter` over FTS5 and
`tsvector`), webhooks with a delivery log, the log viewer, health checks,
telemetry answering honestly. Then the could-haves in `06-features.md` — the
Delivery API first.

**Built so far — the log viewer.** The server logs through LogTape (chosen for
its Serilog-style message templates, with no dependencies of its own) into the
files Umbraco's log viewer reads: Serilog's compact JSON, one event per line,
`logs/BunbracoTraceLog.<machine>.<yyyyMMdd>.json`, with `SourceContext`,
`MachineName` and `ProcessId` as Umbraco enriches them. The viewer reads the
files of each day in the range (the last day by default), refuses ranges whose
files pass Umbraco's 100 MB cap, counts levels (not Verbose, as Umbraco),
groups by message template, and filters the log by a Serilog expression — a
subset covering the saved searches and the filter box, with Umbraco's fallback
to a text search for a plain word or anything that does not compile. Saved
searches are migration 012's `log_viewer_query`, seeded with Umbraco's; the
two that ask about Umbraco's own namespace and message template ask the same of
bunbraco's, and the two about Umbraco's `SortedComponentTypes` property are
left out. Server messages that went to the console — schema sync, imaging,
template errors, background jobs, the development 501 log — are now log events.
Pinned by `tests/log-viewer.test.ts` and, in the backoffice, the log viewer step
of `tests/browser/settings.browser.ts`.

**Built — references, and content type transfer.**

*What refers to what* answered an empty page until now, which told an editor
that nothing referenced a document they were about to delete. Umbraco keeps a
`umbracoRelation` row per reference, written on save; the answer here is derived
from the current property values instead, so it cannot go stale — a relation
table is only as good as the last save that maintained it — and needs no
migration. A picker stores `umb://document/<hex>` or a bare uuid, so both
spellings are matched, a node never counts as referring to itself, and
"referenced descendants" ignores references from inside the branch being
deleted. The cost is a scan of `property_value`, which is acceptable for an
editor asking what breaks. Pinned by `tests/references.test.ts`.

*Export and import* speak Umbraco's `.udt` XML, so a type exported from an
Umbraco site imports here and the other way round: `Info`, `Structure`,
`GenericProperties` and `Tabs`, with the root naming the kind. Aliases are the
currency — compositions, allowed children and templates all travel by alias,
because keys differ between sites. Creating from a file mints fresh container
and property keys, since the file's still belong to the type it came from;
updating keeps them, because the alias guard has proved the file describes that
type. `import/analyze` reports what an upload turns out to be before anything is
imported. The `schema` endpoints describe a type, and a data type's value, as
JSON Schema. Pinned by `tests/content-type-transfer.test.ts`.

**Built — redirects, and the URL tracker.** Taken first of what remained because
it is the only gap that breaks a site *after* launch and silently: renaming a
published page left its old URL a 404, with nothing in the backoffice to say so.

Migration 015's `redirect_url` is Umbraco's `umbracoRedirectUrl` widened twice, in
both cases for the configured rules rather than the tracked ones: a rule may match
an exact route, a subtree or a regular expression, and it may point at a document,
a path or an external URL. Umbraco resolves duplicate rows by taking the most
recent; here a rule is identified by what it matches — kind, pattern, hostname root
and culture, hashed into `match_hash` because a unique index cannot dedupe over
nullable columns — so re-registering a route replaces where it points instead of
stacking rows behind it. Same observable behaviour, bounded growth.

- **The tracker** (`packages/server/src/redirects.ts`) captures a branch's routes
  before a publish or a move and compares them after, which is the shape Umbraco's
  notification pair forces: a route comes from names and tree position and cannot
  be recovered once they have changed. Self and every published descendant, per
  culture. Recycle-bin moves record nothing, as upstream — a trashed page has no
  new URL. A reverted rename removes the rule that would point the live URL at
  itself. Tracked rules name the *document*, so two renames leave the oldest URL
  resolving to wherever the page is now rather than chaining 301s, and a rule whose
  page is unpublished stops matching instead of sending visitors nowhere.
  **Sorting is tracked as well, which Umbraco does not do**: under
  `HideTopLevelNodeFromPath` the first root page is `/` and the others are
  `/<segment>`, so re-ordering the roots moves them, and Umbraco's handler listens
  to publish and move only. The capture is by parent there, since the write is on
  the parent and the URLs that move belong to its children.
- **Configured redirects** are `redirect()` in `bunbraco.config.ts`, which Umbraco
  has no equivalent for — it expects a rewrite rule in front of the site. Three
  decisions, all taken deliberately: they are **synced into the database at boot**
  so the dashboard lists everything in force in one place (and the API answers 409
  rather than deleting one, because the next boot would put it back); they are
  matched **only once route resolution has found no page**, so a rule can sit in
  config for years without hiding live content; and a `{ document }` target is
  resolved per request, so it survives the page being renamed.
- **Matching** lives in the published cache, which already holds the route table
  and already gets dropped on a publish, a cache instruction or a schema change.
  The 301 carries the query string and is uncacheable, both as Umbraco sends them —
  the second because browsers cache 301s hard enough that a rename-and-revert
  would otherwise stick.
- **The dashboard** is Umbraco's own, in the Content section, plus the per-page
  Info tab list. All five `redirect-management` operations are real;
  `POST status` is an accepted no-op, which is what Umbraco made it in v17 when it
  moved tracking to configuration and deprecated the client's `setStatus`.

Pinned by `tests/redirects.test.ts` on both dialects: a rename, a move with its
branch, a root re-order, two renames in a row, a reverted rename, tracking off, a hostname scoping
a rule to one of two sites with the same path, one culture redirected without the
other, the three pattern kinds, a document target following a rename and going
quiet when unpublished, a live page beating a configured rule, the boot sync
removing a rule dropped from config, and the dashboard's list, filter, per-document
read and delete refusal. API coverage 426/513.

### WP-6.11 — The Library section (Elements) — **done**

The section whose Create dialog offered nothing but Folder. Umbraco 18 made
elements a first-class entity — `IElement : IPublishableContentService<IElement>` —
publishable, versioned content with no URL and no template, gathered in folders and
trashed into a bin of its own. 4 of 25 element operations were implemented; the
tree and its folders existed because a folder is a plain node.

**All 25 are now real, and `element-version` 4/4.** The work was mostly *not* new
machinery, which is the point: an element is a node facet exactly as a document is,
so `DocumentRepository` took `element` as a fifth `kind` — object type Element,
container ElementContainer, recycle bin `-22` — and inherited versioning,
publishing, validation, copy, move, restore and cleanup. What is new is
`adapters/elements.ts` (the port), `handlers/element.ts` (the 25 operations) and
migration 016's single row.

- **The editor**: create, read, save, `validate` (both calls), create-and-publish,
  update-and-publish, publish, unpublish, the published read, `configuration`.
  Draft saves stay permissive and publishing enforces `mandatory`, which is
  Umbraco's rule and the one documents already follow here.
- **The tree** mixes folders and elements in one listing. A folder reports
  `documentType: null` and a single `NotCreated` variant — the contract makes both
  nullable/valued precisely for that row — and an element reports its type and its
  variants' publish state. Ancestors, siblings, the item lookups a picker makes,
  and search.
- **Moving, copying, the bin**: move, copy (with a free name), move-to-recycle-bin,
  restore, empty, original parent, delete. **Folders move and trash too**, which no
  other area's folders do, so those two live on the element port rather than the
  shared `FolderPort`; the document repository's `move` refuses anything that is not
  an element, so a folder moves through the node repository with the same two rules.
- **History**: versions, a version read back, rollback, prevent-cleanup, and the
  audit log through the same shared helper documents and media use.
- **References** came free: the reference repository derives "what points at this?"
  from current property values and is generic over object type, so adding `Element`
  to its area list was one line.

The create dialog reads `document-type/allowed-in-library`, which was already
correct: Umbraco offers a type there only when it is *both* an element type and
flagged for the library. `apps/site` has no such type, which is why the dialog was
empty — correct behaviour with nothing behind it.

Pinned by `tests/elements.test.ts` on both dialects: the allowed-in-library list,
the mixed tree, ancestors/siblings/items/folder-items/search, the editor round trip,
the draft-permissive-publish-strict rule with its JSON-path errors, publish and the
published read against a newer draft, create-and-publish refusing before it creates,
move/copy/folder-move with the below-itself refusals, the bin through
trash → list → original parent → restore → empty, a trashed folder taking its branch
unpublished with it, versions/rollback/prevent-cleanup, the audit log, and the
reference endpoints answering.

**Rendering — done.** A published element is readable by a template, held in the
published cache, so publishing one means something a visitor sees and unpublishing
one drops it from the pages that picked it. Umbraco's selection editor turned out to
be a first-class `Umbraco.ElementPicker` rather than a repurposed tree picker; its
value is a bare `Guid[]`, not udis; it resolves by key and always yields a
collection; and an element not published in the ambient culture is dropped on read.
Umbraco seeds no data type for it, so our 37 built-ins needed no addition — a site
declares its own, as `tests/elements.test.ts` does.

Three things fell out cheaply because the shape already existed. Elements live in the
**culture views** rather than one global map, so the culture filtering Umbraco does
with an explicit `IsPublished(culture)` check is structural here — an element the
culture cannot see is simply not in its view. `loadElements()` reuses the query that
builds the content cache, because `loadPublished()` is keyed on the repository's own
object type and only ever needed `kind: 'element'` passing to it. And invalidation
was already in place: the element port writes a `{ elements: true }` cache
instruction on every change. `bunbraco generate` narrows a pick to its element type
from the picker's `allowedContentTypes`, reusing `TypedElement<T>`. The full design
is `05-rendering.md` → "Published elements".

API coverage 426 → **459/513**.

### What is still missing, ordered

The rest of WP-6.9 and the could-haves, ranked by what a running site actually
notices. Measured against the contract with `bun run coverage:api` and against
Umbraco's source for everything the contract does not cover.

**The Library section is now built** (WP-6.11 above): all 25 element operations,
`element-version` 4/4, and published elements readable by a template. That is where
most of the remaining gap used to sit.

**Then, in this order:**

| Gap | State | Why it ranks here |
| --- | --- | --- |
| E-mail | no sender; only the `sendUserLink` seam | Invitations answer `CannotInvite`, password reset needs the site to wire it, and the eleven notification subscriptions are stored and never delivered. Umbraco ships SMTP. Every flow degrades honestly, and none of them works. |
| Search over content | `LOWER(node.text) LIKE '%q%'` — names only | The FTS5/`tsvector` decision from `00-overview.md` was never built, so backoffice search cannot find a page by words in its body, and `searcher`/`indexer` (5 ops, rebuild included) are 501. Umbraco's Examine searches every property value. |
| External identity providers | tables exist, presets unwritten | WP-6.8's remainder: `entra()`, `awsIdentityCenter()`, `oidc()`. Members and backoffice users are local-only. |
| 2FA | endpoints answer "no provider"; the login path exists but is unreachable | Umbraco ships app-authenticator 2FA for both users and members. |
| Webhooks | 1 of 8 | No events → HTTP, no delivery log. |
| Delivery API | not started; no `packages/api-delivery` | The whole headless read API, API-key auth and the `Api` member kind. Outside the 513 because it is a separate contract, so coverage does not show it. The largest absence for anyone wanting headless. |

**Diagnostics and tooling**, none of which a visitor sees: health checks,
telemetry, profiling, `server/troubleshooting` and `server/upgrade-check` (0 of
11); package import/export (0 of 9, and media/member type `.udt` export still
deferred); relation and relation-type administration (2 ops — "referenced by" is
derived from current values instead, which cannot go stale but is not a relation
table); dynamic root pickers (2); and the odds and ends
`document/{id}/patch`, `object-types`, `data-type/{id}/is-used`,
`property-type/is-used`, `help`, `item/static-file`, `DELETE /preview`.

**Deliberate divergence, not gaps** — listed so they are not mistaken for one:

- The **install wizard** (3 ops) and the **upgrade endpoints** (2) answer 501 on
  purpose; `bunbraco init`, schema-as-code and `bunbraco upgrade` replace them.
  The real consequence is that there is no first-run browser experience, so a
  non-developer cannot stand a site up.
- The **template query builder** (3 ops) stays 501: it is Razor-specific.
- **Segments** round-trip but no provider ships, so personalisation is inert —
  exactly Umbraco's behaviour without a package.
- **snake_case** rules out importing an existing Umbraco database, **every save is
  a version** (Umbraco versions only on publish), and **rollback appends**.
- **Load balancing** goes through `cache_instruction` polling rather than
  Umbraco's distributed cache, and tokens are hashed database references, so
  there are no data-protection keys to share.

### WP-6.10 — SCIM provisioning (could-have, after 6.8)

**Umbraco has no answer here.** A case-insensitive search of the whole
`Umbraco-CMS` source for `scim` returns nothing, and none of the contract's 513
operations provision anything: the 37 member paths are backoffice CRUD. What
Umbraco federates is *authentication* — `MemberExternalLoginProviders` and the
polymorphic `external_login` table — so a member appears the first time they
sign in, and nothing ever tells the site they have left.

SCIM (RFC 7643 for the schema, 7644 for the protocol) is the other direction:
the identity provider calls us. That is what makes **deprovisioning** real, and
what lets group membership arrive before a first login rather than after it.
For a CMS whose protected pages are gated by member group, the difference is
whether revoking someone in Entra actually closes the door.

It fits our data model almost exactly. `external_member` — federated members
who are not content nodes — already carries `key`, `email`, `userName` and
`displayName`, which are SCIM's `id`, `emails[]`, `userName` and `displayName`;
member groups are SCIM `Group`s.

**Shape.** A router of its own at `/scim/v2/**`, outside the Umbraco contract,
so it cannot affect conformance:

- `GET|POST /Users`, `GET|PUT|PATCH|DELETE /Users/{id}`, the same for `/Groups`
- `GET /ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` — the discovery
  documents every provider fetches before it will enable provisioning
- bearer-token auth with a per-tenant token, not a backoffice session
- `filter=userName eq "x"` only: the one filter Entra and AWS Identity Center
  actually send, rather than the whole filter grammar
- `PATCH` with `op: add|remove|replace` over `path` expressions, which is the
  fiddly half of the spec and where most implementations are wrong

**Exit:** Entra's provisioning test succeeds against a running site, a user
assigned to an application appears as a member of the mapped group without
signing in, and unassigning them revokes access to a protected page.

Not before WP-6.8: provisioning needs something to provision.

### WP-6.12 — Import an existing Umbraco site — **built for schema, content and views**

`bunbraco import umbraco`: pointed at a backup of an Umbraco site, it first
produces a compatibility report listing what cannot be migrated — packages,
plugins, Razor views, custom code — and then writes a Bunbraco site: schema as
TOML, content as a bundle, a view stub per template, the media files. It converts
into the existing interchange formats rather than writing rows, so the import
itself is `start --bundle`.

It is two stages. A `.bacpac` is the primary input, and restoring one needs
.NET, so a standalone open-source TypeScript library,
`@kineco-au/bacpac-importer`, decodes it and writes a faithful copy to SQLite,
knowing nothing about Umbraco. `@bunbraco/import-umbraco` then reads that copy and
does everything Umbraco-specific. It is opt-in: the CLI loads it on demand, so no
site carries it unless it asks.

**Exit, met for Umbraco 17:** the Umbraco Commerce demo store — 33 content types,
436 nodes, a package installed — imports with no manual step, and every URL it
served answers 200 on the imported site.

**Not built:** members and users (with their password hashes), redirects,
protected pages and schedules are counted in the report and not imported.
Umbraco 15, 16 and 18 are accepted, with their two conversions tested against an
altered fixture, but no real export of any of them has been run. Versions below
15 are refused and told to upgrade with Umbraco first.

The design, the version analysis and what is left are in
[`16-umbraco-import.md`](16-umbraco-import.md).

This reverses "importing an existing Umbraco database" as a non-goal. The
snake_case decision still stands: the database is converted, never opened in
place.

### Decisions taken before WP-6.1 started

- **Folders live in the files.** A `folder = "Pages/Blog"` key on a document
  type's or data type's file; the sync creates the folder path in the tree,
  and the backoffice's folder actions write it. No database-only folders.
- **Media and member types are files too.** `schema/media-types/` and
  `schema/member-types/`, same vocabulary, same sync, same promotion.
- **Verification is API tests per endpoint** plus a manual checklist per
  package in `08-testing.md`. No browser tests until asked.

## Phase 7 — Hardening

Install and upgrade flows; concurrency and locking under load; version cleanup;
audit log; problem-details parity; a full Postgres parity run; performance pass on
the tree and the published cache.

**Exit:** the conformance suite is green against both dialects, and a fresh
install completes through the install wizard.

---

## Risks

**R1 — Contract fidelity.** 513 operations, and the client fails in
hard-to-diagnose ways on small shape mismatches. *Mitigation:* generate types from
the spec so drift is a compile error; validate every response against its schema
in test mode; consult `Umbraco.Web.UI.Client/mocks/` (an MSW mock server covering
~45 endpoint groups) whenever the schema is ambiguous.

**R2 — The login SPA is not on npm.** `src/Umbraco.Web.UI.Login` is private and
its build reaches into the client's source tree. *Resolution:* write our own login
page against the same token endpoints; the `<umb-auth>` contract is small.

**R3 — npm ships a non-runnable client.** *Resolved in Phase 0* — see
`04-backoffice-hosting.md`. `bun build` reconstitutes the `external/*` bundles,
UUI themes come from npm, and seven small static files come from the Umbraco
source tree.

**R4 — SQLite write concurrency.** Umbraco relies on DB-level locks around
content-tree mutation. *Mitigation:* WAL plus a single-writer queue on SQLite,
advisory locks on Postgres, both behind one lock abstraction from Phase 0.

**R5 — Reference-token semantics.** The client must never be made to call
`validateToken()` per request — it revokes the previous reference token and the UI
logs itself out at random. Our token store must match Umbraco's rotation
semantics.

**R6 — Monaco's web workers. Resolved in Phase 1.** A Bun bundler plugin
translates Vite's `?worker` and `?inline` import suffixes, and each monaco worker
is built separately. All 10 externals now bundle.

**R7 — The npm package contains build-time files.** `vite.config.js`,
`openapi-ts.config.js` and test helpers ship in the tarball and import build
tools, which is indistinguishable from a missing runtime dependency when scanning
imports. *Mitigation:* prune them from the served tree during vendoring, so the
scan only sees runtime code.

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
