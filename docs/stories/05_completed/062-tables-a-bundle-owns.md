# 062 — Tables a bundle owns

**Epic:** G — Trusting and extending bundles · **Priority:** should · **Size:** L
**Depends on:** 063

## Story

As a bundle author, I want to declare database tables of my own and evolve them
across my bundle's releases, so that my bundle can keep state alongside content
without risking a site's core upgrades.

## Context

**What a bundle cannot do today.** A server bundle
([`bundles.md`](../../bundles.md), Part 3) stores nothing of its own. "Deliberately
not offered" rules out migrations and raw SQL, and the reason holds: a
migration arriving with a dependency is a schema change no `migration_history`
can account for. In practice that limits a bundle to whatever core already
stores, through the `documents` and `redirects` capabilities. A bundle that
tracks state alongside content, such as a task, an approval step or a log of
its own, has nowhere to put it except content nodes it doesn't own.

**This reverses that decision without dropping its reason.** The objection was
that core could not see or verify a bundle's schema changes. The answer is to
give each bundle its own ledgered migration chain, held to the same
expand/contract rules, gated by the same checks, and run by the same
`crombolo upgrade`. The bundle gets a builder confined to its own tables, never
a `Db`. Raw SQL stays unavailable.

**Why it cannot break a core upgrade.** Core and a bundle never touch the same
tables:

- A bundle's tables live under a reserved prefix that a bundle cannot leave and
  core never enters.
- A bundle refers to core data by **key** (the stable UUIDs the Management API
  already exposes), never by foreign key. A core migration therefore never
  cascades into a bundle table, and never fails on a constraint a bundle added.
- No views, triggers or functions are offered, because each one would make a
  core table rename or drop a bundle problem.

The rest of the design keeps the two chains in a fixed order, and stops either
from running against code that does not know its state.

**Decisions taken when this was planned:**

- Migrations are written with a declarative builder, not SQL.
- Runtime access goes through a scoped capability, with the guards below.
- A removed bundle's tables are kept until an explicit `purge`.

## Decisions

Taken before starting, 2026-10-14:

- **The capability is `context.host.tables`**, beside the other capabilities,
  offered, frozen and typed the same way. The examples below use it.
- **The `bundle` column is part of `migration_history` itself**, not a core
  migration: the ledger tables are created with it, and a table that predates
  it gains it the first time the ledger is read.
- **A backfill is the step's own `backfill(data)`**, not a second argument to
  `up`. `up(s)` returns the builder's operations and nothing else, so a step's
  checksum and its plan never depend on data, and the final table shapes can
  be worked out from the declaration's types.
- **A step's checksum is a hash of its recorded operations**, not of the SQL
  they render to, so it is the same on both dialects and survives a change to
  how core maps a column type.
- **`json` is TEXT on both dialects**, serialised and parsed by the capability.
  A filter on a `json` column is refused, bar `isNull` and `notNull`.
- **The guarantee test's early half** creates the fixture's tables and rows
  from its builder steps at core's first state, without the ledger, and walks
  the whole core plan forward from there.

## Acceptance criteria

**Declaring tables**

- [x] `ServerBundle` gains an optional `tables`, built with `defineBundleTables`,
      which `@crombolo/crombolo` exports beside the other bundle types.
- [x] The builder is the only way to write schema, with no raw-SQL escape hatch:
  - [x] Expands: `createTable`, `addColumn` (nullable or defaulted only),
        `addIndex` and `widenColumn`.
  - [x] Contracts: `dropTable`, `dropColumn` and `dropIndex`.
  - [x] Column types come from the dialect seam: `uuid`, `varchar(n)`, `text`,
        `integer`, `bigint`, `boolean`, `timestamp`, `json`.
- [x] Each step's state is derived from its `name` and position, and its
      checksum is a hash of the step's recorded statements. A step edited after
      it shipped makes the next upgrade refuse, naming the step.
- [x] A step may declare a `backfill(data)` over the scoped data API.
      `upgrade --plan` reports such a step as unplannable.

**Names**

- [x] Physical tables are `bundle_<id>__<table>`, with the id's hyphens written
      as underscores.
