# Schema as code

Document types, data types, languages and the other *structural* definitions of a
site live in plain-text files in the site's repository, not in the database. The
database's schema tables become a cache of those files, synchronised at boot.

This is the largest deliberate departure from Umbraco, where these definitions
exist only in the database — which is why Umbraco sites cannot diff their schema
in git, why environments drift, and why an ecosystem (uSync, Deploy) exists to
paper over it.

## The rule: files change with a deploy, data changes with editing

Three placements, decided by one question — what changes it?

- **Files** (`schema/`, `components/`, `bunbraco.config.ts`): changes with a deploy.
- **Database**: changes with editing, or is per-person, per-page or per-environment.
- **Derived**: rebuildable from one of the above; authoritative nowhere.

The full inventory of Umbraco's metadata, with where Umbraco keeps each today
and where it sits here:

### Content structure

| Metadata | Umbraco today | Here | Notes |
| --- | --- | --- | --- |
| Document types, incl. element types | DB: `cmsContentType`, `cmsPropertyType`, `cmsPropertyTypeGroup`, compositions, allowed children, allowed templates | **Files** `schema/document-types/` | first, in 5b |
| Media types | DB, same tables | **Files** `schema/media-types/` | with Media |
| Member types | DB, same tables plus `cmsMemberType` per-property flags | **Files** `schema/member-types/` | with Members |
| Data types | DB: `umbracoDataType` — editor, UI alias, storage type, config | **Files** `schema/data-types/`; the core set is built in | 5b |
| Version cleanup policy | DB: `umbracoContentVersionCleanupPolicy` per type | **Files**, as `cleanup.*` on the type | |
| Templates | Both: `cmsTemplate` row and `~/Views/{alias}.cshtml`; the file wins | **Files** `Views/*.tsx`; the row is derived | done |
| Partial views, scripts, stylesheets, static files | Files under `~/Views` and `wwwroot` | Files | the backoffice editors write them |
| Document blueprints | DB: content nodes of the blueprint object type | DB | they carry content values and are created from pages |
| Form definitions | DB only, irreversibly since v9 | **Files** `schema/forms/` | the largest divergence from Umbraco Forms; entries stay in the database ([`18-forms.md`](18-forms.md)) |

### Localisation

| Metadata | Umbraco today | Here | Notes |
| --- | --- | --- | --- |
| Languages | DB: `umbracoLanguage` | **Files** `schema/languages.toml` | 5b |
| Dictionary | DB: `cmsDictionary`, `cmsLanguageText` | DB | translators work in production, where files are read-only; `bunbraco dictionary export/import` seeds environments — built, `13-content-transfer.md` |
| Domains and hostnames | DB: `umbracoDomain`, per node | DB | environment-specific — dev and prod differ — so not part of the deploy unit |
| Backoffice UI strings | Files: the client\'s `assets/lang/*.js`; sites add theirs in an npm extension | Files | client-side only |

### Security and identity

| Metadata | Umbraco today | Here | Notes |
| --- | --- | --- | --- |
| User groups: sections, permissions, granular permissions, languages | DB: `umbracoUserGroup` and four join tables | **Files** `schema/user-groups/` | roles are deploy-bound |
| Start nodes per group | DB: columns on `umbracoUserGroup` | Files, by content key | optional |
| Start nodes per user | DB: `umbracoUserStartNode` | DB | per-person |
| Users, sessions, tokens, 2FA secrets | DB | DB | data, not metadata |
| External login provider configuration | Files and code: `appsettings.json`, `AddBackOfficeExternalLogins()` | **Files** `bunbraco.config.ts` | |
| External login links | DB: `umbracoExternalLogin` | DB | per-person |
| API keys, Delivery API access | Files: `appsettings.json` | Files `bunbraco.config.ts` | |
| Member groups | DB: nodes of the member-group object type | **Files** `schema/member-groups.toml` | roles, referenced by public-access rules |
| Public access rules | DB: `umbracoAccess`, `umbracoAccessRule`, per node | DB | a per-page editorial decision |

