# Packaging and upgrades

Two questions that decide whether this is a framework or a monolith: how a site
consumes it, and what happens on a major version. They are designed together,
because the second is unsolvable without the first.

## Part 1 — The split between this repo and a site

### What a site looks like

```
my-site/
├── package.json          "bunbraco": "^1.0"
├── bunbraco.config.ts    site name, database, paths, providers
├── server.ts             import { bunbraco } from 'bunbraco'; Bun.serve(await bunbraco(config))
├── schema/               document types, data types, languages — see 09-schema-as-code.md
├── Views/                templates (.tsx)
├── App_Plugins/          backoffice extensions (later)
└── bunbraco.sqlite       content, users, versions — never schema
```

The site owns **files**; its **database** holds editorial data. The framework
ships the migrations and runs them.

### What had to change in this repo — done in 5a

An audit found four things that would have broken the moment a site imported
these packages. All four are fixed:

1. **The composition root is in the wrong place.** `apps/site/src/{server,ports,
   database,config,adapters/*}` — the wiring of repositories to API ports, the
   database bootstrap, the backoffice mount — lives in what should be the *site*.
   A consumer would have to copy ~600 lines and re-copy them on every upgrade.
   It moves to a framework package, `@bunbraco/server`, and `apps/site` becomes a
   true reference site: config, `Views/`, `schema/`, a three-line `server.ts`.
2. **Inter-package dependencies are undeclared.** Packages import
   `@bunbraco/core` 19 times, `@bunbraco/contracts` 5, `@bunbraco/data` 1 — all
   resolved by tsconfig `paths`, not `package.json`. Only `data` declares a
   dependency. The workspace has been masking this. Every package declares its
   dependencies as `workspace:*`; the umbrella `bunbraco` package depends on all.
3. **`vendorDir` is a relative path** from `import.meta.dir`. Under `node_modules`
   it points at nothing. It resolves `@bunbraco/backoffice-dist` instead.
4. **No `exports` fields** (except `render`). Packages work on Bun only because it
   runs `.ts` directly; there is no public/private boundary and so nothing to
   promise semver stability on. Each package gets an `exports` map; anything not
   listed is private.

### Packages

| Package | Contents | Who depends on it |
| --- | --- | --- |
| `bunbraco` | umbrella: re-exports `@bunbraco/server`, the CLI, the config type | **sites** |
| `@bunbraco/server` | the composition root, `bunbraco(config)`, ports and adapters | `bunbraco` |
| `@bunbraco/backoffice-dist` | **the built backoffice only** — static assets, ~90 MB, versioned in lockstep | `@bunbraco/backoffice-host` |
| `@bunbraco/core`, `data`, `auth`, `api-management`, `backoffice-host`, `render`, `contracts`, `schema`, `transfer` | as today, plus the schema package and `transfer` (the content bundle format — `13-content-transfer.md`) | `@bunbraco/server` |

**Why the built backoffice is its own package.** It changes only when the pinned
Umbraco version changes; the code packages change every release. Shipping it
inside `bunbraco` would put 90 MB in every patch. Building it on the user's
machine would need the ~30 bundling peer dependencies in their project and a
lifecycle script, which Bun disables for untrusted packages — so "it works after
`bun install`" could not be promised. A separate package is published from
`vendor/backoffice/` at release time, exactly as Umbraco ships
`Umbraco.Cms.StaticAssets`. Serving read-only files from `node_modules` at runtime
is fine.

### The two-axis version rule

A bunbraco major is a two-axis upgrade: our framework **and** the pinned Umbraco
backoffice, whose Management API contract changes between Umbraco majors.

**One Umbraco backoffice major per bunbraco major, never mixed.** `bunbraco@1`
pins `@umbraco-cms/backoffice@18`. The contract (`contracts/OpenApi.json`) is part
of the framework, not the site; a site never generates or vendors anything.

### The CLI

`bunx bunbraco <command>`, shipped in the umbrella package:

