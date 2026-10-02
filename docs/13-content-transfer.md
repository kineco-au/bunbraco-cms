# Content transfer

Moving content between environments — a campaign built in development promoted
to production, or production content pulled down to develop against.

`09-schema-as-code.md` moved *structure* into files, which is what makes this
tractable: a deploy already guarantees both environments have the same document
types, so a content transfer never has to reconcile them. It carries content and
names what it needs.

## What this is not

`10-packaging-and-upgrades.md` says metadata flows development → test →
production and content lives where it is edited. That still holds: **a deploy
never moves content.** This is a separate, explicit act, run by a person or a
pipeline step of its own, with its own artifact and its own audit trail.

It is also not Umbraco Deploy. There is no connection between environments, no
service, and no credentials for one environment stored in another. A transfer
produces a **file**, and the file moves however files already move here — a CI
artifact, a commit, an object store.

## Three properties that make it cheap

1. **Structure is already files.** A bundle carries no type definitions. It
   names the content types, templates and languages it needs, and the
   destination proves it has them.
2. **Values are append-only and versions are events** (`02-data-model.md`). An
   import is another event, so there is no merge algorithm: it appears in the
   version history, and reverting it is the rollback path that already exists.
   Re-importing unchanged values appends nothing, so importing twice is a no-op.
3. **Everything is a `node` with a `unique_id`**, and `DocumentRepository`
   already handles documents, media, members, blueprints and elements through
   one map. One exporter covers every kind.

## The bundle

```
bundles/campaign-x/
├── bundle.json          manifest, including an integrity hash over nodes/
├── nodes/<uuid>.json    one file per node, every kind
├── blobs/<key>          the media bytes, with --with-blobs
└── resolutions.json     conflict decisions, once check has been run
```

One file per node, so a bundle is reviewable in a diff and committable — the
same reasoning that puts schema in files. JSON rather than TOML because TOML was
chosen for files a person edits by hand, and these are machine-produced and hold
arbitrary editor payloads.

The writer is canonical: fields in a declared order, collections sorted, so the
same content always serialises identically. A property's `value` is **passed
through untouched** — it is an editor's own payload, often JSON inside a string,
and reordering its keys would rewrite somebody's data to no purpose.

`integrity` is a hash over the node files. `load` checks it before checking
shape, so a bundle that was copied half-way is refused as incomplete rather than
reported as a pile of confusing field errors.

### Identity

Everything travels by **uuid and alias**; no integer id ever appears in a bundle,
because ids differ between environments and keys do not.

| Thing | Travels as | Why |
| --- | --- | --- |
| A node | `unique_id` | stable everywhere |
| A content type | key **and** alias | tooling writes keys into `schema/*.toml`, so they are stable; the alias is what a person reads |
| A template | alias only | a template's definition *is* `Views/<alias>.tsx`; the row is derived, so its key differs per environment |
| A property | alias, culture, segment | the wire format the API already uses |
| A media file | the store key, with an etag | the blob itself moves separately |

### What the snapshot is

A bundle holds what the source site **serves**, not what an editor happens to
have half-written:

- a published node carries its **published** values;
- an unpublished node carries its draft, and the bundle records that it was not
  live, so an import does not publish it;
- `--drafts` takes the current draft throughout, for moving work in progress.

*Known imprecision:* a published snapshot takes names from the draft, so a page
renamed but not republished travels under its new name. The values are right.

### What never travels

Members, outright — they are personal data and a bundle is a file that gets
copied around and committed. Trashed nodes, and a selector rooted in a recycle
bin is refused. And nothing that is true of exactly one environment: domains,
users, sessions, tokens, external logins, per-user start nodes, notification
subscriptions, public access rules, content schedules, redirects, log-viewer
searches, `server`, `cache_instruction`, `schema_state`, `migration_history`.
`tests/content-export.test.ts` asserts the whole list.

### Dependencies

Every bundle classifies what it needs:

