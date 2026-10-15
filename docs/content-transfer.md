# Content transfer

Moving content between environments — a campaign built in development promoted
to production, or production content pulled down to develop against.

`schema-as-code.md` moved *structure* into files, which is what makes this
tractable: a deploy already guarantees both environments have the same document
types, so a content transfer never has to reconcile them. It carries content and
names what it needs.

## What this is not

`packaging-and-upgrades.md` says metadata flows development → test →
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
2. **Values are append-only and versions are events** (`data-model.md`). An
   import is another event, so there is no merge algorithm: it appears in the
   version history, and reverting it is the rollback path that already exists.
   Re-importing unchanged values appends nothing, so importing twice is a no-op.
3. **Everything is a `node` with a `unique_id`**, and `DocumentRepository`
   already handles documents, media, members, blueprints and elements through
   one map. One exporter covers every kind.

## The bundle

A bundle is an npm package ([`bundles.md`](bundles.md)), and an export is one
too: a **private** package, never published or depended on, applied from its
directory. Its `package.json` names it and declares the payload; the payload is
everything below.

```
bundles/campaign-x/
├── package.json             "private": true, and "crombolo": { "id", "name", "content": "content" }
└── content/
    ├── bundle.json          manifest, including an integrity hash over everything
    ├── nodes/<uuid>.json    one file per node, every kind: its place, name and rules
    ├── values/<uuid>.json   the node's values, sealed, with --include-content
    ├── blobs/<key>          the media bytes, with --with-blobs (sealed with the values)
    ├── people/              members, users and their groups, always sealed
    └── resolutions.json     conflict decisions, once check has been run
```

`--name` and `--package-version` set the package's name and version; the name
defaults to the output directory's. A directory holding a `bundle.json` and no
`package.json` is refused by every reader, with a message describing the layout:
there is one kind of bundle, not two.

One file per node, so a bundle is reviewable in a diff and committable — the
same reasoning that puts schema in files. JSON rather than TOML because TOML was
chosen for files a person edits by hand, and these are machine-produced and hold
arbitrary editor payloads.

The writer is canonical: fields in a declared order, collections sorted, so the
same content always serialises identically. A property's `value` is **passed
through untouched** — it is an editor's own payload, often JSON inside a string,
and reordering its keys would rewrite somebody's data to no purpose.

`integrity` is a hash over everything the bundle carries. `load` checks it
before checking shape, so a bundle that was copied half-way is refused as
incomplete rather than reported as a pile of confusing field errors.

### What is readable, and what is sealed

A bundle's metadata is readable, so it can be reviewed in a diff; anything
that can hold personal information is sealed (story 071). One passphrase per
export, from `CROMBOLO_BUNDLE_PASSPHRASE` or a prompt, stretched with scrypt
(N=2^17, r=8, p=1) and a 16-byte salt the manifest keeps; each sealed file is
AES-256-GCM with a nonce of its own and its path as additional data, so a file
cannot be swapped for another's. A check value in the manifest tells a wrong
passphrase apart from a damaged file. The key is never written anywhere.

| Readable | Sealed |
|---|---|
| The manifest, with the seal's salt and cost and the counts of people | Property values (`values/`) |
| Each node's key, kind, type, parent, order and template | Media files (`blobs/`) |
| Names, cultures and whether each was published | Usernames on a protected page's rules |
| Each value's property, culture, editor and the keys it refers to | `people/` |
| Schema, components, styles, scripts and dictionary | |
| Redirects, schedules, and protected pages by member group | |

`content export` leaves values and media files out unless `--include-content`
is given: such a bundle places and names pages and writes no value, and its
check says so. `--include-content` seals them; `--allow-content-unencrypted`
writes them readable, with a warning. People are never written readable.

A sealed bundle is format 3. Without the passphrase its check is one blocking
finding, `content-sealed`, because a check that compared values it cannot read
would report every one as cleared; an install is refused before anything is
backed up or written. A package for anyone to install is open: writing one
that carries people or sealed content is refused.

### Pages' rules

