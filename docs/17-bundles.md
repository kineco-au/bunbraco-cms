# Bundles

The backoffice's Bundles section — Umbraco's `Umb.Section.Packages`, renamed
below — covers two things that have nothing to do with each other, and this
document keeps them apart:

- **Created packages** — exporting a slice of this site as a file, which is the
  nine `package` operations in the Management API contract. All nine are
  implemented (`api-coverage.md`).
- **Extensions** — code someone else wrote, added to a site. This used to be the
  `App_Plugins` directory convention inherited from Umbraco; it is now npm
  dependencies, and `App_Plugins` has been removed.

## What the backoffice calls them

The section reads **Bundles**. One word for one thing: the artifact the builder
produces is a bundle ([`13-content-transfer.md`](13-content-transfer.md)), and
an installable extension is published to npm under the `bunbraco-bundle`
keyword, so both halves of the section hold the same kind of thing by name.

Its three views are named for what each one holds rather than for the section:
**Marketplace**, **Installed**, **Created**. Umbraco labels its marketplace view
"Packages", which under a section of the same name said nothing twice.

Three of those labels are dictionary keys, so the rename is an override in
`plugin/branding/localization-en.js` rather than a manifest:

| What reads it | Key or manifest |
| --- | --- |
| The section, in the nav | `sections_packages` |
| The button that starts a bundle, and the empty state beside it | `packager_createPackage`, `packager_noPackagesCreated` |
| The Marketplace, Created and Installed views | bunbraco's own `sectionView` manifests |

**A replacement `section` manifest would not have worked.** The nav lists
section manifests whose *alias* appears in the signed-in user's
`allowedSections` (`apps/backoffice/backoffice.context.js`), and the server
sends Umbraco's `Umb.Section.Packages`. A manifest under a bunbraco alias —
even one declaring `overwrites` — matches nothing, so the section would have
disappeared rather than been renamed.

### The Created view is a router, not a screen

Umbraco's Created view mounts its own overview at `overview` **and every
`package-builder` workspace** at `package-builder/create` and
`package-builder/edit/:unique`. Those two routes are the only way to reach the
builder from anywhere in the backoffice, so `plugin/bundles-created.js`
reproduces them exactly and replaces only the overview. A replacement that
rendered a list would have renamed the view and lost the builder;
`tests/bundles-backoffice.test.ts` asserts each of upstream's routes is still
declared here.

### The builder's two labels are corrected, not overridden

The builder workspace writes `Name of the package` and `Package Content` as
English in its template rather than as dictionary keys, so there is no key to
override and no manifest seam — it is one 431-line vendored element wired to
picker contexts. `plugin/branding/bundle-builder-labels.js` corrects both after
each render, the same way the client credential dialog's prefix is corrected,
and does nothing at all if upstream rewords either. That silence is the point:
the cost of a vendor bump is a stale label, never an error. The test asserts
both strings are still there to correct, so the bump is still noticed.

**What still says package.** Two toasts — `Package saved` and `Package
updated`. They are passed to the notification context from inside the builder's
private methods, which have no interception point, so removing them means
reimplementing the workspace. They are transient and they are the last of it.

The npm *identifier* keeps the name npm gives it — the Installed table's column
reads `npm package`, and an install still writes `package.json`. Renaming that
would make the screen disagree with every command it tells you to run.

### What stayed `Umb.`

Six identifiers in this repo wore `Umb.` and were invented here: the Forms
section alias and the five form permission verbs. They are `Bunbraco.` now, and
migration 026 rewrites the verbs already stored. Everything else spelled `Umb.`
is Umbraco's and names something upstream defines — including three that the
vendored *client* never mentions and that are Umbraco's all the same:

| Identifier | Why it stays |
| --- | --- |
| `Umb.DocumentRecycleBin.Restore` | Umbraco's verb for the recycle bin entity, alongside its other document verbs |
| `Umb.PropertyEditorUi.RichText` | the alias migration 009 migrates *away* from; renaming it would match no row |
| `Umb.PropertyEditorUi.TinyMCE` | what an imported Umbraco site's data says; renaming it would break the importer |

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

A `bundle` table rather than a file in the site directory: the definitions are
shared state, they page, and a file would be per-node in a system that keeps
everything else coherent across nodes. The columns match Umbraco's
`umbracoCreatedPackageSchema` one for one, which is why the table was first
called `created_package` too.