| Command | Does |
| --- | --- |
| `init` | scaffold a site: config, `schema/`, `Views/`, `server.ts` |
| `start` | run the site (what `start:local` does today, minus the password reset by default) |
| `upgrade check` / `upgrade check --fix` | the pre-upgrade report; with `--fix`, apply its additive part to the live site — Part 2 |
| `upgrade` / `upgrade --plan` | run the upgrade, gated on a clean check; `--plan` prints the DDL and conversions without executing |
| `schema sync` / `schema check [--static]` / `schema export` | apply `schema/`, validate it (and report what a sync would do), or write the database out as files |
| `generate` | emit TypeScript types from `schema/` |
| `admin reset-password` | what `start:local` does for the administrator |

## Part 2 — Promoting metadata, and upgrades

The daily case is not a framework upgrade. It is a developer adding a property
in development and promoting it to test and then production. The process is
designed for that first; a framework release is the same process with one more
source of change.

### One process, three sources of change

What is reconciled is always *what the deployed files say* against *what this
database has*. The difference can come from:

1. the site's `schema/` diff — daily;
2. the site's own value migrations (`schema/migrations/`) — when a change needs
   data moved, not just declared;
3. a framework release's migrations and converters — occasionally.

`bunbraco upgrade check` examines all three together; `upgrade` applies all
three. A framework upgrade is simply a release in which the third source is not
empty. Same commands, same ledger, same dashboard.

**Content is not promoted *by a deploy*.** Metadata flows development → test →
production; content lives where it is edited. Moving content — a campaign
promoted up, or production content pulled down to develop against — is a
separate, explicit act with its own artifact and its own audit trail:
`bunbraco content export/check/import`, in `13-content-transfer.md`. Nothing
about a deploy touches content.

### Why Umbraco majors hurt

Not DDL. In order:

1. **Schema and value migrations are conflated.** When a property editor changes
   its stored JSON shape, Umbraco rewrites every `umbracoPropertyData` row
   eagerly, at upgrade, in-process. Hours on a large site; a half-migrated
   database if it fails; no way to see what will happen first.
2. **Opaque state.** One GUID in `umbracoKeyValue`. No record of what ran when,
   no view of the SQL before it runs.
3. **No way back.** Migrations are destructive within a release, so the previous
   version cannot run against the upgraded database. Downgrade is unsupported.

### Schema migrations

The state-chain model is kept (it handles concurrent development branches better
than sequence numbers) and hardened:

- **A ledger.** `migration_history(name, from_state, to_state, applied_at,
  duration_ms, checksum)` alongside the state key. Every upgrade is auditable and
  precisely resumable.
- **`bunbraco upgrade --plan`.** Runs each pending `up()` against a recording
  `Db` that captures statements instead of executing them, and prints the exact
  DDL. A migration that reads data to decide what to write is reported as
  unplannable rather than guessed at.
- **Expand/contract, enforced.** A migration declares itself `expand` or
  `contract`. An expand adds tables, columns, indexes, and never removes or
  renames. A contract may only remove what an expand introduced in an *earlier
  major*. The plan is linted at build time, so the rule cannot be broken by
  accident. Consequence: the previous version always boots against the upgraded
  database, which is what makes rolling back a release possible.
- **Boot refuses a database newer than the code.** Today that surfaces as
  "migration stalled"; it becomes an explicit message naming both versions.
- **Schema operations on the dialect seam.** `addColumn`, `addIndex`,
  `renameTable`, `dropColumn` — with SQLite's copy-table dance for the ones it
  cannot `ALTER` — so migration authors stop writing raw DDL twice.

### Value migrations: check, fix, then upgrade

When a release changes what the data must look like — a property editor's stored
format, a new required property, a new constraint — existing content has to be
brought into line. Rather than converting on the fly and running two versions
side by side (considered and rejected as too heavy), the design is a
**pre-upgrade phase** that proves and prepares the data while the current
version is still live, so that the upgrade itself has nothing left to fail on.

**The guarantee:** the upgrade never runs against data it has not already
verified and prepared. It cannot half-fail on content.

Two commands:

```
bunbraco upgrade check          read-only report of everything the upgrade would do to the data
bunbraco upgrade check --fix    applies the additive part now, on the live site
bunbraco upgrade                re-checks, backs up, contracts, cuts over, records the run
```

