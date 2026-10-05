# Packages

The backoffice's Packages section covers two things that have nothing to do with
each other, and this document keeps them apart:

- **Created packages** — exporting a slice of this site as a file, which is the
  nine `package` operations in the Management API contract. All nine are
  implemented (`api-coverage.md`).
- **Extensions** — code someone else wrote, added to a site. This used to be the
  `App_Plugins` directory convention inherited from Umbraco; it is now npm
  dependencies, and `App_Plugins` has been removed.

## What the section used to do

Nothing routed the `package` operations, so each fell through to the router's
default (`api-management/src/router.ts`) and answered 501. Three fire on section
load — `configuration`, `migration-status`, `created` — so the section raised an
error toast, and the Marketplace view sat on its spinner forever waiting for a
`marketplaceUrl` that never arrived.

---

# Part 1 — Created packages

## The artifact: a created package *is* a bundle

There is one artifact format, and it is the bundle
([`13-content-transfer.md`](13-content-transfer.md)). A created package is a
bundle that carries its own structure — so one writer produces it, one reader
validates it, one manifest covers it and one importer applies it.

It is **not** an Umbraco package: an Umbraco install cannot read it, and that is
a deliberate trade for carrying everything the builder UI offers using exporters
that already exist and are already tested.

```
package.zip
├── bundle.json            the manifest: what this is, and which sections it carries
├── nodes/<uuid>.json      picked content, media and element nodes   ┐
├── blobs/<key>            the media bytes                          │
├── schema/*.toml          types and languages, canonical TOML       │ each
├── views/<alias>.tsx      templates                                 │ optional
├── partials/…             partial views                             │
├── styles/…               stylesheets                               │
├── scripts/…              scripts                                   │
└── dictionary.udt         dictionary items                          ┘
```

**The section names are logical, not the destination's directory names.** A site
holds its templates wherever `viewsDir` points, so the artifact says what a file
*is* and the importer decides where it goes — `partials/` lands in
`<viewsDir>/Partials`, `styles/` in `stylesheetsDir`. A bundle built against one
site's layout therefore installs into another's, which a hard-coded `Views/`
would have broken.

### What the manifest adds

A bundle carrying sections declares them in `carries`, and the integrity hash
covers every one — so a half-copied package is refused rather than half applied,
exactly as a missing blob already was. It also carries `label`, the package's
name, so a downloaded artifact still knows what it is; without it two downloads
are distinguishable only by filename, which is the first thing to be lost.

A content-only bundle still says `formatVersion: 1` and carries no `carries`
key, so it is byte-for-byte what it was and an older node still reads it. Only a
bundle with sections says 2, which an older node refuses by name — "upgrade
bunbraco to import it" — rather than failing an integrity check it cannot
explain.

Three existing exporters compose it, and the build writes no new serialization
format of its own:

| Half | Comes from |
| --- | --- |
| Content, media, elements, blueprints, media bytes | `exportBundle` (`transfer/src/export.ts:165`) then `writeBundle` (`write.ts:149`), which returns exactly the `BundleFile[]` a zip wants |
| Document, media and member types, data types, languages | `exportSchemaSet` (`schema/src/export.ts:188`) and the writers behind `writeSchemaFiles` (`:331`) — canonical TOML, the same files `schema/` holds |
| Templates, partial views, stylesheets, scripts | read through `FileSystemPort` (`api-management/src/ports-files.ts`) |
| Dictionary items | `dictionaryToUdt` (`server/src/dictionary-transfer.ts:31`) |

`exportSchemaSet` exports the whole schema, so it needs a variant — or a filter
over its result — that takes the aliases the definition selected. That is the
only new code on the schema side.

### Three things the build decides, which are not obvious

**The two child-node flags are honoured separately.** `contentLoadChildNodes`
and `mediaLoadChildNodes` are independent booleans in the contract, and elements
have no such flag at all, but `descendants` is a property of a whole export. So
the picks are exported in up to three groups and the resulting sets are merged
into one bundle — nodes deduped by key, counts recomputed, dependencies and
selector unioned. Passing one flag for all three would mean that asking for a
media folder's children quietly dragged a content page's children along too.