| Class | Meaning | If the destination lacks it |
| --- | --- | --- |
| **carried** | in the bundle | — |
| **expected** | must already exist there, by uuid — a parent, a shared settings node | a blocking finding |
| **schema** | content types, templates, languages | a blocking finding: deploy the files first |

References are read out of the values themselves. A picker stores
`umb://document/<hex>` or a bare uuid, and block editors and rich text hold both
inside JSON, so the scan goes through structures and through JSON held in a
string.

An undashed 32-hex run is indistinguishable from any other 32 hex characters, so
extraction produces **candidates**, and each is resolved against a real
`node.unique_id` before it counts. A candidate that resolves to nothing was never
a reference and is dropped rather than demanded. Being wrong in that direction is
cheap; missing a reference is not.

### Provenance is recorded, never gated on

The manifest carries the source's schema `(version, revision)` and hash. It is
printed and kept for the audit trail, and **nothing is refused because of it.**
Development runs at revision 0 by design (`10-packaging-and-upgrades.md`), so a
rule like "refuse a bundle newer than this database" would refuse every transfer
out of production, and environment hashes legitimately differ. What the
destination must satisfy is checked element by element instead.

## Naming a node

`content export --root` and `content import --under` both take **either** a uuid
or a path by name, through one resolver, so the two cannot drift.

```
bunbraco content export --root /Campaigns/Autumn 2026 --out bundles/campaign-x
bunbraco content export --root 9a1f3c2e-5d4f-4d3e-9d6d-2b7f8a1c9e10 --out …
```

A path is resolved at export time and the resolved **uuid** is what lands in the
manifest, with the text as given kept alongside for readability, so the artifact
is identity-stable however it was selected.

Three rules keep the convenience from becoming ambiguity:

- a uuid-shaped argument is always a uuid, never a path;
- a path matches case-insensitively by node name from the content root, leading
  slash optional;
- a path matching nothing, or more than one node, is an error that **names the
  candidates**. Guessing would place content somewhere nobody chose.

## Reading at the database's state

A tool that reads content takes the database's own schema state, rather than the
install baseline a repository defaults to.

This is not a detail. Reads are as-of the node's state: a repository left at the
baseline finds no `schema_state` row at or below it, so every value is filtered
out and the export **succeeds carrying nothing** — the worst kind of failure. A
CLI is not a node asserting a deployment, and `exportBundle` sets its state from
`currentSchemaState` for exactly this reason.

## The dry run

`content check` is read-only, and it runs **before every import** rather than
only when asked. Nothing is written until the conflicts have been named and
answered, so a transfer is never a surprise.

It reports a **plan** — how many nodes would be created, updated, left alone or
skipped — and findings in three kinds:

| Kind | Means | Answered by |
| --- | --- | --- |
| **blocking** | the destination cannot honour the bundle as it stands | deploying something, or re-rooting it; no resolution makes it importable |
| **person** | importable, but somebody has to choose | a resolution |
| **auto** | what the import will do, said out loud | nothing; it never holds an import up |

| Code | Kind | Meaning |
| --- | --- | --- |
| `missing-content-type` | blocking | no such type here — deploy `schema/` first |
| `language-missing` | blocking | the bundle has content in a culture this environment has no language for |
| `missing-parent` | blocking | the parent it names is absent; `--under` answers it |
| `missing-dependency` | blocking | a node a value refers to is absent and not carried |
| `editor-mismatch` | blocking | the property's editor changed, so the value would be stored in the wrong shape |
| `local-trashed` | blocking | the target is in the recycle bin here, and importing would revive it silently |
| `local-edit` | person | it is already here and differs; the finding names the properties |
| `name-collision` | person | a sibling of the same name, so the two would share a URL |
| `missing-blob` | person | the media file is not in this environment's store |
| `unresolved-reference` | person | a value points at something that is neither here nor carried |
| `missing-property` | auto | retired here, so that value is not imported |
| `missing-template` | auto | no view for the alias, so the page arrives without a template |
| `new-node` | auto | created — a draft for documents, live for media |

**Re-importing a bundle exported from the same site is a no-op with nothing to
decide.** That is the identity case, and it is what tells you the comparison is
honest rather than reporting every node as changed.