- [x] An id may not contain `--`, and a table or column name may not contain
      `__`. Names are `[a-z][a-z0-9_]*`.
- [x] Index names are generated as `bundle_<id>__ix_<hash>`, never chosen by the
      author.
- [x] `validateServerBundles` refuses at boot any physical name longer than
      Postgres's 63-character identifier limit.
- [x] Core reserves the `bundle_` prefix. A test records every core migration's
      statements through the recording `Db` and fails if any statement names a
      `bundle_` table.

**The ledger**

- [x] Each bundle's state lives in `key_value` under `Crombolo.Bundle.<id>.State`.
- [x] Its steps are recorded in `migration_history`, in a new nullable `bundle`
      column, created with the table (see Decisions).
- [x] The ledger writes reuse `recordInLedger`. `migrate` is generalised over
      the state key and runs under the same lock as core.

**Expand and contract, per bundle**

- [x] `MigrationPlan`'s lint runs over each bundle's steps, with `release` read
      as the **bundle's** version. A contract may only ship in a bundle major,
      and may only remove what an earlier bundle release added.
- [x] The bundle's `package.json` declares
      `"crombolo": { …, "migrations": "compatible" | "breaking" }`, derived
      from the plan the same way core's declaration is. Its manifest is read and
      validated in `backoffice-host/src/bundle-package.ts` (story 063).
- [x] `assertBundleTables(tables, version)` is exported, so a bundle's own test
      suite can enforce the same rules.

**Which core a bundle runs against**

- [x] A bundle with tables must declare
      `peerDependencies["@crombolo/crombolo"]`. Story 063 requires it of every
      bundle.
- [x] Boot refuses to mount a bundle whose range excludes the running `VERSION`,
      naming the bundle, its range and the running version. Built in 063
      (`validateServerBundles`, `peerRangeProblem`); the bundle's version is
      on `MountedBundle.package`.

**Order and gates**

- [x] `crombolo upgrade` applies core's pending steps first, then each bundle's,
      in the order `bundles` lists them.
- [x] `upgrade --plan` and `upgrade check` list bundle steps under their bundle.
      The upgrade dashboard and `/status` (`status.bundles[id].pending`) show
      them.
- [x] In production, boot refuses while any bundle step is pending, with
      `UpgradePendingError` naming the bundle. Development applies them
      automatically.
- [x] A database ahead of a bundle's code refuses with `UpgradeStateError`,
      naming the bundle and both states.
- [x] The pre-upgrade backup covers bundle tables. It does already, because they
      are in the same database; the test proves it.

**Runtime access: the `tables` capability**

- [x] A fourth capability, offered only to a bundle that declares `tables`, and
      resolved against that bundle's schema alone.
- [x] Operations: `select`, `count`, `insert`, `update`, `delete` and
      `transaction`.
- [x] Filters: equality, `in`, `lt`/`lte`/`gt`/`gte` and `isNull`/`notNull`,
      combined with `and`/`or`.
- [x] `update` and `delete` require a `where`. Unfiltered writes go through an
      explicit `truncate`.
- [x] The table set is the final shape of the plan, worked out once at boot and
      typed from the declaration. So `context.host.tables.task` is typed, and
      `context.host.tables.node` does not exist.

**Guards**

The requirement is that the capability can never reach outside the bundle's own
tables, and never reach a core table.

- [x] No identifier comes from the caller. Every table and column name is looked
      up in the bundle's resolved schema and quoted from there, and an unknown
      name is refused before any SQL is built. Values are always bound
      parameters.
- [x] No `Db` is reachable. The capability, every table handle and the
      transaction handle are frozen objects over a closure, with no connection,
      dialect, `raw` or `exec`. A test walks each object's own and prototype
      properties to prove it.
- [x] Every statement the capability or the builder emits passes through one
      guard function. It asserts that every table identifier carries the
      bundle's own prefix, and refuses the statement if not.
- [x] A hostile-input suite. Each of these is refused, or bound as a value, and
      never reaches SQL as an identifier:
  - [x] another bundle's logical and physical table names
  - [x] core table names: `node`, `umbraco_user`, `key_value`,
        `migration_history`
  - [x] quoted and escaped identifiers, `;`, comments and Unicode look-alikes
  - [x] `__proto__` and `constructor` keys in `where` and `set`
  - [x] nested filters at depth