**Member types are never carried.** The builder has no picker for them and the
contract's definition model has no field, so there is nothing to select.

**An unchanged built-in data type is not carried either**, because
`exportSchemaSet` does not write files for built-ins
([`09-schema-as-code.md`](09-schema-as-code.md)) — every site already has them,
so a file would ship something the destination already satisfies. Picking one is
allowed and carries nothing.

The `bundle.json` inside is a real transfer bundle, so the content half of a
package is loadable by the importer that already exists. The schema half is
canonical TOML, so it is applied by copying it into `schema/` and running the
sync that a deploy already runs. Nothing here needs a bespoke installer.

### Zipping

No dependency. Bun's `node:zlib` provides both `deflateRawSync` and `crc32`
(verified), which is everything a zip writer needs — roughly 60 lines for local
headers, the central directory and the end record. It belongs in
`packages/server/src/zip.ts` with its own unit test, because a zip we write
wrongly fails in the user's unzip tool rather than in our suite.

## Where definitions live

A `created_package` table, matching Umbraco's own `umbracoCreatedPackageSchema`
rather than a file in the site directory: the definitions are shared state, they
page, and a file would be per-node in a system that keeps everything else
coherent across nodes.

It costs a migration — `data/src/schema/created-packages.ts`, registered in
`schema/plan.ts` after `serverRoleMigration`, shipping in 0.5.0.

Columns follow the contract's model: `id`, `name`, `content_node_id`,
`content_load_child_nodes`, `media_ids`, `media_load_child_nodes`,
`element_ids`, and the alias/path lists — document types, media types, data
types, templates, partial views, stylesheets, scripts, languages, dictionary
items. The lists are JSON text; they are read and written whole and never
queried into, so a column each would be columns for nothing.

## The zip is built on download, never stored

`GetPackageCreatedByIdDownload` serializes and zips on the spot. The definition
is the only stored state.

This is the difference that matters in practice: a stored artifact goes stale
the moment someone edits a document type it carries, and a user who downloads it
a week later gets something that no longer matches the site. Building on demand
cannot be stale, needs no blob storage, and works from any node. `packagePath`
in the response is a derived filename rather than a real path.

## The nine operations

| Operation | Answer |
| --- | --- |
| `GetPackageCreated` | paged from `created_package`, honouring skip/take validation |
| `PostPackageCreated` | insert; 400 on a name collision |
| `GetPackageCreatedById` | the definition, 404 otherwise |
| `PutPackageCreatedById` | update |
| `DeletePackageCreatedById` | delete |
| `GetPackageCreatedByIdDownload` | build and stream the zip |
| `GetPackageConfiguration` | `{ marketplaceUrl }` — see Part 2 |
| `GetPackageMigrationStatus` | `{ total: 0, items: [] }`, honestly |
| `PostPackageByNameRunMigration` | 404 for every name |

### The last two are a deliberate divergence

Umbraco's package migrations are C# migrations shipped inside a package and run
against the site's database. Nothing in this CMS carries them: extensions are
client-side (Part 2), and schema changes travel as TOML through a deploy. So
there is no such thing as a package with a pending migration here, and the
honest answers are an empty page and a 404 — not a stub standing in for work
that is coming.

Both are also about to stop being called at all: the Installed view that reads
them is replaced in Part 2.

---

# Part 2 — Extensions

## Why `App_Plugins` goes

It is a .NET-era convention — a directory of unmanaged files, baked into the
image (only `cms_media` is a volume, `compose.yaml:107`), with no version, no
dependency resolution and no record of where anything came from. npm already
solves all four, and the site already has a `package.json` the CLI scaffolds.

**The client does not care.** Checking the vendored backoffice's eight
`App_Plugins` references: `appendCacheBust` stamps `?umb__rnd=` only on
`/app_plugins/`-prefixed URLs and returns anything else unchanged;
`server-extension-registrator` prepends the server base URL to whatever the
manifest declares; the third is a deprecation warning string. Nothing dispatches
on the path. The manifest is the contract.