#### Three kinds of finding

The check classifies what it finds, because they resolve differently:

| Kind | Example | Resolved by |
| --- | --- | --- |
| **Auto-fixable** | a new required property that declares a `default`; a renamed alias; a backfill for a new column; a value-format conversion | the tool, mechanically |
| **Needs a person** | a required property with **no** default, missing on existing pages; a malformed value; a removed editor with more than one replacement | someone choosing or writing the value |
| **Blocking** | a type removed while content of it exists; a reference that resolves to nothing | the schema author changing the schema |

A `default` in the schema file is what moves a finding from the second row to
the first (`09-schema-as-code.md`). Each finding names the document, property
and culture, the reason, and links to the document in the backoffice.

#### Fix early, because fixing is expand

Some findings cannot be *reported*; they must be *made right*, and "made right"
can be structural. A required property that needs human values cannot be filled
in until the property **exists** — and in the live version, it does not yet. So
the pre-upgrade phase creates it.

That is safe because creating it is pure **expand**: a property type row, a
column, a table — all additive, all tolerated by the running version (its queries
name their columns, and the schema sync never deletes what files do not mention).
And it is useful: **the new field appears in the live backoffice**, so editors
fill it in with the site they already have, before any upgrade has happened.

It is safe for the *site* as well, because every element created early carries
the version it goes live in (`since`, `09-schema-as-code.md`), and the running
site treats anything newer than its own version as pending: editable in the
backoffice, **not enforced by validation**, not rendered, not in the Delivery
API. A new mandatory property therefore never blocks a publish on the live site,
and a template on the old version cannot accidentally render a half-filled
field. When the new checkout deploys, its `schema.toml` version makes the
elements live; there is no switch to flip.

So the upgrade splits along the expand/contract line *in time*:

1. **`upgrade check --fix`** applies everything additive: creates missing types,
   properties and columns — each stamped with the target version as `since` —
   applies declared defaults; backfills; renames. It takes the automatic backup
   first, and it is loud about being a write.
   `--set <type>.<property>=<value>` applies a chosen value everywhere it is
   missing, so a decision made once covers four hundred pages.
2. **People resolve what needs a person**, in the live backoffice, where the new
   fields now show. `check` is re-run until it is clean.
3. **`upgrade`** re-runs the check itself and refuses while anything still needs
   a person or is blocking (`--force` proceeds and records who, when and why).
   Then: backup, value conversions eager and in place, any contract the release
   carries, the ledger.

#### What the check covers

| Check | Example |
| --- | --- |
| Value conversions that would fail | malformed legacy JSON; a value of an unexpected type |
| Required data that is missing | a new mandatory property on existing pages |
| New constraints the data would violate | a unique index over existing duplicates; NOT NULL over nulls; orphaned references |
| Removed or renamed property editors still in use | with the editor to migrate to |
| Site schema changes (`schema/*.toml`) | the same categories, over the site's own diff |

The last row is the point: `bunbraco schema check` for a site's own schema diff
and `bunbraco upgrade check` for a framework release are **one mechanism** —
"what would this change do to the data, and what does it need?"

### In production

The check is data-dependent, so its results in one environment say nothing about
another. Every environment gets its own check, its own fixes and its own
upgrade. Staging rehearses the *mechanism*; only the production check tells you
what production *needs*. A deploy promotes nothing between environments except
files; content moves only when somebody transfers it
(`13-content-transfer.md`).

#### Three classes of change

`upgrade check` classifies the pending change, and the class decides the
deployment. A mandatory property without a default does not break *reads* — it
makes unfilled pages fail validation on their next edit, which is what Umbraco
does today — so it is a different class from a value-format change, which does.