A node carries what is true of the page beyond its values: `access` (its
sign-in and no-access pages and the member groups it is for — the usernames
travel sealed with the values), `schedule` (publishes and unpublishes waiting
for their time, in UTC) and `redirects` (the routes it used to answer on, as
`tracked` rules). They are applied after every node exists. A protected page
whose sign-in page is in neither the bundle nor the site is blocking; a member
group that does not exist here is reported, and nobody can see the page until
it does.

### People

`--with-members` carries member groups and members, with their values and
password hashes; `--with-users` carries user groups and users. Both are sealed
into `people/`, whose manifest block counts them and names nobody.

- **The same key is the same person**: updated, keeping a password set or
  re-hashed here (an argon2id hash), otherwise taking the bundle's.
- **A different key whose e-mail or username is taken here** is a
  `person-conflict`, answered with `--resolve <key>=take-bundle` (the person
  here takes the bundle's details and keeps their key and password) or `skip`.
  Findings name people by key only.
- **Groups**: a member group is matched by key, then by name; a user group by
  key, then by alias, and one that exists here keeps its permissions.
- **The administrator `crombolo start` seeds** on a new database stands in until
  the site's own arrive: on that first boot an imported user with the same key,
  login or e-mail takes it over, with the password they had.
- **A revert** removes the people the run created, members before groups. Those
  it updated keep the bundle's details, reported as `person-kept`.

A password hash travels as the source stored it. Umbraco's four formats verify
here (`packages/auth/src/umbraco-passwords.ts`) and are re-hashed to argon2id on
the next successful sign-in, so nobody resets a password.

### A bundle that carries its own structure

Everything above describes a bundle that carries **content** and *names* the
structure it needs — which is the normal case, because a deploy has already put
the same `schema/*.toml` in both environments.

A bundle may also carry that structure, and then it installs into a site that
has none of it. That is what the Bundles section builds
([`bundles.md`](bundles.md)): the same format, with optional sections.

```
├── schema/*.toml        types and languages
├── views/<alias>.tsx    templates
├── partials/, styles/, scripts/
└── dictionary.udt
```

The names are logical, not directory names: the importer maps each section onto
wherever this site keeps that kind of file, so a bundle is not tied to the
layout it was built from. A file the site already has is not replaced without
`--replace-files`, and what is replaced is copied aside so a revert can put it
back — these files are editable in the backoffice, and a site need not be a git
checkout ([`bundles.md`](bundles.md)). The manifest's `carries` declares every one, the
integrity hash covers them, and `bundle install` applies them before the content
that needs them. A content-only bundle carries no `carries` key and still says
`formatVersion: 1`, so nothing about an existing bundle changed.

`label` is the bundle's own name, when it has one — a created package's name
travels in the artifact rather than being supplied at import time, so a
downloaded file still knows what it is.

### Identity

Everything travels by **uuid and alias**; no integer id ever appears in a bundle,
because ids differ between environments and keys do not.

| Thing | Travels as | Why |
| --- | --- | --- |
| A node | `unique_id` | stable everywhere |
| A content type | key **and** alias | tooling writes keys into `schema/*.toml`, so they are stable; the alias is what a person reads |
| A template | alias only | a template's definition *is* `components/<alias>.tsx`; the row is derived, so its key differs per environment |
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

Members and users unless asked for, and then only sealed (see "People").
Trashed nodes, and a selector rooted in a recycle bin is refused. And nothing
that is true of exactly one environment: domains, sessions, tokens, external
logins, per-user start nodes, notification subscriptions, log-viewer searches,
`server`, `cache_instruction`, `schema_state`, `migration_history`.
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
Development runs at revision 0 by design (`packaging-and-upgrades.md`), so a
rule like "refuse a bundle newer than this database" would refuse every transfer
out of production, and environment hashes legitimately differ. What the
destination must satisfy is checked element by element instead.

## Naming a node

`content export --root` and `content import --under` both take **either** a uuid
or a path by name, through one resolver, so the two cannot drift.

```
crombolo content export --root /Campaigns/Autumn 2026 --out bundles/campaign-x
crombolo content export --root 9a1f3c2e-5d4f-4d3e-9d6d-2b7f8a1c9e10 --out …
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
| `local-edit` | person | it is already here and one property differs; one finding per property (and culture) |
| `name-collision` | person | a sibling of the same name, so the two would share a URL |
| `missing-blob` | person | the media file is not in this environment's store |
| `unresolved-reference` | person | a value points at something that is neither here nor carried |
| `missing-property` | auto | retired here, so that value is not imported |
| `missing-template` | auto | no view for the alias, so the page arrives without a template |
| `new-node` | auto | created — a draft for documents, live for media |
| `publish-refused` | auto | with `--publish`, the page that publish would refuse, and why |

**Re-importing a bundle exported from the same site is a no-op with nothing to
decide.** That is the identity case, and it is what tells you the comparison is
honest rather than reporting every node as changed.

### Resolutions

A `person` finding waits for one of three answers, for a node or for one of its
properties:

| | |
| --- | --- |
| `take-bundle` | the bundle wins |
| `keep-local` | keep what is here |
| `skip` | leave the node alone entirely — a whole node only |

```bash
crombolo content check bundles/campaign-x --resolve 9a1f…=take-bundle
crombolo content check bundles/campaign-x --resolve 9a1f…/title=keep-local
crombolo content check bundles/campaign-x --resolve 9a1f…/heading@da-DK=keep-local
crombolo content check bundles/campaign-x --resolve-all take-bundle --save
```

The most specific answer wins: a property in one culture, then the property, then
the node (`"*"`), then `--resolve-all`. So `9a1f…=take-bundle` with
`9a1f…/title=keep-local` takes everything from the bundle except the title. A
mixed answer still writes **one** version holding each chosen value, and a revert
undoes it whole. Keeping every property that differs writes nothing.

```json
{
  "bundleId": "…",
  "under": null,
  "all": null,
  "byNode": {
    "9a1f…": { "*": "take-bundle", "title": "keep-local" }
  }
}
```

Each node maps `"*"` or a property handle (`alias`, or `alias@culture`) to an
answer. The earlier flat shape, a node key straight to an answer, is refused with
a message saying what is wanted.

`--save` writes `resolutions.json` beside the bundle, **by node key**, so the
decision is committed with the bundle and not worked out again in test and then
again in production — the argument
`packaging-and-upgrades.md` already makes for site-authored value migrations.
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

`content check --publish` says which pages would be refused, before anything is
written. It does this by **rehearsing** the import — running it with `--publish`
in a transaction that is always rolled back — so the rules, and their wording, are
publish's own rather than a second copy that could drift: an unpublished
ancestor, an unpublished mandatory language, an empty mandatory property. A page
whose parent goes live earlier in the same run is not refused, because in the
rehearsal it has. Each refusal is an `auto` finding, `publish-refused`: it never
holds an import up. The rehearsal runs only once nothing is outstanding, since
the import would stop before publishing anything, and media files are not placed.

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
`CROMBOLO_PG_DUMP`. That is the coarse layer underneath the fine-grained revert,
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

`schema-as-code.md` leaves the dictionary in the database — translators work
in production, where `schema/` is read-only — and promised these two commands as
how a lower environment gets the translations:

```
crombolo dictionary export --out <file.udt> [--key <uuid>]
crombolo dictionary import <file.udt>
```

It is Umbraco's own `.udt`, so a file exported from an Umbraco site imports here
and the other way round. Items **upsert by key**, so running an import twice is a
no-op, and an item translated here keeps any language the file does not carry.
A translation for a language this environment has not got is **skipped rather
than refused** — Umbraco's behaviour — but the command says which, instead of
dropping it silently.

The implementation is shared with the Management API endpoint rather than
duplicated: `importDictionaryUdt` in `@crombolo/server`, which the adapter now
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

### In the backoffice

A check records the import as **pending** (migration 036, `transfer_pending`):
where the bundle was found — a package the site depends on, or a directory on
this server — and what the check was asked to do, such as placing it under a
node or publishing. An install from the Packages section that the check refuses
is recorded the same way. The Changes dashboard lists each pending import under
its bundle's name, and offers each finding the answers its code allows
(`choicesFor`, beside `resolutionsFor`, so the two lists stay in step):

| Finding | Offered |
| --- | --- |
| `local-edit` | use the incoming version, or keep this site's, for that property; or leave the item out |
| `local-trashed`, `name-collision`, `unresolved-reference`, `missing-blob` | leave the item out |
| `missing-blob` | also: import even where a media file is missing, for the whole bundle |

A blocking finding offers nothing to choose: it needs a deployment or a change
to the site, and the dashboard says so. Choosing records the answer in
`transfer_answer` against the node and property handle, exactly as
`--resolve <key>/<handle>=<choice>` would, and re-checks at once, so the finding
resolves and the counts move. An answer can be taken back. **Import** is offered
once nothing is outstanding; it runs the same `installBundleContent` the CLI
does, re-checking inside the lock, and shows what it created, updated and
published, and anything publish refused. On Postgres with no backup command
configured, the person is asked to confirm a backup was taken, as
`--backup-taken` does. A successful import clears what was pending.

The answers are stored in the database, not written beside the bundle: an
installed bundle lives in `node_modules`, which a redeploy replaces and which
other nodes do not share. At import they sit between the bundle's own
`resolutions.json` and anything given on the command line. **Download answers**
returns the `resolutions.json` that `--save` would write for the same choices,
to commit with the bundle so the next environment needs no answers.

The actions, and the answers offered, are for users with the Packages section,
as installing a bundle is; everyone with Settings still sees the findings.
`tests/transfer-dashboard.test.ts`.

## Commands

```
crombolo content export --root <path|uuid> [--root …] --out <dir>
                        [--only] [--drafts] [--with-blueprints]
                        [--include-content [--with-blobs] [--allow-content-unencrypted]]
                        [--with-members] [--with-users]

crombolo content export … [--name <npm name>] [--package-version <version>]

crombolo content check <pkg>          a package directory, or a bundle this site depends on
                        [--under <path|uuid>] [--resolve <key>[/<alias>[@<culture>]]=<choice>]
                        [--resolve-all <choice>] [--allow-missing-blobs] [--save]
                        [--publish]   say which pages publishing would refuse

crombolo content import <pkg>
                        [--publish] [--label <text>] [--backup-taken] + the check flags
                        [--no-schema] [--no-files]  decline a section the bundle carries
                        [--replace-files]           allow replacing files this site has
crombolo content runs   [--limit N]
crombolo content revert <run-id>
                        [--resolve <key>=discard|skip] [--resolve-all <choice>]
                        [--force] [--backup-taken]

crombolo bundle check   <pkg>     alias of `content check`
crombolo bundle install <pkg>     alias of `content import`

crombolo dictionary export --out <file.udt> [--key <uuid>]
crombolo dictionary import <file.udt>

crombolo content publish <path|uuid>
                        [--descendants] [--culture <iso>]... [--at <when>] [--until <when>]
crombolo content unpublish <path|uuid>
                        [--descendants] [--culture <iso>]...

crombolo start --bundle <pkg>
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
starter template's content reaches a new site (`crombolo init --template`) and how
a container can bring its own content with it. It imports **once per bundle** —
an import run still standing here means this site has that content already, so a
restart is a query and a line in the banner — and a refusal stops the boot rather
than serving a site missing the content the command line asked for. The import
runs after the schema sync, which is what gives the bundle its content types.

### What travels, and what did not

Two things a bundle carries were being dropped on import, and are not any more:

- **Sort order.** Nodes arrived in the order the run happened to create them, so
  a site's navigation came out shuffled. The nodes a run creates are now placed
  among themselves in the bundle's order; siblings that were already there keep
  their places, so an import still appends rather than rearranging a tree.
- **Media types.** A media node's type is a different object type, and both the
  check and the importer resolved content types only among content types — so
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

Without the flag the bundle carries no media file, and the export says so
rather than leaving it to be discovered at the other end. `--with-blobs` needs
`--include-content`: a media file is content, and is sealed with the values.

### Still open

- **The down direction.** `crombolo clone --anonymise`: a whole-environment copy
  for developing against, which is mostly orchestration over `pg_dump` or a file
  copy plus a media sync — but needs a sanitise step, because production users,
  members, tokens and e-mail addresses must not land on a laptop. Story `100`.

## Moving content between environments

A deploy promotes files, never content. Moving content is a separate, explicit
act producing a **bundle**: a private npm package holding one JSON file per node
plus a manifest, reviewable in a diff, committable, and carrying no integer ids —
only keys and aliases (`docs/content-transfer.md`). There is no connection between environments and
no credentials for one stored in another; the bundle travels as a file does.

```bash
# where the content is
bunx crombolo content export --root "/Campaigns/Autumn 2026" --out bundles/campaign-x
bunx crombolo content export --root 9a1f3c2e-… --only --drafts --out bundles/one-page
bunx crombolo content export --root "/Campaigns" --with-blobs --out bundles/campaign-x
                                      # …and the media bytes, so the bundle is self-contained

# where it is going: read-only, and non-zero while anything is outstanding
bunx crombolo content check bundles/campaign-x
bunx crombolo content check bundles/campaign-x --under "/Campaigns"
bunx crombolo content check bundles/campaign-x --resolve-all take-bundle --save

# apply it: re-checks, backs up, then writes in one transaction
bunx crombolo content import bundles/campaign-x
bunx crombolo content import bundles/campaign-x --publish --label "autumn campaign"
bunx crombolo content runs

# going live, separately from landing the content
bunx crombolo content publish "/Campaigns/Autumn 2026" --descendants
bunx crombolo content publish "/Campaigns/Autumn 2026" --at 2026-10-01T09:00
bunx crombolo content unpublish "/Campaigns/Autumn 2026"

```

`--root` and `--under` both take a path by name or a uuid, and the resolved uuid
is what lands in the manifest, so the artifact is identity-stable either way. A
published node carries its **published** values — what the site actually serves —
and an unpublished one carries its draft and says so. Members never travel, nor
does anything true of exactly one environment: domains, users, tokens, sessions,
redirects, schedules or access rules.

`check` is the dry run, and it runs before every import too: nothing is written
until the conflicts have been named and answered. It sorts each one into
**blocking** (the destination cannot honour the bundle — deploy `schema/`, or
re-root it), **needs a person** (importable once somebody picks `take-bundle`,
`keep-local` or `skip`) or **automatic** (what will happen, said out loud).
`--save` commits the answers to `resolutions.json` beside the bundle, by node
key and property, so a decision made once promotes with it rather than being worked out again
in every environment. Findings land in the **Changes** dashboard under the
bundle's own scope, so two bundles in flight do not resolve each other's.

`import` re-runs the check inside the content-tree lock, backs up as `upgrade`
does, and then writes in **one transaction** — so a failure anywhere leaves
nothing behind. Documents and elements arrive as **drafts** for a person to
publish; media is live as soon as it lands. `--publish` publishes what the
bundle says was live at the source, parents first. Values are applied as an
**overlay**, so a bundle carrying `title` cannot empty `summary`, and importing
the same bundle twice writes nothing the second time.

Each run is recorded with, per node, the event it was at and the event it was
serving, so `content revert <run-id>` can put the site back: values restored,
the published state restored (a page that was live goes live again with the old
values; one that was a draft stays a draft), and nodes the run created
unpublished and moved to the recycle bin rather than deleted. It refuses to
discard an edit somebody made since, or to undo a run a later one built on,
until told to. The revert is itself a run, so it can be reverted in turn.

```bash
bunx crombolo content runs
bunx crombolo content revert 5192ca80-…
bunx crombolo content revert 5192ca80-… --resolve-all discard   # over later edits

# the dictionary stays in the database, so it moves on its own
bunx crombolo dictionary export --out dictionary.udt
bunx crombolo dictionary import dictionary.udt
```

Site-authored value migrations live in `schema/migrations/*.ts`:

```ts
import { defineValueMigration } from "@crombolo/schema";

export default defineValueMigration({
    from: { type: "article", property: "summary" },
    to: { property: "intro" },
    convert: (summary) => `Intro: ${String(summary)}`,
});
```