This repo already proves it: the framework's own extensions serve from
`/bunbraco-plugin` (`backoffice-host/src/paths.ts:45`) and are registered
exactly like an `App_Plugins` package.

### What removal touched

| Place | Change |
| --- | --- |
| `backoffice-host/src/static.ts` | the serving branch, replaced by `resolveExtensionFile` |
| `backoffice-host/src/manifests.ts` | `collectManifests` now takes the discovered extensions |
| `server/src/config.ts` | `appPluginsDir` and `BUNBRACO_APP_PLUGINS_DIR` are gone |
| `server/src/ports.ts`, `server.ts` | wiring, now an `ExtensionRegistry` |
| `cli/src/templates.ts` | stopped scaffolding `App_Plugins/.gitkeep` |
| `tests/` | views, backoffice-host, api-handlers |
| `docs/` | 00, 01, 04, 06, 07, 09, 10, 14, 16 |

`packages/import-umbraco` keeps reading `App_Plugins` — it is reading a *foreign*
Umbraco site's layout during an import, which is unrelated and stays.

Removal is complete, with no fallback. The boot logs a warning when a non-empty
`App_Plugins` directory exists, naming the replacement, so nobody's extensions
vanish without explanation (`server/src/extensions-notice.ts`); the warning goes
at 1.0.

## `package.json` is the source of truth

A site's extensions are its dependencies. Discovery reads the site's
`package.json`, resolves each dependency, and reads a `bunbraco` field from the
dependency's own `package.json`:

```json
{
  "name": "@acme/seo-tools",
  "bunbraco": {
    "id": "Acme.SeoTools",
    "extensions": [
      { "type": "dashboard", "alias": "Acme.Dashboard.Seo", "element": "dist/seo.js" }
    ]
  }
}
```

One file, no second artifact, and discovery reads a file it is opening anyway.
Asset paths are relative to the package root; the server rewrites them to its
own URL space, so a package never hard-codes a site path.

Resolution goes through Bun, not a `node_modules/<name>` string join, so
workspaces, hoisting and scoped names all work.

Discovery stays bounded: declared dependencies only, not a walk of
`node_modules`, which also means a transitive dependency cannot inject a
backoffice extension into a site that never asked for one.

### Serving

`/packages/<name>/<path>`, following the existing plugin branch in `static.ts`
exactly — `safeJoin` into the resolved package directory, `no-cache`. The
`?umb__rnd=` stamp is lost, which costs nothing: the framework plugin already
lives without it on the same header.

### Caching

`discoverManifests` currently hits the filesystem on every
`GET /manifest/manifest` and that is load-bearing — it is why an extension
appears without a restart. Reading a handful of `package.json` files per request
is a little more work than one `readdir`, so discovery memoizes and the install
endpoint invalidates. The uncached behaviour must survive in development, where
an author editing a local extension expects a reload to show it.

## Finding packages on npm: discovery and declaration are different jobs

The `bunbraco` field is **not searchable**. Tested against the registry:
`text=bunbraco:true` returns zero results and no error — npm's search indexes
`keywords:`, `author:`, `maintainer:` and `scope:`, and nothing else. A custom
field cannot be queried.

But a packument *does* preserve custom top-level fields (confirmed: `oclif` on
`oclif@6.0.2`, `packageManager` on `netlify-cli`). So:

- **Discovery** is a published keyword convention: `"keywords": ["bunbraco-package"]`.
  It is the only thing npm will index, so it is a publishing requirement, and
  `docs` and the package template say so.
- **Declaration** is the `bunbraco` field, which the server reads after install.

The two combine into a free quality gate: the marketplace searches the keyword,
then reads each hit's packument and offers only the ones that actually declare
`bunbraco`. One cheap HTTP call per hit, no tarball download, and a package that
squats the keyword without declaring anything never reaches the list.

The gap this leaves: a package that declares `bunbraco` but forgets the keyword
is invisible to search. Install by exact name is therefore always available as
its own input, independent of the listing.

## The marketplace