### Resolutions

A `person` finding waits for one of three answers, by node key:

| | |
| --- | --- |
| `take-bundle` | the bundle wins |
| `keep-local` | keep what is here; the node is left as it is |
| `skip` | leave the node alone entirely |

```bash
bunbraco content check bundles/campaign-x --resolve 9a1f…=take-bundle
bunbraco content check bundles/campaign-x --resolve-all take-bundle --save
```

`--save` writes `resolutions.json` beside the bundle, **by node key**, so the
decision is committed with the bundle and not worked out again in test and then
again in production — the argument
`10-packaging-and-upgrades.md` already makes for site-authored value migrations.
Keys rather than paths, because a path may mean something different in the next
environment. Answers belonging to a different bundle id are reported and
ignored rather than applied.

Suggestions are a function of the finding's `code`, so the table keeps its
stable shape and the CLI and the dashboard offer the same advice. A `person`
finding that suggests nothing is a dead end, and a test holds the two lists in
step.

`check` exits non-zero while anything is outstanding, so it drops straight into
a pipeline.

## The import

`content import` re-runs the check **inside the lock** and refuses while
anything is outstanding, so a decision made against a stale read cannot slip
through. Then it writes, in one transaction.

Four properties it is shaped around, in the order that getting them wrong would
hurt:

1. **Everything goes through `DocumentRepository`.** `is_current` is maintained
   on insert by the repository's own write path; a writer reaching into
   `property_value` would corrupt the flag every hot-path read depends on.
2. **Values are an overlay, never a replacement.** `#appendValues` treats what
   it is handed as the complete set and *clears* anything current that is absent
   from it. So the values given to `update` are the node's current values with
   the bundle's laid over them. Without this, importing a bundle that carries
   `title` would empty `summary` — silently, on content nobody was looking at.
   `tests/content-import.test.ts` pins it.
3. **One lock and one transaction for the whole run**, so a failure anywhere
   leaves nothing behind. Both dialects join an enclosing transaction, so an
   import nested in a larger one is undone whole with it.
4. **Two passes.** Every node is created, with its name and no values, before
   any value is written. A page that links to a page that links back therefore
   needs no ordering cleverness — there is no order that would satisfy both in
   one pass.

**Idempotence falls out of (2).** The repository appends only what differs, so a
second import of the same bundle writes nothing and reports `unchanged`.

### Drafts, and what `--publish` means

Documents and elements arrive as **drafts**: a save event, so they show as
edited in the backoffice and a person publishes when ready. Media has no
published state and is live as soon as it lands.

`--publish` publishes **what the bundle says was live at the source**, not
everything — a page that was only a draft where the bundle was made stays a
draft here. Publishing runs last and parents first, because an unpublished
ancestor makes a published descendant unreachable and the repository refuses it.
A refusal is reported per node rather than failing the run.

### The lock

Six writes in `DocumentRepository` take the content-tree lock, and neither lock
manager survives re-entry: the SQLite one is a promise queue that would wait on
itself for ever, and the Postgres one acquires inside its own `transaction`.
Transactions *do* nest — both implementations join an enclosing one — so this is
only ever about the lock.

`DocumentRepositoryOptions.inTreeLock` says "the caller already holds it", and
one `#withTree` helper honours it in one place rather than six. That is what
lets an import hold a single lock across many documents instead of taking one
per node.

### What a run records

`content_transfer_run` and `content_transfer_change` (migration 019) record, per
node, the event it was at before the run and the published event it was serving.
That is precisely "the previously-live state", and it is recorded as the run
happens because it cannot be recovered afterwards: nothing distinguishes one
run's `save` events from an editor's concurrent save in the same second, and
once a node exists there is no way to tell that the import created it.

`content runs` lists them, newest first. Every import ends by naming the command
that would put it back.

`EventKind` is left alone — `'save'`, `'publish'`, `'rollback'`, `'migrate'`.
Adding a `'transfer'` kind would surface an unknown value in the vendored
Umbraco client's version list, so provenance lives in
`content_transfer_change.event_id` instead. A deliberate divergence.