- [x] A property-based test generates arbitrary filter objects and asserts on
      the guard function's view of every emitted statement.

**Where it runs, and removal**

- [x] The capability and bundle migrations run only on nodes that mount bundles,
      which are the ones that serve the backoffice. A `web` node neither
      applies bundle migrations nor checks their state at boot.
- [x] Taking a bundle out of `bundles` leaves its tables, state and ledger rows
      in place. Re-adding it resumes from its recorded state.
- [x] `crombolo bundle purge <id>` drops the bundle's tables and clears its
      state.
  - [x] It runs after the same backup `upgrade` takes, and is ledgered as kind
        `purge` against the bundle.
  - [x] It refuses while the bundle is still wired.
  - [x] It lists what it will drop and asks for confirmation, unless `--yes` is
        given.

**Tests**

The tests use a fixture bundle with two releases (an expand-only `1.x`, and a
`2.0.0` with a contract), run under both dialects.

- [x] The lint refuses a contract in a bundle minor, and a step edited after it
      shipped.
- [x] `upgrade --plan` shows the bundle's statements, and `upgrade` applies core
      and then the bundle.
- [x] Production boot refuses while a bundle step is pending. A bundle
      downgrade refuses, naming both states.
- [x] **The core-upgrade guarantee.** The fixture bundle is installed against the
      earliest core state the plan supports, then the whole core plan is
      walked forward from there. The bundle's tables and data come through
      untouched. The reverse order is tested too: the bundle installed at the
      final state.
- [x] A bundle whose peer range excludes the running version does not mount.
- [x] `purge` drops exactly the bundle's tables and nothing else.
- [x] **Exit:** the fixture bundle declares tables, upgrades across its own
      minor and major, and survives a walk of the entire core plan untouched,
      under both dialects. A deliberately escaping query is refused, whether
      it escapes by name, by injection or by reflection. `upgrade --plan` and
      the dashboard show bundle steps alongside core's.
- [x] [`bundles.md`](../../bundles.md) gets a Part 4 describing this as built,
      and "Deliberately not offered" is updated.

## Technical notes

A declaration looks like this:

```ts
export const tables = defineBundleTables('acme-tasks', [
  {
    name: 'tasks',
    release: '1.0.0',
    up: (s) =>
      s.createTable('task', {
        id: s.uuid().primaryKey(),
        node_key: s.uuid().indexed(),
        assignee: s.uuid().nullable(),
        status: s.varchar(32).default('open'),
        due: s.timestamp().nullable(),
      }),
  },
  {
    name: 'task-priority',
    release: '1.1.0',
    up: (s) => s.addColumn('task', 'priority', s.integer().default(0)),
  },
])
```

And a handler using the capability looks like this:

```ts
const open = await context.host.tables.task.select({
  where: { status: 'open', due: { lt: now } },
  orderBy: { due: 'asc' },
  limit: 50,
})
await context.host.tables.transaction(async (t) => {
  await t.task.update({ where: { id }, set: { status: 'done' } })
})
```

- **Chain identity.** Core's hand-written `from`/`to` states exist so that
  concurrent branches can be merged. A bundle's chain is linear and ordered by
  its author, so deriving states from name and position loses nothing.
- **Core's checksum.** Core's own ledger checksum is just `name` today. Moving
  core to a statement hash as well is a separate decision.
- **Names cannot collide.** Ids are lowercase letters, digits and hyphens.
  Forbidding `--` in ids and `__` in names makes the double underscore an
  unambiguous separator, so no two bundles can produce the same physical name.
- **Why the name length check exists.** Without it, Postgres would silently
  truncate a long identifier.
- **Order.** Running core first means a bundle step always runs against a core
  it declared itself compatible with.
- **Rolling out.** The `compatible`/`breaking` declaration lets an operator's
  upgrade tooling decide whether to roll out a bundle release node by node, on
  the same terms as a core release.
- **The peer range.** Without the check, a core major could boot a bundle
  written against an API core has since removed.