### Relations, integration, operations

| Metadata | Umbraco today | Here | Notes |
| --- | --- | --- | --- |
| Relation types | DB: `umbracoRelationType` | **Files** `schema/relation-types.toml` | |
| Relations, tags, redirect URLs | DB | DB | generated from content |
| Webhooks | DB: `umbracoWebhook` plus events, headers, content-type keys | **Files** `schema/webhooks/` | integration is deploy-bound; edited through write-back |
| Package manifests and extensions | Files: a `bunbraco` field in each dependency's `package.json` | Files | already how they are discovered |
| Created packages | Both: `umbracoCreatedPackageSchema` and an exported zip | DB, exporting to a file | out of scope |
| Log viewer saved searches | DB: `umbracoLogViewerQuery` | DB | user-created |
| Health check, imaging, request-handler and content settings | Files: `appsettings.json` | Files `bunbraco.config.ts` | |
| Notification subscriptions | DB: `umbracoUser2NodeNotify` | DB | per-person, per-page |
| Content schedules | DB: `umbracoContentSchedule` | DB | editorial |
| Migration state | DB: `umbracoKeyValue` | DB, plus the ledger | |

### Derived — rebuildable, authoritative nowhere

| Artifact | Umbraco today | Here |
| --- | --- | --- |
| ModelsBuilder output | Files: generated `.cs` from DB types | `schema/generated/*.d.ts` from the TOML; commit it so a schema change and its type change are reviewed together |
| Published cache | Both: `cmsContentNu` and NuCache files | memory |
| Search index | Files: Examine on disk | FTS5 / `tsvector`, rebuildable |
| Media files | Files `wwwroot/media/` plus `umbracoMediaVersion.path` | files plus the DB path, as Umbraco |
| The built backoffice | a NuGet static-assets package | `@bunbraco/backoffice-dist` |

Three placements differ from Umbraco\'s and deserve a word. **Member groups and
webhooks** move to files because they are structure — roles and integrations —
and are exactly what drifts between environments today; both stay editable in
the backoffice through write-back. **Dictionary stays in the database** even
though it looks like structure, because translators work in production, where
schema files are read-only. **Domains** are the one thing that is deploy-bound
but *not* part of the deploy unit, because they differ per environment.

Data types matter here because a property names its data type by alias, so the
alias must exist. The core set ships built in and needs no file; a site adds its
own in the same format.

## Format: TOML

Chosen over YAML (whitespace significance), JSON (verbose, comment-hostile) and
KDL (unfamiliar). Bun parses TOML natively, with no dependency.

Two consequences shape the format:

1. **Comments are not preserved.** No JavaScript TOML library round-trips them
   (`smol-toml` and `@iarna/toml` drop every comment; `@ltd/j-toml` keeps inline
   ones but reformats), and Bun has no serialiser at all. Since the backoffice
   writes these files, a `#` comment would be lost on the next save from the UI.
   So the format carries **two text fields instead**: `description`, which the
   backoffice shows to editors (Umbraco already has it), and `notes`, which is for
   the people maintaining the file and is shown in the type editor. Both survive
   every round trip. Comments are permitted but stripped on write.
2. **Nesting is kept shallow.** TOML's arrays of tables (`[[tab.property]]`) are
   the construct non-developers get wrong, so the vocabulary is designed to need
   at most two levels, and the canonical writer always lays them out the same way.

## Layout

```
schema/
├── schema.toml            the schema version the running site is at
├── document-types/
│   ├── home-page.toml
│   └── text-page.toml
├── media-types/
├── member-types/
├── data-types/
│   └── short-text.toml
├── languages.toml
├── relation-types.toml
├── user-groups/
│   └── editors.toml
└── migrations/
    └── 0007-split-summary.ts    site-authored value migrations, see 10-packaging-and-upgrades.md
```