It costs two migrations, both shipping in 0.5.0:
`data/src/schema/created-packages.ts` creates it after `serverRoleMigration`,
and `data/src/schema/bundles-rename.ts` renames it to `bundle` and rebuilds the
unique index on `name`. A rename rather than an edit to the first: 022 has
already run everywhere, and rewriting it would leave those databases holding a
table the code no longer looks for, with no migration to say so.

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
| `GetPackageCreated` | paged from `bundle`, honouring skip/take validation |
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

- **Discovery** is a published keyword convention: `"keywords": ["bunbraco-bundle"]`.
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
- **A runtime install is client-side only.** A package whose code must run in
  the server process is a dependency plus a deploy — see
  [Part 3](#part-3--server-side-bundles), which is what that turned into.
  Loading third-party JS into a running node has no isolation story and a
  `role: web` node would never see it, so an install writes `package.json` and
  stops there. A package that installs but declares nothing is reported as
  exactly that rather than as a success.
- **Uninstall** is `bun remove`, the same path in reverse.

Supply chain: the install runs third-party JS in the backoffice origin with the
user's session. It is gated on the same permission as the Bundles section, the
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

### A file this site already has is not replaced without being asked

Every section an install writes is editable **in the backoffice**: a stylesheet
and a script through the Settings section, a template through the template
editor, a document type through `createSchemaFileWriter`. So an overwrite does
not destroy a file that came from a deploy — it destroys whatever somebody last
saved. And git cannot be assumed to be behind it: `git` is `undefined` by
default, a feature a site opts into.

So an install is **refused while any file would be replaced**, naming them, and
`--replace-files` is how someone says yes. On a fresh site every file is a
create, so the friction appears only where something would be lost. An identical
file is not a replacement.

### Undoing one

The content half is a transfer run, so `content revert <run>` takes it back as
any import. The files are not in that ledger — but they are not left to git
either. Before replacing a file, the install copies the original to
`.bunbraco/transfer/<runId>/replaced/<bundle path>`, with a record of which
files it created rather than replaced, and `content revert` puts the replaced
ones back and removes the created ones.

Two details that make that work:

- The copies are keyed by the file's **bundle** path, not its path on this site,
  so a revert re-derives the destination through the same section mapping and
  restores to where the file would go *now*.
- The run id does not exist until the content has imported, so the backups are
  staged under `pending-…` and moved once it has. A staging directory that was
  never promoted is an install whose content was refused after its files landed:
  it is left alone, because it holds the only copy of what was replaced, and the
  CLI prints where it is.

`.bunbraco/transfer/` is a sibling of `.bunbraco/views`, never inside it: the
views cache is rebuilt from `Views/` and cleared at boot, and these have to
outlive a restart to be worth taking.

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
| File safety and revert | `replacementsNeedingPermission`, `stageBackups`/`promoteBackups`/`restoreSectionFiles`, same file |
| Discovery and serving | `backoffice-host/src/extensions.ts`, wired through `static.ts` and `manifests.ts` |
| The marketplace and install | `server/src/marketplace.ts`, routed at `<backoffice>/bunbraco/api/bundles/*` |
| The two native views | `backoffice-host/plugin/bundles-marketplace.js`, `bundles-installed.js` |
| The App_Plugins notice | `server/src/extensions-notice.ts` |
| Server-side bundles | `server/src/bundles.ts`, wired in `server.ts`, `bundles` in `config.ts` |
| The redirects bundle | `packages/simple-redirects` — `src/index.ts` and `plugin/` |

Adding the migration needed `bun run release:version 0.5.0` first: `v0.4.0` was
tagged and `tests/migrations.test.ts` asserts `release <= VERSION`, so a
migration naming an unreleased version fails the suite rather than landing in
someone's `migration_history` as a release that was never cut (`AGENTS.md`).

## Testing

`tests/bundles.test.ts` covers the contract operations and the build. The
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

It also covers the two rules that keep an install from destroying work — which
file needs permission before it is replaced (including a schema file the
backoffice changed, and *not* an identical one), and that a revert puts back what
was replaced and removes what was created. `replacementsNeedingPermission` is
its own function rather than a condition inside the importer precisely so it can
be held to that.

`tests/content-bundle.test.ts` covers the format: a content-only bundle still
says version 1, a bundle with sections declares them, the integrity hash catches
an edited view, a declared file that is absent is reported, a path that climbs
out of the bundle is dropped, and a newer format is refused by name.

`tests/marketplace.test.ts` runs against a recorded registry and a stubbed
installer: the keyword search, the packument filter that drops keyword
squatters, the unreachable-registry case, name and version validation, and what
the user is told after an install. Nothing in the suite reaches npm.

`tests/server-bundles.test.ts` covers the mechanism on its own, with a stub host
and no database, because the things that must hold are properties of
`bundles.ts` rather than of any one bundle: an id or route path that could leave
the namespace is refused, a bad set fails the boot naming every problem at once,
`api/bundles/` is not claimed by `api/bundle/`, the section is checked before the
handler runs, a handler sees only the capabilities it declared in a frozen
object, and a throwing handler is a 500 that leaves the other bundles answering.

`tests/simple-redirects.test.ts` covers the redirects bundle end to end against a
real site, because the only assertion that proves the client, the routes, the
capability and core's matcher agree is that a rule typed through the API makes a
visitor get a 301. It also holds the confinement: a configured rule and a tracked
one are listed but refuse to be edited or deleted, `source` cannot be forged,
a manual rule survives both `syncConfigured` and a reverted rename, and the
precedence between the three sources is checked by what actually answers the
request.

Those fixture sites live under `output/` rather than the system temp directory —
a site's views cache has to resolve `bunbraco/jsx-runtime` by walking up to a
`node_modules` that carries it, which nothing outside the repository can do.

---

# Part 3 — Server-side bundles

Part 2 said a bundle that needs to run in the server process is "a dependency
plus a deploy" and left it there. This is that, made into something a bundle can
be written against: `bundles.ts` in `packages/server`, and
`@bunbraco/simple-redirects` as the first one.

## The objection, and what actually answers it

The original objection was specific, and it was right: loading third-party JS
into a running node has no isolation story, and a `role: web` node would never
see a runtime install. Neither is solved by a sandbox — Bun has no mechanism that
would make a hostile dependency safe inside this process.

What answers it is that **nothing here is discovered**. There is no
`BUNBRACO_BUNDLES` and no scan of `node_modules`; a bundle's server half runs
only because a site wrote this:

```ts
import { redirects } from '@bunbraco/simple-redirects'

export default defineConfig({
  bundles: [redirects()],
})
```

So the two halves of a bundle arrive by different routes on purpose:

| Half | How it arrives | What it takes |
| --- | --- | --- |
| The backoffice screen | discovered from the `bunbraco` field once the package is a dependency | `bun add`, no restart |
| The server endpoints | imported by name into `bunbraco.config.ts` | an edit, a review, a deploy |

That asymmetry is the whole security story. The dangerous path — someone clicks
*Install* in the Bundles section and third-party code is in the request path — is
not guarded, it does not exist. The safe path is a committed diff that reaches
every node, which is also what makes `role: web` coherent: the import is in the
site's code, so every node has it or none does.

A test holds this down rather than leaving it to the prose:
`tests/server-bundles.test.ts` asserts the default is `[]` whatever the
environment says, that no environment variable names a bundle, that discovery
parses JSON and never imports a dependency's module, and that the install path
runs the package manager and nothing of the package.

## What a wired bundle gets

A narrow interface, not the server:

```ts
export interface ServerBundle {
  id: string              // URL segment and log name
  name: string
  section: AppAlias       // what a caller must have access to
  capabilities: readonly BundleCapability[]
  routes: readonly ServerBundleRoute[]
}
```

- **Its own namespace.** Routes mount at
  `<backoffice>/bunbraco/api/bundle/<id>/`. The id is lowercase letters, digits
  and hyphens, so it cannot climb out of its segment however it is spelled, and
  each route path is validated as a plain path of segments with at most one
  `:name` each. Two bundles cannot claim one id.
- **No anonymous traffic and no self-granted access.** The server authenticates
  before dispatch and the registry checks the declared section before calling
  anything. There is no per-route override and no public route, so a bundle has
  no way to widen its own authorisation — the test asserts the handler is never
  reached by a caller without the section.
- **Only the capabilities it declared**, as a frozen object. No `Db`, no config,
  no filesystem. A capability is an interface `bundles.ts` owns and implements,
  so the reachable surface is what core decided to expose rather than what the
  bundle can find.
- **Its own failures.** A handler that throws becomes a 500 and a log line naming
  the bundle; the request path stays up and the other bundles keep answering.
- **Nothing on a `web` node.** These are backoffice endpoints, so they mount only
  where `servesBackOffice`.

### What a handler knows about the caller

`context.principal` is the authenticated backoffice user, already holding the
section the bundle declared. Everything a finer check needs is on it:

| Field | What it is |
| --- | --- |
| `id`, `email`, `userName`, `name` | who they are |
| `isAdmin` | the administrator group, which bypasses verb checks everywhere else |
| `allowedSections` | section aliases, bare or `Umb.Section.*` depending on where they were read |
| `permissions` | verbs granted globally by their groups |
| `groupKeys`, `groups` | their groups, and each group's verbs for a per-node check |
| `startNodes` | where they may work in the document, media and element trees |
| `languages`, `hasAccessToAllLanguages` | the content languages they may write |

`@bunbraco/server` re-exports `Principal`, `AppAlias`, `hasSection` and
`hasCultureAccess`, so a bundle needs that one dependency rather than reaching
into `@bunbraco/api-management` for them:

```ts
import { hasSection, type Principal } from '@bunbraco/server'

const mayPublish = (principal: Principal) =>
  principal.isAdmin || principal.permissions.includes('Umb.Document.Publish')
```

Use `hasSection` rather than comparing the strings: `allowedSections` arrives in
either spelling, and it normalises both.

### Deliberately not offered

Migrations, raw SQL, and writing the site's files. A bundle that needs a table of
its own needs a release of this CMS: a migration arriving with a dependency is a
schema change no `migration_history` can account for, and the version checks in
`AGENTS.md` exist precisely so that cannot happen quietly.

A capability is therefore the unit of negotiation. Adding one is a deliberate act
in core — which is the point, because it is also the moment somebody decides what
a third party may touch.

## The first bundle: Simple Redirects

`@bunbraco/simple-redirects` adds what the Umbraco redirect packages add over
Umbraco's own Redirect URL Management dashboard: an administrator **creating and
editing** a rule, rather than only listing and deleting the ones a rename
recorded.

The engine is not in the bundle. Matching, the URL tracker and the `redirect_url`
table are core ([`05-rendering.md`](05-rendering.md)), and they work without it.
What the bundle adds is the third `source`:

| Source | Who owns it | Precedence |
| --- | --- | --- |
| `config` | `bunbraco.config.ts`, synced at boot | first |
| `manual` | an administrator, through this bundle | second |
| `tracked` | the URL tracker, on a rename or move | last |

That order falls out of `ORDER BY source` — `config` < `manual` < `tracked` is
alphabetical — which is why the repository says so out loud rather than leaving a
future reader to think it a coincidence. It is also the right order: a rule in
the site's code outranks one somebody typed, which outranks one the CMS wrote by
itself.

**Writing is confined to `manual`.** The capability sets the source itself and
refuses a key belonging to any other, so the bundle cannot forge a configured
rule, delete one the file owns, or interfere with the tracker. Posting
`source: 'config'` stores a `manual` rule, which is tested. Deleting a configured
rule answers 409 and says the file owns it — the honest answer, because the next
boot would put it back.

Two existing behaviours had to be checked rather than assumed, and both already
held: `syncConfigured` deletes only `source = 'config'` rows, so a deploy does not
remove a typed rule, and `removeSelfReferencing` touches only tracked rows, so a
rename reverted does not remove a manual rule for the same route.

### The screen

A `menuItem` in Settings' Advanced menu plus the `workspace` it points at — the
pattern Umbraco's own log viewer uses, so no vendored element is replaced to put
a screen in Settings, and the lesson from Part 1 about `overwrites` does not
apply.

It lists **every** rule in force, not only the ones it can change: a screen that
hid the configured and tracked rules would be lying about what the site does when
a URL is requested. Each row carries its source, and edit and delete appear only
where the server would allow them.

The editor offers everything the matcher supports — exact, starts-with and
regular-expression matching, a page, a path or an external URL as the target, the
four redirect status codes, and an optional culture. A screen quietly weaker than
the config file is the failure mode worth guarding against, because it is
invisible until somebody needs the option that is missing; a test asserts each
kind is offered.

One validation is load-bearing rather than cosmetic: a regular expression is
compiled when it is saved. The matcher runs it against the path of every request
that resolved to nothing, so a pattern that throws there would 500 the public
site rather than the screen that stored it.

### The screen's own view of the user

The client half is an ordinary backoffice extension, so it uses the client's own
mechanisms — there is nothing bundle-specific here.

**Declaratively**, through `conditions` on the manifest. The extension is simply
not registered when the condition fails, which is better than a screen that
renders and then refuses:

| Condition | Gates on |
| --- | --- |
| `Umb.Condition.SectionUserPermission` | access to a section (`match` is the section alias) |
| `Umb.Condition.CurrentUser.IsAdmin` | the administrator group |
| `Umb.Condition.CurrentUser.GroupId` | membership of a named group |

**Imperatively**, by consuming `UMB_CURRENT_USER_CONTEXT` from
`@umbraco-cms/backoffice/current-user`. Its members are observables —
`isAdmin`, `allowedSections`, `permissions`, `fallbackPermissions`,
`hasAccessToSensitiveData`, `languages`, `hasAccessToAllLanguages`, the start
nodes — read the way `UmbLitElement` reads any context:

```js
import { UMB_CURRENT_USER_CONTEXT } from '@umbraco-cms/backoffice/current-user'

this.consumeContext(UMB_CURRENT_USER_CONTEXT, (context) => {
  this.observe(context?.isAdmin, (isAdmin) => {
    this._mayEdit = isAdmin === true
  })
})
```

**None of this is a security boundary.** A client-side check decides what to
draw; the server decides what happens. Every bundle route is gated by the host
before dispatch, and a bundle that shows a button to the wrong person has a
cosmetic bug, not a hole.

### Calling an endpoint with the caller's identity

Authentication here is an **httpOnly cookie**, not a bearer token a script can
read — `UmbAuthContext.getLatestToken()` returns `[redacted]` under cookie auth,
by its own documentation. So a bundle's client calls its own endpoints as a
same-origin request and lets the browser carry the session:

```js
const response = await fetch(`${base()}/rules`, {
  credentials: 'include',
  headers: { accept: 'application/json' },
})
```

`base()` is read from `<base href>` rather than hard-coded, because the
backoffice path is configurable (`BUNBRACO_BACKOFFICE_PATH`) and the plugin path
moves with it — see `plugin/redirects-client.js`.

The identity needs no passing: the cookie is the session, the server resolves it
to a `Principal`, and the same `Principal` is what reaches the handler. There is
no way for a client to claim a different one.

For the **Management API**, prefer a vendored repository — `UmbPackageRepository`
is how `plugin/bundles-created-overview.js` reads created bundles — because it
carries the auth and the contract types with it. A direct `fetch` works on the
same `credentials: 'include'` footing.

### How it is published

It ships in the same release as everything else, at the same version, through
`release:publish` — `publishablePackages()` is the whole of `packages/` bar
anything private, so the bundle joined the set by existing.

Two things it needs that an ordinary package does not:

- **The `bunbraco-bundle` keyword.** npm indexes keywords and not custom fields
  (Part 2), so a bundle without it is invisible in the Bundles section however
  correct the rest of it is. `tests/packaging.test.ts` asserts it, and that every
  asset the `bunbraco` field points at exists and is inside `files`.
- **A place in `OPT_IN`.** The packaging suite otherwise requires every published
  package to be a dependency of `bunbraco`, and a bundle is by definition
  something a site chooses.

### A template may wire one

`bunbraco init --template demo/harbourstone` scaffolds a site with this bundle
already wired, because `template.json` says so:

```json
"bundles": [{ "package": "@bunbraco/simple-redirects", "import": "redirects" }]
```

`init` then writes the dependency into the site's `package.json` **and** the
import and `bundles: [redirects()]` into its `bunbraco.config.ts`. That is the
same opt-in, not a way around it: the line lands in the site's own committed
file, where it is visible in the first diff and removable by deleting it. A
template cannot wire a bundle into a site without the site's code saying so.

## Out of scope

- Reading an Umbraco-authored package, `.zip` or `.udt`. Importing *types*
  already works (`GetImportAnalyze` and the content-type importers).
- Package migrations, which this document argues should never exist here — and
  which Part 3 declines to let a bundle bring either.
- Isolating a bundle's server code. There is no sandbox and none is implied: a
  bundle you import is code you run, exactly like any other dependency in the
  file. What the design buys is that importing it is a decision somebody makes
  and commits.