`www.npmjs.com` sends `x-frame-options: SAMEORIGIN` (tested), so an npm search
URL cannot be iframed — the Umbraco design does not transfer. Instead, the
framework plugin ships a native section view that `overwrites`
`Umb.SectionView.Packages.Marketplace`, which the plugin manifest already does
for other extensions (`Umb.Dashboard.UmbracoNews`). No iframe, a real list, and
an install button.

It is fed by a server-side proxy rather than a browser fetch: it works where the
browser cannot reach npm, keeps the backoffice making same-origin requests only,
caches briefly, and keeps the keyword in config. `marketplaceUrl` from
`GetPackageConfiguration` stays in the contract and points at that view, so a
site that wants the Umbraco marketplace back can set it.

`Umb.SectionView.Packages.Installed` is overwritten too — it is built around
pending package migrations, which do not exist here. The native view lists the
declared `bunbraco` dependencies with their versions.

## Runtime install

`bun add <name>@<version>` in the site directory, as a subprocess. Bun resolves,
verifies and writes `package.json` and `bun.lock` correctly, which matters more
than avoiding a subprocess: the committed result is byte-for-byte what a
developer would have produced by hand. Fetching tarballs ourselves would mean
hand-maintaining a lockfile, and a lockfile maintained badly is worse than none.

Then discovery is invalidated and the next manifest read picks the extension up.
No restart.

**`package.json` is the install ledger.** There is no separate record of what was
installed at runtime, because the dependency list already is one. "Incorporate
this into future deployments" is therefore just committing the two changed files,
and the install response carries the dependency line itself — the range as
`bun add` wrote it and the version it resolved to — so the view shows exactly
what there is to commit.

### What it cannot do, stated plainly

- **It is per-node and ephemeral.** `node_modules` lives in an image layer, so a
  redeploy loses the install until the dependency is committed, and in a
  load-balanced set only the node that served the request has the files. The UI
  says so on success rather than implying permanence.
- **It needs a writable site directory and network egress.** Both fail cleanly:
  a read-only filesystem and an unreachable registry each get a specific error,
  not a subprocess stack trace.
- **Client-side extensions only.** A package whose code must run in the server
  process is a dependency plus a deploy, because loading third-party JS into a
  running node has no isolation story and `role: web` nodes would never see it.
  A package that installs but declares nothing is reported as exactly that
  rather than as a success.
- **Uninstall** is `bun remove`, the same path in reverse.

Supply chain: the install runs third-party JS in the backoffice origin with the
user's session. It is gated on the same permission as the Packages section, the
resolved version is recorded, and nothing is fetched outside the registry.

---

## Installing one

A package is a bundle, so it installs through the bundle's own commands — there
is no second importer:

```
bunbraco bundle check  <dir>      # read-only: what it would do here
bunbraco bundle install <dir>     # apply it
```

`bundle` is the artifact's name and `install` reads better for one that brings
its own structure, but these are aliases: `content check` and `content import`
are the same operations on the same artifact, and still work. A bundle applies
whatever it carries by default — that is the point of carrying it — with
`--no-schema` and `--no-files` to decline a half.

### The order is forced, and so is where the check happens

Content naming a type the bundle brings cannot pass a check until that type
exists. So the structure has to land before the content is checked — which means
a blocking schema change has to be caught **before the first file is written**,
or a refused install leaves a half-applied site behind.

That is why the check runs against an **overlay**: a copy of the site's
`schema/` with the bundle's files laid over it. The site's own directory is not
touched until it is known the schema can apply. An install whose schema would
need data work is refused with nothing written.

Then: schema files → `schema/`, then the sync a deploy already runs → views,
partials, styles and scripts into the site's configured directories → dictionary
items → content, through the importer that already existed.

Schema is applied by **writing the files and syncing**, never by writing the
database directly. The file is the truth and the database follows it
([`09-schema-as-code.md`](09-schema-as-code.md)), so an install cannot produce a
database its files do not describe, and what it installed is reviewable in a
diff afterwards.

### What reverts, and what does not