One type per file. The filename is free; the alias inside the file is canonical.
The canonical writer names files as the kebab-case of the alias.

`schema/schema.toml` is one line that matters a great deal:

```toml
[schema]
version = "2.0"
```

It declares the version the running site is at, and every element's `since` is
compared against it (below). It lives here, not in `package.json`, because the
schema files are the deploy unit and not every site bumps its package version.
It changes rarely and only to express intent. Ordering between deployments
comes from a separate **revision** supplied at deploy time and never committed
— see "Versioning without friction" in `10-packaging-and-upgrades.md`.

## Writing one

The files are the source, so somebody has to write the first one. Two commands
do it rather than leaving a new site to copy a type out of the documentation:

```bash
bunbraco schema new document-type article --at-root
bunbraco schema add-property article summary --type textarea --mandatory
```

`schema new` writes the type with its keys already in it — so the file passes
the production rules on the first deploy rather than needing a development sync
to fill them in — and the `components/<alias>.tsx` it declares. `--element` writes a
Library element type, which has no URL and so no template. Media and member
types are written with nothing assumed about what belongs on one.

`add-property` appends a property to a tab, because order in the file is order
in the editor, and refuses an alias the type already has. Both then apply the
files, through the same sync a boot runs — which means in production both are
subject to the same gate as any other schema change: a version bump, or a newer
revision, or the sync refuses and says so.

The file is re-emitted from the model, exactly as `schema rewrite` does, so a
comment in it is not kept. The command says so when it has removed any, and
`--dry-run` prints the file instead of writing it.

## A document type

```toml
[document-type]
key = "8c3a6c2e-5d4f-4d3e-9d6d-2b7f8a1c9e10"
alias = "homePage"
name = "Home Page"
description = "The site landing page"
notes = "Owned by marketing. Talk to Sam before adding tabs."
icon = "icon-home"
allow-at-root = true
varies-by-culture = false
compositions = ["seoFields"]
allow-children = ["textPage", "newsPage"]
templates = ["homePage"]
default-template = "homePage"

[[tab]]
name = "Content"

[[tab.property]]
alias = "title"
name = "Title"
description = "Shown as the page heading"
type = "textstring"
mandatory = true
mandatory-message = "Please add a title"

[[tab.property]]
alias = "bodyText"
name = "Body"
type = "richtext"

[[tab]]
name = "SEO"

[[tab.property]]
alias = "metaDescription"
name = "Meta description"
type = "textarea"
regex = "^.{0,160}$"
regex-message = "Keep it under 160 characters"
```

Reference:

| Key | Meaning | Default |
| --- | --- | --- |
| `key` | Stable identity, a uuid. **Written by tooling on first sync** — leave it out when creating a file by hand | generated |
| `alias` | Machine name; must be unique across all types | required |
| `name`, `description`, `notes`, `icon` | As shown in the backoffice; `notes` is for file maintainers | `icon-document` |
| `allow-at-root`, `is-element`, `allow-in-library` | Flags, as Umbraco | `false` |
| `varies-by-culture`, `varies-by-segment` | Variance flags on the type | `false` |
| `compositions` | Aliases of types whose properties are inherited | `[]` |
| `allow-children` | Aliases permitted beneath this type | `[]` |
| `components`, `default-component` | Component aliases — the path under `components/`, so `pages/homePage` is `components/pages/homePage.tsx` | `[]` |
| `collection` | Alias of a data type used as the list view | none |
| `cleanup.prevent`, `cleanup.keep-all-newer-than-days`, `cleanup.keep-latest-per-day-for-days` | Version cleanup policy | global |
| `since` | The schema version this type goes live in; pending until then — see below | stamped by tooling |

A property: `alias`, `name` required; `description`, `notes`, `type` (a data type
alias, required), `mandatory`, `mandatory-message`, `regex`, `regex-message`,
`varies-by-culture`, `varies-by-segment`, `label-on-top`, and **`default`**.