### Backups

`backupBefore` runs first, exactly as `upgrade` does: SQLite is copied beside
the file, and Postgres refuses without `--backup-taken` or a configured
`BUNBRACO_PG_DUMP`. That is the coarse layer underneath the fine-grained revert,
for the case where somebody wants the whole database back rather than one run
undone.

## The revert

`content revert <run-id>` is the existing rollback path driven in bulk.
`DocumentRepository.rollback` already appends the values as of a given event
under a *new* event — history is never rewritten — so putting a run back is:
for each node it touched, roll back to the event it was at beforehand, then
restore the published state it was serving.

The promise is **the site serves what it served**, not merely that the drafts
match. So a node that was live is republished with the restored values, and a
node that was a draft stays a draft.

Nodes the run **created** are unpublished and moved to the recycle bin, never
deleted — `document.original_parent_id` is set, so a restore puts them back
where they were.

Order matters in three steps, and each for its own reason:

1. anything a *previous revert* recycled comes back out of the bin first, so
   there is a node in the tree to work on;
2. values, then published state **parents before children**, because a published
   node under an unpublished one is unreachable and the repository refuses it;
3. what the run created goes to the bin last, **shallowest first**: the bin takes
   a whole branch, so a deeper node is already gone by the time it is reached.

### Its own dry run

Reverting blindly would discard work, so it checks first and refuses on anything
outstanding:

| Code | Kind | Meaning |
| --- | --- | --- |
| `run-not-applied` | blocking | no such run, or it is already reverted |
| `later-run` | blocking | a later run touched the same content; revert that first, or `--force` |
| `edited-since` | person | somebody saved after the import; reverting discards it. `discard` / `skip` |
| `children-added` | person | nodes were added under one the revert will recycle, and go with it |
| `node-gone` | auto | the node has since been deleted outright; nothing to put back |

`children-added` counts only what *somebody else* put there. The run's own
children are going to the bin anyway, and counting them would make reverting any
multi-node import ask for a decision about nothing.

### A revert is itself a run

It is recorded like any other, so it can be reverted in turn — and that is more
than restoring values: the run records `recycle` as the action for a node it put
in the bin, so reverting the revert knows to bring it back out rather than only
rolling its values forward.

## The dictionary

`09-schema-as-code.md` leaves the dictionary in the database — translators work
in production, where `schema/` is read-only — and promised these two commands as
how a lower environment gets the translations:

```
bunbraco dictionary export --out <file.udt> [--key <uuid>]
bunbraco dictionary import <file.udt>
```

It is Umbraco's own `.udt`, so a file exported from an Umbraco site imports here
and the other way round. Items **upsert by key**, so running an import twice is a
no-op, and an item translated here keeps any language the file does not carry.
A translation for a language this environment has not got is **skipped rather
than refused** — Umbraco's behaviour — but the command says which, instead of
dropping it silently.

The implementation is shared with the Management API endpoint rather than
duplicated: `importDictionaryUdt` in `@bunbraco/server`, which the adapter now
calls too.

## Findings

Transfer findings share the `change_report` table, endpoint and dashboard with
the pre-upgrade check, in the same three kinds — `blocking`, `person`, `auto`.

The table was `upgrade_report` until migration 018. Sharing it needed two more
columns, because **a run resolves whatever it no longer reports**: without
`source` (`upgrade` | `transfer`) a content check would resolve every open
upgrade finding, and a development boot — which writes its own check at startup —
would silently wipe a transfer report on every restart. `scope` narrows it again
to one bundle, so two campaigns can be checked side by side.

The renaming of a table is not an expand step, and the lint that says so is right
in general: the rule keeps the previous release's code able to read an upgraded
database. At 0.x there is no deployed node to protect and `upgrade_report`
shipped in the same pre-release line, so the exception was taken deliberately
and comes off at 1.0.

## Commands