- **Rolling back** a bundle is a backup, as it is for core.
- **Guards and hostile code.** A bundle runs unsandboxed in the server process,
  so nothing here stops deliberately hostile code. These guards stop the
  capability from being the route out. They are tested as security properties,
  the way `tests/server-bundles.test.ts` treats the section gate. Core's
  `bundle_` reservation means a match on the prefix can only ever be the
  bundle's own table.
- **Web nodes.** Nothing on a web node reads bundle tables, because the
  capability is not offered there. Exposing bundle data to templates is a
  separate decision, and it would add the bundle chains to `attachDatabase`'s
  refusal when it is made.
- **Removal.** A removed bundle's tables sit behind the prefix, so they cannot
  collide with anything.
- **To confirm before starting:**
  - That `migrate` generalises over its state key without changing core's
    ledger rows.
  - That the guard can check statements token by token. It only ever sees SQL
    produced by the builder and the capability, which is regular enough for
    that, so it should need no general SQL parser.

## What was built

- **`data/src/bundle-tables/`** — `builder.ts` (the operations as data, and the
  types that work out each table's row from a declaration), `schema.ts`
  (`defineBundleTables`, `compileBundleTables` with every rule,
  `assertBundleTables`, `bundleTablesCompatibility`), `names.ts`, `ddl.ts`
  (operations to SQL on the dialect seam, which gained `varcharExact` and
  `json`), `guard.ts` (the token-by-token statement guard), `capability.ts`
  (the `tables` capability) and `chain.ts` (`bundlePlan`, purge, and the
  unledgered apply the guarantee test uses). Exported from `@crombolo/data`,
  and the authoring API from `@crombolo/crombolo`.
- **`migrations.ts`** — `MigrationPlan` takes a state key, an initial state and
  a bundle id; `migrate`, `readState`, `pendingMigrations`, `planUpgrade` and
  `stampFinalState` follow the plan's. `Migration` gained `checksum` and
  `backfill`. A bundle's applied steps are verified against their ledgered
  checksums (since its last purge) before it runs (`BundleStepEditedError`).
  `UpgradeStateError` names a bundle. `migration_history.bundle` is created
  with the table, and added to one that predates it; core's contract count
  ignores bundle rows.
- **Server** — `ServerBundle.tables`, the `tables` capability (typed through
  `ServerBundle<C, T>` and `HostFor`), and validation of the declaration, its
  id, and the package's `crombolo.migrations` against the plan.
  `server/src/bundle-tables.ts` builds the chains and plans, migrates and
  reports them. `bootstrapDatabase` and `installDatabase` take the chains;
  `UpgradePendingError` names bundles. Boot validates bundles before the
  database is touched, and only a node serving the backoffice builds chains.
  `/status` reports `bundles`, and the change report and Changes dashboard
  list each bundle's steps.
- **CLI** — `upgrade --plan`, `upgrade check` and `upgrade` show bundle steps
  under their bundle, `upgrade ledger` marks a bundle's rows, and
  `crombolo bundle purge <id> [--yes]` backs up, refuses while wired, lists
  and asks.
- **Tests** — `bundle-tables-rules.test.ts` (no database),
  `bundle-tables.test.ts` (both dialects: chain, capability, guards with the
  hostile-input suite and a seeded property test, the core-upgrade guarantee,
  the `bundle_` reservation, purge, boot and backup) and
  `bundle-tables-site.test.ts` (a real site wiring the fixture bundle in
  `tests/support/fixture-bundle.ts`). The Postgres test harness now drops
  `bundle_` tables when it resets a migrated schema.

## Out of scope

- Bundle tables travelling with content transfer or a created package
  ([`content-transfer.md`](../../content-transfer.md)). Bundle data stays in the
  database it was written in.
- Joins with core tables, or reads of them. A bundle that needs core data asks a
  core capability for it by key.
- Joins between a bundle's own tables, and aggregates beyond `count`, for now.
- Events from core, such as "this node was deleted". Without them, a bundle must
  tolerate keys that no longer resolve. That belongs with webhooks (044) and
  their in-process equivalent.
- A database role per bundle on Postgres. The guards are the enforcement;
  separate roles would split the connection pool and do nothing on SQLite.