`default` matters beyond convenience. When a required property is added to a
type that already has content, existing pages have no value for it. With a
`default`, the pre-upgrade check can fill them in mechanically; without one,
each page needs a person (`10-packaging-and-upgrades.md`). Declaring a default is
how a schema author keeps their change from becoming someone else's task.

### `since` — the version an element goes live in

Types, properties and data types may carry `since = "2.1"`. The running site
compares it against `schema.toml`'s `version`; anything newer is **pending**:

| Concern | Pending element |
| --- | --- |
| Backoffice editor | shown, editable, badged *goes live in 2.1* — so it can be filled in ahead of the deploy |
| **Validation on save and publish** | **not enforced** — a pending mandatory property never blocks a publish on the live site |
| Rendering and the Delivery API | excluded from the published model, even if a template asks for it |
| Create menu | a pending type is hidden until it is live |

This exists because the pre-upgrade check creates new elements on the live site
early, so that people can fill them in before the deploy
(`10-packaging-and-upgrades.md`). Without gating, a new *mandatory* property
would block every publish of an existing page from the moment it was created.

You rarely write `since` by hand. The database row for every element carries
the exact `(version, revision)` of the deployment that created it — stamped by
the boot sync or by `upgrade check --fix` — and that is what a node compares
against its own. Write `since` in a file only to make a change go live *later*
than the deployment that introduces it. Nothing is written back into files for
this, and nothing is committed by a pipeline.