```
bunbraco content export --root <path|uuid> [--root …] --out <dir>
                        [--only] [--drafts] [--with-blobs] [--with-blueprints]

bunbraco content check <dir>
                        [--under <path|uuid>] [--resolve <key>=<choice>]
                        [--resolve-all <choice>] [--allow-missing-blobs] [--save]

bunbraco content import <dir>
                        [--publish] [--label <text>] [--backup-taken] + the check flags
bunbraco content runs   [--limit N]
bunbraco content revert <run-id>
                        [--resolve <key>=discard|skip] [--resolve-all <choice>]
                        [--force] [--backup-taken]

bunbraco dictionary export --out <file.udt> [--key <uuid>]
bunbraco dictionary import <file.udt>

bunbraco content publish <path|uuid>
                        [--descendants] [--culture <iso>]... [--at <when>] [--until <when>]
bunbraco content unpublish <path|uuid>
                        [--descendants] [--culture <iso>]...

bunbraco start --bundle <dir>
                        [--publish] [--label <text>] + the check flags
```

`--only` takes the named nodes without their descendants.

`content publish` is the other half of a drafts-first import: the content lands
in one step and goes live in another, which is what a cut-over wants. A publish
can be refused per node — an unpublished ancestor, an unpublished mandatory
language, an empty mandatory property — so the whole selection is checked before
anything is written and refused together, rather than leaving half a branch
live. A node the same run is about to publish does not count against its own
children. `--at`/`--until` write a schedule instead, which the background job
acts on; today's blockers are not the question for a date in the future.

`start --bundle` applies a bundle before the site serves anything, which is how a
starter template's content reaches a new site (`bunbraco init --template`) and how
a container can bring its own content with it. It imports **once per bundle** —
an import run still standing here means this site has that content already, so a
restart is a query and a line in the banner — and a refusal stops the boot rather
than serving a site missing the content the command line asked for. The import
runs after the schema sync, which is what gives the bundle its document types.

### What travels, and what did not

Two things a bundle carries were being dropped on import, and are not any more:

- **Sort order.** Nodes arrived in the order the run happened to create them, so
  a site's navigation came out shuffled. The nodes a run creates are now placed
  among themselves in the bundle's order; siblings that were already there keep
  their places, so an import still appends rather than rearranging a tree.
- **Media types.** A media node's type is a different object type, and both the
  check and the importer resolved content types only among document types — so
  any bundle carrying real media was refused with `missing-content-type` for a
  type the destination had all along. Both now ask the media repository too.

### Media

`--with-blobs` carries the bytes. Each media file is written to `blobs/<key>`,
the integrity hash covers it, and the import puts it into the destination's
store under the same key — through the `MediaStore` interface, so it lands on a
disk, in a bucket or in a container according to what that environment uses, and
the value that already names `/media/<key>` finds its file.

Whether a file is carried is decided by the writer, from the bytes the exporter
managed to read, not by the flag: a key the source store has not got is reported
and marked `included: false`, so the manifest says what is true. At the
destination, a carried file needs no check, and one that is *not* carried is
looked up in the local store — `missing-blob`, a person's decision, which
`--allow-missing-blobs` answers.

Without the flag the bundle is metadata only, as before, and the export says so
rather than leaving it to be discovered at the other end.

### Still open

- **The down direction.** `bunbraco clone --anonymise`: a whole-environment copy
  for developing against, which is mostly orchestration over `pg_dump` or a file
  copy plus a media sync — but needs a sanitise step, because production users,
  members, tokens and e-mail addresses must not land on a laptop.
- **`--publish` preconditions in the dry run.** `publish` refuses on an
  unpublished ancestor, an unpublished mandatory language or an empty mandatory
  property. The import reports each refusal per node and carries on rather than
  failing the run, so nothing half-lands — but a dry run that predicted them
  would be better than finding out at the end.
- **Per-property resolutions.** `keep-local` is per node; a conflict on one
  property of a page cannot yet be answered differently from the rest.
- **Resolving conflicts in the backoffice.** The findings are already in the
  Changes dashboard; acting on them is still a CLI flag.