| Class | Contains | Deploy | Data work |
| --- | --- | --- | --- |
| **Additive** | new types and properties, optional columns, configuration; **removing a property**, which retires it and keeps its data | rolling, zero downtime; the boot sync expands (a retirement waits for the cut-over when the change also needed a fix) | none |
| **Data-requiring** | mandatory without a default; a rename; a split or computed value | rolling, zero downtime | yes — before the deploy if pages are to stay valid, but deployable with pending items |
| **Breaking** | a value-format conversion | rolling, **readers unaffected**; old nodes go read-only for the conversion | yes, and it must be clean first |
| **Contract** | a **purge** of retired data; a column drop | a later release, once no node reads the old shape | — |

A per-environment policy decides whether data-requiring items **gate** a deploy:
`strict` for production; `pending-allowed` for development and test, where a
developer promotes and fills things in afterwards.

#### Site-authored value migrations

This is what stops the same fix-up being repeated in every environment, with
the content growing each time:

```
schema/migrations/0007-split-summary-into-intro-and-standfirst.ts
```

```ts
export default defineValueMigration({
  since: '2.4',
  from: { type: 'article', property: 'summary' },
  to: [{ property: 'intro' }, { property: 'standfirst' }],
  convert: (summary) => splitAtFirstParagraph(summary),
})
```

Written once in development, committed with the schema change it belongs to,
and run by `check --fix` in **every** environment against that environment's
content. Framework converters are the same construct, shipped by the framework.
The ledger records which have run where. What is left for people is only what
is genuinely editorial — a value someone has to decide — and defaults and
`--set` shrink even that.

#### Versioning without friction, and without committing from a pipeline

Daily changes cannot mean daily hand-edited version bumps — and a stamp written
into the repository by CI would have to be committed back, so that is ruled out
too. The version had been doing two jobs; they are separated:

| Job | Source | Lives in |
| --- | --- | --- |
| **Ordering** — an older node never writes over a newer database | a monotonic **revision** supplied at deploy time: the CI build number, or `git rev-list --count` | `BUNBRACO_SCHEMA_REVISION`, or a gitignored `schema/.revision` written into the *artifact* — never the repository |
| **Intent** — "this goes live from release X" | the human `version` in `schema.toml` | the repository; changed rarely, only to say something |

A deployment's identity is the pair `(version, revision)`, compared
lexicographically. Development runs at revision 0 and applies on hash
difference. The "same version, different content" rule becomes a sanity check:
an identical pair with a different hash means a modified tree was deployed under
the same revision — refuse.

`since` gets simpler. **The database row carries the exact `(version, revision)`
that created each element**; the file carries `since` only when a person wants
to delay something. That is what makes early creation correct: `check --fix`
runs from the new artifact at revision 4573 and stamps that on the rows; live
nodes at 4501 see them as pending; the deployment at 4573 makes them live. No
file is written and nothing is committed.

#### The promotion pipeline

```
PR              bunbraco schema check --static    parse; keys present; classify expand/contract;
                                                  a migration accompanies any rename or split
merge -> dev    boot sync applies; the developer fixes the three pages, or writes a migration
deploy -> test  check --fix runs the migrations against test content; the dashboard lists
                the rest; policy pending-allowed, so the deploy proceeds
deploy -> prod  check against production, read-only
                --fix runs the same migrations against production content
                editors resolve the remainder in the live backoffice
                check clean -> rolling deploy; or, for a breaking change, the window below
```

The static check runs on the pull request, before any environment is involved,
and it is the one that says: this rename has no migration — write one, or it is
data-requiring work in every environment it is promoted to.

#### A breaking change in production, step by step

No maintenance page. Values are append-only and tagged with the schema state
that wrote them (`02-data-model.md`), and **only a node at the current state may
write** — so an old node keeps serving reads at its own state, cannot corrupt
anything, and is drained by the load balancer.

| | Step | Who, from where | Live site |
| --- | --- | --- | --- |
| 1 | `upgrade check` | pipeline or operator, running the **new release's** CLI, read-only | unaffected |
| 2 | `upgrade check --fix` | operator; backup first | elements created early under a *prepared* state; old nodes fully writable; new fields pending in the backoffice |
| 3 | editors resolve every *needs a person* item | editors, in the **live** backoffice | unaffected |
| 4 | `upgrade check` until clean | pipeline | unaffected |
| 5 | `upgrade` | operator or pipeline; backup first | re-checks and refuses if anything is outstanding, then the state becomes *current*: **old nodes go read-only** and keep serving reads as-of their own state; the converted versions `--fix` appended become the ones new nodes read |
| 6 | start new nodes | pipeline | they read as-of the new state: converted values; editing resumes here |
| 7 | stop old nodes | pipeline | — |