The content half is recorded as a transfer run, so `content revert <run>` takes
it back exactly as any import. The **files are not in that ledger**: they are in
`schema/` and the views directory, where the repository owns them, so git is
their revert. That split is the schema-as-code rule, not an omission — but it
does mean "undo this install" is two actions, and the CLI says which files it
wrote so the second one is possible.

### Known rough edge

A re-install rewrites a schema file that the sync had annotated with assigned
keys, so the sync runs again and re-assigns them from the database. It converges
— the type is matched by alias when the file carries no key, so it is updated
and never duplicated, which `tests/bundle-install.test.ts` holds it to — but a
repeat install is not a silent no-op the way re-importing unchanged content is.

## What shipped where

| Piece | Where |
| --- | --- |
| The nine operations | `api-management/src/handlers/package.ts`, `ports-packages.ts` |
| Definitions | `data/src/schema/created-packages.ts` (migration, release 0.5.0), `data/src/repositories/created-packages.ts` |
| The build | `server/src/adapters/packages.ts` — composition of `exportSchemaSet`, `exportBundle`/`writeBundle`, `FileSystemPort` and `dictionaryToUdt` |
| The zip | `server/src/zip.ts` |
| The format | `transfer/src/model.ts` (`carries`, `label`, sections), `write.ts`, `load.ts` |
| The installer | `cli/src/operations/sections.ts`, wired into `contentCheck`/`contentImport` |
| Discovery and serving | `backoffice-host/src/extensions.ts`, wired through `static.ts` and `manifests.ts` |
| The marketplace and install | `server/src/marketplace.ts`, routed at `<backoffice>/bunbraco/api/packages/*` |
| The two native views | `backoffice-host/plugin/packages-marketplace.js`, `packages-installed.js` |
| The App_Plugins notice | `server/src/extensions-notice.ts` |

Adding the migration needed `bun run release:version 0.5.0` first: `v0.4.0` was
tagged and `tests/migrations.test.ts` asserts `release <= VERSION`, so a
migration naming an unreleased version fails the suite rather than landing in
someone's `migration_history` as a release that was never cut (`AGENTS.md`).

## Testing

`tests/packages.test.ts` covers the contract operations and the build. The
content assertion is a round trip: build a zip from a definition, unzip it,
write the bundle out and load it through `loadBundle` — so the package is proved
to carry a real bundle rather than a file of the right name.

`tests/zip.test.ts` reads each archive back through its central directory, the
way an unzip tool does, rather than through the writer's own assumptions; a
wrong offset or size is a test failure instead of a corrupt download. It covers
an empty entry, incompressible bytes that must be stored rather than grown, a
non-ASCII path and determinism.

`tests/extensions.test.ts` covers discovery (including a transitive dependency
that declares an extension and must be ignored), asset-path rewriting, the
memoizing registry, and serving — a path escaping the package root and a
dependency that is not a declared extension are both refused, so `/packages/`
cannot be used to read `node_modules`.

`tests/bundle-install.test.ts` covers the installer: each section mapping onto
this site's directories, that a plan writes nothing, create vs overwrite vs
unchanged, the overlay schema check, declining either half, and that applying
twice converges on one type rather than duplicating it.

`tests/content-bundle.test.ts` covers the format: a content-only bundle still
says version 1, a bundle with sections declares them, the integrity hash catches
an edited view, a declared file that is absent is reported, a path that climbs
out of the bundle is dropped, and a newer format is refused by name.

`tests/marketplace.test.ts` runs against a recorded registry and a stubbed
installer: the keyword search, the packument filter that drops keyword
squatters, the unreachable-registry case, name and version validation, and what
the user is told after an install. Nothing in the suite reaches npm.

Those fixture sites live under `output/` rather than the system temp directory —
a site's views cache has to resolve `bunbraco/jsx-runtime` by walking up to a
`node_modules` that carries it, which nothing outside the repository can do.

## Out of scope

- Reading an Umbraco-authored package, `.zip` or `.udt`. Importing *types*
  already works (`GetImportAnalyze` and the content-type importers).
- Server-side extensions, per above.
- Package migrations, which this document argues should never exist here.