As built in 5c: the row carries `since_state_id` (the state that created it)
and `since_version` (the file's `since`); `pendingUntil` in `@bunbraco/data`
is the one comparison. A pending property's name arrives in the editor as
`Title (goes live in 2.1)` with the rule in its description — no client code
— and publish validation, the published model and the create menu all consult
the same flag.

Framework-shipped schema (the built-in data types) uses the same key compared
against the framework version. `until` is the symmetric marker for the contract
side — *removed in 3.0* — and belongs to the same mechanism.

`schema/media-types/*.toml` defines media types with the same vocabulary
under `[media-type]`, minus `templates`, `default-template` and `cleanup`.
Aliases are unique across document and media types together (Umbraco's
`content_type.alias` is), and compositions and allowed children stay within
a kind.

`folder = "Pages/Blog"` places a type (or a data type) in the settings tree.
It is organisation, not meaning: the sync creates the path, the backoffice's
folder actions rewrite it, and it is the only thing the tree needs.

A group outside any tab is a top-level `[[group]]` with `[[group.property]]`
entries; Umbraco's built-in media types each carry one.

`schema/member-types/*.toml` defines member types under `[member-type]`: no
`templates`, `default-template`, `cleanup` or `allow-children`, and three
property keys no other kind accepts — `member-can-view`, `member-can-edit`
and `sensitive`.

Media types come in two kinds. **Folder, Image and File** are system types:
shipped with the framework, always present, not deletable, alias fixed. A
site needs no file for them; a file with the same alias *and key* overrides
one, and export writes that file only once the type differs from what ships.
**Video, Audio, Article and Vector Graphics** are ordinary site files —
`bunbraco init` writes them — which a site may change or delete.

A tab is `[[tab]]` with `name` and optional `alias`. A **group** inside a tab is
`[[tab.group]]` with its own `[[tab.group.property]]` entries — the one place a
third level exists, and only for types that use Umbraco's tab-within-group
layout. Ungrouped properties are top-level `[[property]]`.

Order in the file is the order in the editor; explicit `sort-order` is not needed.

### An element type

An element type is a document type with `is-element = true` — Umbraco's own model,
kept because the contract has no element-type entity at all: zero of its 513
operations mention one, and the only element-awareness anywhere is an `isElement`
filter on `item/document-type/search`. So there is one table, one alias space and one
editor, a document type may compose from an element type, and the Element Picker's
"accepted types" setting is the document-type picker with `onlyPickElementTypes`.

Two flags, not one, and deliberately so:

| | |
| --- | --- |
| `is-element = true` | a property bag with no URL — what a block editor holds |
| `allow-in-library = true` | *also* offered in the Library's Create dialog |

Most element types want the first and not the second: they exist for block editors
and would only clutter the Library. That is why `is-element` does not imply
`allow-in-library` — the two say different things, and collapsing them would lose
real information. `apps/site` has one of each: `quote.toml` carries both,
`bullet-list.toml` only the first.

**The keys a route needs are refused on an element type.** `templates`,
`default-template`, `allow-at-root` and `allow-children` all belong to a type that is
addressed by a URL and lives in the content tree; an element type is neither.
Declaring them is a validation problem naming the file and the key, rather than
something silently dropped, because a file that says one thing while the editor shows
another is worse than an error. A media-type file rejects its inapplicable keys at
parse, since they are not in its vocabulary at all; here they are valid keys made
invalid by a flag, so the rule lives in `validateSchemaSet`.

The save path normalises to match: ticking *Is Element Type* on a type that already
had a template drops the template, the default, allow-at-root and allowed children,
so the file the backoffice writes cannot be one the next boot refuses. Pinned by
`tests/content-types.test.ts` and `tests/elements.test.ts`.

## A data type

```toml
[data-type]
key = "…"
alias = "shortText"
name = "Short text"
notes = "Use for headings and labels"
editor = "Umbraco.TextBox"
editor-ui = "Umb.PropertyEditorUi.TextBox"

[data-type.config]
maxChars = 80
```

`config` is the editor's configuration, keys as the property editor defines them.
Built-in data types (`textstring`, `textarea`, `richtext`, `numeric`, `trueFalse`,
`datePicker`, `dropdown`, `contentPicker`, `tags`, `imageCropper`, `upload`,
`label`) need no file; a file with the same alias overrides the built-in.

## Languages

```toml
[[language]]
iso = "en-US"
name = "English (United States)"
default = true
mandatory = true

[[language]]
iso = "da-DK"
name = "Danish"
fallback = "en-US"
```

## Templates

A template's definition *is* its file: `components/<alias>.tsx`. No TOML. The display
name comes from an optional `export const name = 'Home Page'`; the layout chain
from `export const layout = 'siteLayout'`, as today. The database row is derived
and exists only so the backoffice's template tree and document-type template
picker have something to list.

## Synchronisation

Files are the source of truth; the database's schema tables are a cache. The
naive version of that — every node syncs its files at boot and files win — is
wrong in a multi-node deployment, so the design is version-gated and locked.

### When sync runs

| Trigger | Where | Applies |
| --- | --- | --- |
| Boot | every node, after framework migrations | yes — under a distributed lock, version-gated |
| File change | development only, single node | yes |
| Backoffice write-back | development only | writes the file; the watcher syncs it |
| `bunbraco schema sync` | a deploy pipeline step | yes; with `BUNBRACO_SYNC_SCHEMA_AT_BOOT=false`, nodes then only record their state |
| Production | — | files are read-only; schema changes arrive by deploying files |

The last row keeps multi-node coherent: in production the only way schema
changes is a deploy, and a deploy carries a version.

### The algorithm, one node

```
1. take the distributed lock          Postgres advisory lock; SQLite is single-node
2. read schema_state                  { version, hash, synced_at, synced_by }
3. parse and validate the file set    whole set; fatal on error, with file and line
   compute its version (schema.toml) and an order-independent content hash
4. compare
     files.version <  db.version   -> SKIP, log "compatibility mode", run on the DB as-is
     files.version == db.version
        hash equal                  -> SKIP, already applied
        hash differs                -> development: apply
                                       production: REFUSE, "schema changed without a version bump"
     files.version >  db.version   -> APPLY
5. apply in one transaction, in dependency order (data types, then types in composition order)
     diff by key: create and update; delete only with --force-delete
     stamp `since` = files.version onto anything new
6. write schema_state { version, hash, now, node }
7. append a cache instruction: schema changed
8. release the lock
```

Sync writes rows only, never DDL — types are data in this model — so step 5 is
an ordinary transaction on both dialects.

### Four rules that make it safe across nodes

**The schema version is monotonic, and a node with older files never writes.**
During a rolling deploy, node A (files at 2.1) syncs and moves the database to
2.1; node B (still at 2.0) boots, sees a newer database, skips, and runs in
compatibility mode — treating 2.1's new elements as pending via `since`, exactly
as if `upgrade check --fix` had created them early. If the deploy is rolled
back, every node has 2.0 files, all skip, and the 2.1 rows sit pending and
harmless until a later roll-forward. No flip-flop is possible, because the only
node allowed to write is one whose files are at least as new as the database.

**Production requires a version bump for any schema change.** Same version,
different hash, in production: refuse to boot, naming the files that differ.
In development it simply applies. This makes the first rule airtight and gives
`bunbraco schema check` something concrete to enforce in CI — files parse, keys
present, version bumped when content changed.

**Keys are written in development and required in production.** Writing a
generated `key` back into a file is a development convenience; a production
node cannot write files. So `schema check` fails any file without a key, and a
key is never minted on a production node — which is what stops two nodes from
minting different keys for one alias.

Write-back changes the files after the sync hashed them, so the sync re-hashes
the in-memory set once the keys are in and updates the `schema_state` row; a
backoffice save does the same after writing its file. Either way the next node
to compare sees the files as already applied rather than as an unversioned change.

**Expand and convert roll; only contract waits.** `since` gates *new* elements,
removal is retirement (below), and a value migration appends versions an old
node never reads — so none of them breaks a rolling deploy. Only a purge of
retired data or a column drop is a true contract step, and it belongs to a
later release, once no node reads the old shape. Changing an existing element's constraints — toggling `mandatory` —
applies at once; the pre-upgrade check covers the data side, and the brief window
in which an old node validates against the new rule is the same window Umbraco
has.

### Removal is retirement; data is never lost

Removing a property from a file does **not** delete anything:

- The sync sets `retired_at` on the property type row (an additive column). Its
  values, in every version of every document, stay exactly where they are.
- A retired property is invisible: not in the editor, not validated, not
  rendered, not in the Delivery API — the pending treatment, plus not editable.
- **Reintroducing the property revives it.** By `key` when the file still has
  one. When a hand-edited file re-adds the alias *without* a key, the sync
  matches a retired property of that alias on the same type, revives it, and
  writes its key back — so "I deleted it; put it back" simply works. If it
  returns with a different data type, `check` flags a data-requiring change,
  and the old values are still there, in the old storage column, to migrate.
- **Purge is separate, explicit and rare**: `bunbraco schema purge
  --older-than 90d` deletes retired property types and their data. It is a
  contract step — ledgered, shown by `upgrade --plan`, never automatic.

Types are stricter, because hiding whole pages is a content decision rather than
a schema one: a type file disappearing while content of that type exists still
refuses to boot, as above, unless `bunbraco schema sync --force-retire-types`
retires it deliberately. Its documents stay where they are and still load —
moving them to the recycle bin is a content decision, made in the backoffice.

### Only a node at the current state may write

Reads are safe across versions because values are append-only and an older node
reads as-of its own schema state (`02-data-model.md`). Writes are not, so they
are gated: every write transaction checks the latest `current` `schema_state`
row atomically and is refused with 409 if the database is ahead of the node.
An old node then switches itself to read-only and reports unhealthy. `check
--fix` creates elements under a *prepared* state, which does not gate, so old
nodes stay writable while editors fill those elements in; `upgrade` makes the
state current, and that one row update is the cut-over.

### Cache coherence

Each node caches its content types and its published content in memory; after
one node syncs, the others are stale. Umbraco solves this with a polled
`umbracoCacheInstruction` table. This slice adds the equivalent:

- `cache_instruction(id, kind, payload, created_at)` — appended by whatever
  changes shared state: schema sync, publish, unpublish. Every node polls with a
  cursor of the last id it processed and reloads the affected cache. Postgres
  `LISTEN/NOTIFY` is the low-latency upgrade later; on SQLite, which is single
  node, it is a no-op.
- `server(node_id, last_seen, version)` — node identity for `synced_by` and the
  ledger.
- `schema_state` — the single row read in step 2.

Publishing needs the same instruction path for the published cache, which is
why it lands here rather than with widening. As built: `syncSchema`, `publish`
and `unpublish` append an instruction stamped with the node id; every server
polls from the id it saw at boot (2 s in development, 5 s in production), skips
its own instructions, drops the published cache for the rest, and touches its
`server` row on each pass. `tests/schema-boot.test.ts` runs two servers on one
Postgres database through exactly this.

### The other direction

`bunbraco schema export` writes the database's current definitions as canonical
files. It is how an existing site adopts schema-as-code, and how the Phase 4
fixtures moved to files in 5b. Built-in data types are exported only when the
site changed their editor or configuration; a data type created in the
backoffice has no alias, so export derives one from its name and records it.
Export never deletes a file.

## The backoffice writes files

The document-type editor keeps its UI unchanged; its save handler writes the
`.toml` file instead of the database row, and the sync picks it up. That is what
keeps the editorial workflow: non-developers use the interface they know, and the
output is a diffable text file that developers review like any other change.

- Files are always written in the canonical layout by our own serialiser (about
  a hundred lines for a fixed vocabulary; it also avoids the quote and blank-line
  churn of general-purpose TOML writers). Comments are stripped; `notes` is not.
- Writing is enabled in development. In production the schema directory is read
  only and the editor shows "defined in `schema/document-types/home-page.toml` —
  change it in source control", unless `BUNBRACO_SCHEMA_WRITABLE=true`.
- A save validates the whole schema set before writing, so a change that would
  break another file is refused in the UI with the same messages boot would give.
- As built: document types, data types and languages are all written by
  their editors (WP-6.2). A data type saved in the backoffice gets an alias
  derived from its name, once; a built-in gets a file only when it is changed
  from its shipped definition. Folder actions and moves rewrite every file
  from the database, since a folder path is part of the file.

## Consequences for the rest of the system

- **The content-type repository becomes a cache writer.** `ContentTypeRepository.save`
  still exists; it is called by the sync, not by the API. The
  `document-type` API endpoints read from the cache and write to files.
- **User schema migrations are file diffs, plus migrations when data must
  move.** Renaming a property alias, changing a data type, removing a tab — all
  reviewable in git, and subject to the same expand/contract rules as the
  framework's own migrations. A change that needs values moved or computed is
  accompanied by a value migration in `schema/migrations/`, written once and run
  in every environment (`10-packaging-and-upgrades.md`). Removing a property
  leaves its stored values in place until a cleanup job runs, so it can be
  reverted.
- **Generated TypeScript types fall out for free.** The files are already the
  definition; `bunbraco generate` emits `schema/generated/content-types.d.ts` so
  a template can be typed as `PageProps<HomePage>`. This replaces the ModelsBuilder
  idea from `06-features.md`.
- **A framework upgrade that changes the vocabulary rewrites the files.** Because
  we own the canonical writer, `bunbraco upgrade schema` can migrate every file
  to the new vocabulary, and the result is a reviewable commit.

## Schema as code

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
rules — and the `components/<alias>.tsx` it points at, then applies it. `--element`
writes a Library element type instead, which has no URL and so no view.
`add-property` appends one property and applies that; it re-emits the file
canonically, as `schema rewrite` does, so a comment in it is not kept and the
command says so. `--dry-run` prints the file instead of writing it.