Readers never see a maintenance page. Editors on old nodes are paused for the
length of the conversion — seconds to minutes — and new nodes accept edits as
soon as they are up. The CLI runs from the new release against the database,
never on a live node; `upgrade` holds the content-tree lock and re-runs the
check inside it.

**Write gating, precisely.** Every write transaction reads the latest `current`
`schema_state` row — `FOR SHARE` on Postgres — and aborts with 409 if the
database is ahead of the node. `upgrade` takes the same row `FOR UPDATE` to
advance it, so a write either commits before the cut-over or is refused after
it. On its next cache-instruction poll an old node notices, switches to
read-only with a banner in the backoffice, and reports unhealthy so traffic
drains. A node *ahead* of the database refuses to boot until `upgrade` has run:
nodes must equal the current state — behind means read-only, ahead means wait.

**Contract is still a later release.** A purge or a column drop breaks old
*reads*, and old nodes read until they are stopped. The lint allows a contract
only against an expand from an earlier `current` state.

#### The upgrade dashboard ships in the first release

Step 3 is where the process lives, and editors do not read terminals. `check`
writes its findings to a `change_report` table with a **stable shape**; the
backoffice has a Changes dashboard reading it — counts by kind, each item with
a link to its page, items marked resolved as re-runs stop reporting them.

It must ship now rather than with the first real upgrade: during any future
upgrade the live backoffice is the *old* version, and it can only show findings
if it already knows how. A dashboard shipped first, against a stable table,
lets whatever version is live surface whatever the next version needs.

#### What stays true throughout

- Content editing never stops during steps 1–4; editors are doing the fixing,
  in the tool they use, on the live site. Schema editing is already off in
  production.
- Production Postgres backups are the operator's; `--fix` and `upgrade` refuse
  without `--backup-taken` or a configured `pg_dump` command. SQLite, which is
  single-node and rarely production, is copied automatically.
- Every step is recorded in the ledger with who, when and from which node.

### Two rules that follow

**Production never auto-upgrades.** Today boot migrates immediately, which would
defeat the check the moment a new version is installed and started. Development
auto-upgrades, running the check first and stopping on anything that needs a
person. Production requires an explicit `upgrade`; a boot with an upgrade pending
refuses with a message naming the versions and the command.

**Rollback is a backup.** In-place conversion is not reversible, so both `check
--fix` and `upgrade` take a backup before writing: for SQLite a timestamped copy
of the file next to the database; for Postgres, a refusal unless `--backup-taken`
is given or a `pg_dump` command is configured. Expand/contract on *schema* still
means the previous version's code runs against the upgraded database, so a
release that carried no value conversion rolls back cleanly — most releases.

### What this costs

- People must resolve their findings before an upgrade can proceed: a human
  step on the critical path, done in the tool they already use, and the step
  that makes the upgrade safe.
- A field can appear in the live backoffice before the deploy that introduces
  it. Deliberate — it is how it gets filled in — and gated by `since`, so it is
  badged as pending and has no effect on validation or the rendered site until
  its version deploys.
- Editors on old nodes are paused while `upgrade` converts — seconds to
  minutes, with no failure branch left in it. Readers are never interrupted.

### Site schema upgrades follow the same rules

A site's `schema/` files are code, so a change to them is a deploy and gets the
same discipline: removing a property leaves its values in place (expand), and a
later cleanup removes them (contract). `bunbraco schema check` is the same pre-upgrade
check run over a site's own diff, with the same `--fix`, and refuses a change
that would orphan content. And when a framework release changes the file vocabulary,
`bunbraco upgrade schema` rewrites every file canonically — a reviewable commit,
because we own the writer.

## Part 3 — Decisions taken when 5c was planned against 5b's code

