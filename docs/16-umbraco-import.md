# Importing an Umbraco site

**Status: built for schema, content, views and media, against Umbraco 17.**
Members, users, redirects, protected pages and schedules are reported and not yet
imported; Umbraco 15, 16 and 18 are accepted but have no real export to test
against. What is and is not done is under [Where it stands](#where-it-stands).

A utility that is pointed at a backup of an existing Umbraco site and produces a
working Bunbraco site from it — after first saying, in a report, what will not
come across.

Bunbraco does not claim compatibility with Umbraco: packages and plugins will
never run here, and neither will Razor. The importer is the honest version of
that claim. It moves what can be moved, and it lists what cannot before anything
is written.

## What it does

```
bunbraco import umbraco report <backup> [--site <dir>] [--media <dir>] [--out <dir>] [--json]
bunbraco import umbraco apply  <backup> --out <dir> [--site <dir>] [--media <dir>]
                               [--name <site name>] [--drafts] [--postgres] [--force]
```

`<backup>` is the database: a `.bacpac`, or Umbraco's own SQLite file. `--site` is
the site's files — the web root, or any directory above it — which is where the
Razor views, the media and the evidence of packages and custom code are.

`report` reads the backup and writes nothing unless `--out` asks for the report
as files. It exits non-zero when a finding blocks the import. `apply` refuses to
run while one does, and refuses to write into a directory that is not empty.

Neither command touches a database. `apply` writes a Bunbraco **site
directory**:

```
my-site/
├── package.json, bunbraco.config.ts, server.ts, tsconfig.json
├── schema/                 document, media and member types, data types, languages
├── components/…            a stub per Razor view: templates in the layout chain
│                        the Razor had, every other view where it sat
├── bundles/umbraco-import/ documents, media, blueprints and elements, as a content bundle
├── media/<key>             the media files, under the keys their values name
├── css/, scripts/          stylesheets and scripts from the web root
└── import/
    ├── report.md, report.json
    ├── urls.txt            every URL the source site served
    ├── razor/              the original .cshtml, for whoever rewrites it
    ├── dictionary.udt      for `bunbraco dictionary import`
    └── domains.toml        the source's hostnames, to review before using
```

The scaffolded `start` script is `bunbraco start --bundle bundles/umbraco-import
--publish`, so the first boot is the import, through code that already exists and
is already tested. This is the main design decision: the importer is a
**converter into Bunbraco's own interchange formats**
([`09-schema-as-code.md`](09-schema-as-code.md),
[`13-content-transfer.md`](13-content-transfer.md)), so the output is reviewable
in a diff, re-runnable, and never bypasses the validation a hand-written site
goes through.

Media files are copied into `media/` rather than carried inside the bundle. A
bundle's integrity hash covers its files in memory, and a media library does not
belong there; the import finds each file in the site's own store, where the value
already says it is. A media item whose file was not in the backup is imported
without one and reported, and the `start` script gains `--allow-missing-blobs`.

## Two stages

```
site.bacpac ──▶ [ @kineco-au/bacpac-importer ] ──▶ staging.sqlite ──▶ [ @bunbraco/import-umbraco ] ──▶ my-site/
                  generic, open source               a faithful copy     everything Umbraco-specific
```

The contract between the stages is the **staging database**: a faithful copy of
the SQL Server database, same table and column names, in SQLite. The library
that produces it knows nothing about Umbraco; the importer that reads it knows
nothing about `.bacpac`.

The staging database is only ever read. The importer does not reshape it in place
until it looks like Bunbraco's — it writes schema files and a bundle from it, and
the real database is built from those. So the staging copy is SQLite even when
the site will run on Postgres. It is temporary; `--staging <path>` keeps it.

Only the tables the importer reads are staged. The rest are logs, caches and
tokens, and a package's table may use a column type the converter cannot decode
— but every table is still *listed*, which is how the report knows which packages
have been installed.

## What a backup is

| Part | Forms it arrives in | Read how |
| --- | --- | --- |
| Database | `.bacpac` — what Azure SQL and Umbraco Cloud export, and how most backups arrive | stage one converts it to the staging database |
| | SQLite file (`umbraco/Data/Umbraco.sqlite.db`) | skips stage one: it already is one |
| | SQL Server `.bak`, or a live SQL Server | not supported; export a `.bacpac` from it |
| Site files | the web root: `wwwroot/media`, `Views/`, `App_Plugins/`, `*.csproj`, `wwwroot/css`, `wwwroot/scripts` | `--site <dir>` |
| Media in blob storage | not in the backup | `--media <dir>` pointing at a downloaded copy |

A database with no site files still imports; the report says that views, plugins
and media bytes could not be inspected.

## Stage one: the bacpac library

[`@kineco-au/bacpac-importer`](https://www.npmjs.com/package/@kineco-au/bacpac-importer)
is a standalone open-source library, in
[its own repository](https://github.com/kineco-au/bacpac-importer), that converts
any `.bacpac` into SQLite or Postgres. It is written in TypeScript and has no
dependencies.

A `.bacpac` is a zip holding `model.xml` — the schema — and one or more BCP
native-format data files per table under `Data/`. Restoring one the usual way
needs SqlPackage, which is .NET and therefore ruled out, so the library decodes
it itself. The framing of the data files has no public specification, so each
column type is confirmed against real exports; the library's manifest names any
type a conversion touched that has not been.

Everything an Umbraco database uses is confirmed: `int`, `bigint`, `bit`,
`uniqueidentifier`, `datetime`, `datetime2`, `decimal`, `nvarchar(n)`,
`nvarchar(max)`, `ntext` and `varbinary(max)`.

**Why TypeScript and not Rust.** Decompression and the database driver are
already native code inside the runtime, so only the row decoding is JavaScript,
and the database writer is the bottleneck either way. A native library would have
to ship prebuilt binaries per platform or as WebAssembly, which is a build
pipeline and a class of install failure a pure TypeScript package does not have.
The demo store's 127 tables convert in well under a second.

## Stage two: the importer

`@bunbraco/import-umbraco` takes the library as an ordinary npm dependency. It is
**opt-in**: the CLI loads it on demand and says how to add it, so a site that
never imports anything carries neither it nor the `.bacpac` reader.
`tests/packaging.test.ts` holds that line.

| Module | |
| --- | --- |
| `source.ts` | opens the backup, stages a `.bacpac`, and normalises what differs between the two kinds: key casing, date spelling |
| `version.ts` | the Umbraco version, from the upgrade state |
| `schema.ts` | types, data types, templates and languages → the schema model |
| `content.ts` | documents, media, blueprints and elements → a bundle |
| `views.ts` | a TSX stub per template |
| `site-files.ts` | what the site's files hold: Razor, media, packages, plugins, C# |
| `inventory.ts` | dictionary, hostnames, URLs, and everything that is counted and not imported |
| `report.ts` | the findings, as JSON, markdown and a terminal summary |

`planImport` returns the report and a list of files, and writes nothing. The CLI
adds the site scaffold `bunbraco init` writes and puts it all on disk.

### What is converted, and how

- **Keys are carried over.** A content type, a property and a node keep the key
  they had, which is what lets the bundle name a content type by key and find it
  once the schema has synced, and what keeps every picker pointing at its target.
- **Data types.** Umbraco's built-in data types have the same keys here, so one
  the site left alone needs no file. One it changed is written under the
  built-in's alias. A site's own data type takes an alias from its name.
- **Media and member types** Umbraco ships are written only where the site
  changed them, compared without property keys, which Bunbraco seeds itself.
- **Element types** lose templates, allowed children and allow-at-root: Umbraco
  tolerates them on a type that is never routed, and the schema validator does
  not. The report lists each.
- **Values** are converted to what the editor expects — a toggle to a boolean, a
  date to wall-clock time, rich text to its markup-and-blocks object — through
  `toEditorValue`, the conversion the API uses. A value on an editor with no
  equivalent is carried exactly as it was stored.
- **The snapshot** is the exporter's rule: a published page carries its published
  values, an unpublished one its draft. `--drafts` takes the working copy
  throughout. The report counts pages whose unpublished changes were left behind.
- **References** inside a value are recorded only when the bundle carries their
  target. One that points at a member or a recycled item is counted in the
  report, and the value travels as it is.
- **Templates** become stubs: Razor cannot be translated mechanically, so nothing
  tries. Each compiles, sits in the same layout chain and renders the page's
  name, so the site boots and every page answers.

## Which Umbraco versions

Measured from Umbraco's own upgrade plan (`Migrations/Upgrade/V_*` at each
release tag), because every migration between a source version and 18 is a
transformation the importer must either perform or be able to ignore.

| Source | What separates it from the 18 shape | Importer cost |
| --- | --- | --- |
| **18.x** | nothing; this is the shape Bunbraco's model mirrors | baseline |
| **17.x** (LTS) | single-block list values (18.0); element permissions, which do not apply | low: one value converter |
| **16.4 – 16.5** | checkbox-list values, system dates to UTC, label storage types (17.0–17.4); the rest is indexes and derived tables | low–medium: two value converters, and the source server's time zone must be supplied |
| **15.x – 16.3** | TinyMCE → Tiptap rich-text configuration (16.0), media-type label properties (16.3), missing tabs (16.4) | medium: data type configuration only, stored values are unchanged |
| **14.x** | the block editor value format and local links were rewritten in 15.0 (17 migration classes): every Block List, Block Grid and rich-text value, recursively | high |
| **13.x** (LTS) | all of the above plus 14.0 (18 migration classes): data type configuration re-serialised, property editor aliases renamed, permissions and user groups re-keyed, macros removed — and legacy editors (Nested Content, Grid Layout, macros in rich text) may still hold content | very high |

Umbraco 18 itself refuses to upgrade a database older than **16.4**
(`UmbracoPlan.InitialState`), which is a natural line.

**Decided: 15.x and later are accepted.**

1. **17.x and 18.x are built first.** The current release and the current LTS,
   one converter apart, and the shortest path to an end-to-end import.
2. **15.x and 16.x follow in the same release.** A handful of converters, each
   small and independently testable.
3. **13.x and 14.x are detected, not imported.** The report says "upgrade to 15
   or later with Umbraco first, then import". Supporting them means
   re-implementing about 35 of Umbraco's migration classes in TypeScript,
   including converters for editors that no longer exist; Umbraco's own upgrader
   already does this and is the one tool certain to do it correctly.

The version is read from the database, not asked for: `umbracoKeyValue` holds the
upgrade plan's state GUID, and a table of state → version is extracted from
`UmbracoPlan.cs` at each supported tag.

What that comes to in the code: the checkbox-list move is handled by reading a
value from whichever column holds it; a rich-text data type still configured for
TinyMCE is switched to Tiptap and reported, since its toolbar has to be set up
again; and Umbraco 18's `Umbraco.SingleBlock` editor has no equivalent here, so it
is reported like any other. Nothing else between 15 and 18 changes what a bundle
carries. A state newer than the table knows is attempted, with a warning.

**Only 17 has been run against a real export.** 15, 16 and 18 follow from
reading Umbraco's migrations, and from altering the 17 fixture to look like
them; none has a real backup behind it yet.

## The compatibility report

Produced first, readable by someone who is not a developer, and also emitted as
JSON. Each finding has a class:

| Class | Meaning |
| --- | --- |
| **blocking** | stops `apply`: a version too old, a database that is not Umbraco, a schema that did not convert validly |
| **needs a person** | comes across, but somebody has work to do before it behaves as it did |
| **cannot be migrated** | has no equivalent here; nothing is imported for it |
| **not imported by this version** | could be, and is not yet |
| **left behind** | dropped on purpose, with a count |
| **migrates** | converted, nothing to do |

| Finding | Class | What happens |
| --- | --- | --- |
| Document, media and member types, compositions, folders | migrates | `schema/*.toml` |
| Data types on a supported editor | migrates | configuration carried as it is |
| Content, media, blueprints; cultures and segments | migrates | the bundle; published, or the draft with `--drafts` |
| Media files | migrates | `media/<key>`; reported per file when the bytes are missing |
| Languages | migrates | `schema/languages.toml` |
| Dictionary | migrates | `import/dictionary.udt` |
| Published URLs | migrates | `import/urls.txt`, to check the imported site against |
| **Razor templates and partials** | needs a person | a TSX stub per template, the original beside the report; each listed with its size and what it uses (partials, forms, macros, injected services) |
| **Data types on a third-party editor** | needs a person | the value is carried untouched, the properties are listed, and the editor has no UI here |
| **Hostnames** | needs a person | `import/domains.toml`, not applied: they are the source's |
| **Pickers pointing at something not imported** | needs a person | counted |
| **Version history, recycle bin, unpublished changes** | left behind | counted |
| **Members, users, redirects, protected pages, schedules** | not imported yet | counted |
| **Packages** | cannot be migrated | named from the tables they created, the migration plans they recorded, `*.csproj` references and `App_Plugins/`, with what each one's absence takes away where it is known |
| **Custom C#** | cannot be migrated | counted when the source is in the backup |
| **Webhooks, external and two-factor logins** | cannot be migrated | counted |
| A source version below 15 | blocking | upgrade with Umbraco first |

`import/urls.txt` is every published page's path, from the URL segments Umbraco
recorded: the first site in the tree, in the default language. A page with no
template is left out, because Umbraco does not serve one either.

## Where it stands

| | Package | State |
| --- | --- | --- |
| **WP-B** | The bacpac library | **done** to the point the importer needs: reader, SQLite and Postgres-script writers, published to npm. The long tail of rarer column types is its own roadmap |
| **WP-I.0** | Fixtures and measurement | **partly**: one real export, the Umbraco Commerce demo store at 17. No 15, 16 or 18 export, and no native Umbraco SQLite file |
| **WP-I.1** | Source reader and version detection | **done** |
| **WP-I.2** | Inventory and report | **done** |
| **WP-I.3** | Schema conversion | **done**; `schema check --static` passes on the output |
| **WP-I.4** | Content conversion | **done**; the bundle imports whole on SQLite and Postgres |
| **WP-I.5** | Site data | **partly**: dictionary and hostnames are written as files. Members, users, redirects, protected pages and schedules are **not built** |
| **WP-I.6** | Views and assets | **done**; every stub passes `views check` |
| **WP-I.7** | Orchestration and URL parity | **done**: the demo store imports with no manual step and every URL it served answers 200 |
| **WP-I.8** | 15.x and 16.x | **partly**: the two conversions are built and tested against an altered fixture, not a real export |

### What is left

- **Members and users.** Umbraco stores ASP.NET Core Identity v3 hashes
  (PBKDF2-HMAC-SHA512); Bunbraco stores argon2id and records the algorithm per
  row in `password_config`. The plan is to carry the original hash with its
  algorithm marker, teach `verifyPassword` to verify PBKDF2, and re-hash to
  argon2id on a successful sign-in — the rotation the column was kept for — so
  nobody is forced to reset. A bundle deliberately carries no members, so this
  needs an import path of its own.
- **Redirects, protected pages, schedules.** No file format carries them yet.
- **Real exports of 15, 16 and 18**, and a native Umbraco SQLite backup: the
  reader normalises key casing and date spelling for one, and is tested only
  against a copy altered to look like one.
- **Razor → TSX** offered by the assistant ([`11-assistant.md`](11-assistant.md)),
  reviewed per view. A could-have.

## How it is tested

`tests/fixtures/umbraco/` holds the Umbraco Commerce demo store, an MIT-licensed
Umbraco 17 database of demonstration data: 33 content types, 52 data types, 182
documents, 255 media items, 20 templates in a three-deep layout chain, a package
with 52 tables of its own, and four third-party property editors.

- `tests/import-umbraco.test.ts` runs the importer in-process: the schema it
  writes loads and validates, the bundle loads intact, values are converted, the
  report says what it should. It then syncs the schema and imports the bundle
  into a real database, on whichever dialect the suite is running.
- `tests/integration/import-umbraco.integration.ts` drives the CLI as a person
  would — `report`, `apply`, then `bunbraco start` in the directory it wrote —
  and fetches every URL in `import/urls.txt` from the booted site.

## Decisions taken

- **D1 — `.bacpac` first, through a standalone library.** It is how most backups
  arrive. The conversion to SQLite or Postgres is a generic open-source library,
  written in TypeScript; the importer consumes its SQLite output. `.bak` and live
  SQL Server connections are not supported: anyone holding either can export a
  `.bacpac`.
- **D2 — versions 15 and later.** 13 and 14 are detected and refused with
  instructions.
- **D3 — a separate package.** `@bunbraco/import-umbraco`, loaded by the CLI on
  demand, so the importer and the bacpac library are not dependencies of every
  site.
- **D4 — fixtures are built outside the repository.** Producing a reference
  backup means running Umbraco once, which is .NET. That happens in a disposable
  container elsewhere and only the resulting database files are committed, so the
  repository and its build stay free of .NET as `AGENTS.md` requires.