These refine Part 2 rather than change it; `07-roadmap.md` has the slices.

- **Conversions run at `check --fix`, and only there.** Values are
  append-only and tagged with the state that wrote them, and a `--fix` writes
  under a *prepared* state that no live node reads as-of. So converting early
  costs nothing and removes the editor pause Part 2 budgeted for step 5.
  `upgrade` converts nothing: it re-runs the check, and a value an old node
  wrote after the fix that still needs converting is an outstanding finding,
  so it refuses until `check --fix` is run again. The guarantee tightens: the
  upgrade writes no content at all.
- **Pending is one comparison.** `since_state_id` (the deployment that created
  the row) and `since_version` (the file's explicit delay) both live on the
  element row; `isPending(row, nodeState)` is the only place the rule exists.
- **No client change for the pending badge.** Names and descriptions are
  decorated in the API response (`Title (goes live in 2.1)`). The shipped client
  code is a framework package on the same footing as an `App_Plugins` package —
  the upgrade and welcome dashboards, the read-only banner, the TSX editor entry
  point and the element-type hint. All of it is *registered* through
  `umbraco-package.json`, never patched into Umbraco's own elements, so an
  upstream bump cannot silently drop it; the one exception is the TSX entry point,
  which does patch, and says why in its own header.
- **Findings are per document and culture** with the backoffice link, upserted
  by `(code, subject, property, culture)` so a re-run resolves what it stops
  reporting rather than duplicating it.
- **Policy is an environment setting**: `BUNBRACO_UPGRADE_POLICY=strict|
  pending-allowed`, defaulting from `NODE_ENV`. `--force` overrides one run and
  is ledgered with the reason.
- **Health.** `/health` (non-contract) returns 200 at the current state and 503
  in compatibility mode or with an upgrade pending, so a load balancer drains
  an old node without the backoffice being involved.
- **Fresh databases install anywhere.** The production refusal to auto-migrate
  applies to an existing database with pending steps; the initial state is an
  install and proceeds, so a new environment needs no extra command.
- **Contract lint is by release.** A `contract` migration names the `expand`
  it removes, and the plan refuses unless the expand shipped in an earlier
  framework release — the same rule as "a later release", made checkable.

### As built

- **A prepared sync is additive only.** It creates types and properties and
  updates what is harmless, but an existing property keeps its editor and its
  optionality, and nothing is retired — those wait for the cut-over. Old nodes
  therefore stay exactly as writable as before `check --fix` ran; the report
  lists what was deferred.
- **Converted values are written into the target editor's storage column**
  under the prepared state, filed against the event of the row they convert,
  so a published version keeps reading as one version on either side of the
  cut-over.
- **Reads are as-of the node's state, drafts included.** An old node's editor
  shows old-format values, its renderer renders them, and re-saving an
  unchanged value appends nothing. What it *changes* becomes an
  `unconverted-value` finding, and `upgrade` refuses until `check --fix` has
  converted it again.
- **The report is a table with an endpoint.** `check`, `check --fix`,
  `upgrade` and a development boot write `change_report` under
  `source = 'upgrade'`;
  `GET <backoffice>/bunbraco/api/change-report` (session required) returns
  it with the node's health; the dashboard and the banner are a framework
  package served at `<backoffice>/bunbraco/`, registered like an
  `App_Plugins` package.
- **`/health`** answers 503 once the poll sees the database ahead of the node,
  and the document API answers 409 to its writes.
- **Backups**: SQLite is copied beside the file before `check --fix`,
  `upgrade` and `schema purge`; Postgres runs `BUNBRACO_PG_DUMP` or refuses
  without `--backup-taken`.
- **`schema purge --older-than <days>`** is the only thing that deletes
  values; it is ledgered as a contract step.
- **The framework's steps run before the site check** in `check --fix` and
  `upgrade` — they are expand-only and ledgered, so applying them ahead of a
  refusal costs nothing — while the read-only `check` on a database behind
  the framework lists those steps and defers the site part until they have
  run. The CLI therefore never needs the server's boot path, which in
  production refuses exactly this situation.

