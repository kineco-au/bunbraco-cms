# 062 — Tables a bundle owns

**Epic:** G — Trusting and extending bundles · **Priority:** should · **Size:** L
**Depends on:** —

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

## Acceptance criteria

**Declaring tables**

- [ ] `ServerBundle` gains an optional `tables`, built with `defineBundleTables`,
      which `@crombolo/crombolo` exports beside the other bundle types.
- [ ] The builder is the only way to write schema, with no raw-SQL escape hatch:
  - [ ] Expands: `createTable`, `addColumn` (nullable or defaulted only),
        `addIndex` and `widenColumn`.
  - [ ] Contracts: `dropTable`, `dropColumn` and `dropIndex`.
  - [ ] Column types come from the dialect seam: `uuid`, `varchar(n)`, `text`,
        `integer`, `bigint`, `boolean`, `timestamp`, `json`.
- [ ] Each step's state is derived from its `name` and position, and its
      checksum is a hash of the step's recorded statements. A step edited after
      it shipped makes the next upgrade refuse, naming the step.
- [ ] A step may take the scoped data API as a second argument, for backfills.
      `upgrade --plan` reports such a step as unplannable.

**Names**

- [ ] Physical tables are `bundle_<id>__<table>`, with the id's hyphens written
      as underscores.
- [ ] An id may not contain `--`, and a table or column name may not contain
      `__`. Names are `[a-z][a-z0-9_]*`.
- [ ] Index names are generated as `bundle_<id>__ix_<hash>`, never chosen by the
      author.
- [ ] `validateServerBundles` refuses at boot any physical name longer than
      Postgres's 63-character identifier limit.
- [ ] Core reserves the `bundle_` prefix. A test records every core migration's
      statements through the recording `Db` and fails if any statement names a
      `bundle_` table.

**The ledger**

- [ ] Each bundle's state lives in `key_value` under `Crombolo.Bundle.<id>.State`.
- [ ] Its steps are recorded in `migration_history`, in a new nullable `bundle`
      column. That column is itself a core expand, so it ships in a minor.
- [ ] The ledger writes reuse `recordInLedger`. `migrate` is generalised over
      the state key and runs under the same lock as core.

**Expand and contract, per bundle**

- [ ] `MigrationPlan`'s lint runs over each bundle's steps, with `release` read
      as the **bundle's** version. A contract may only ship in a bundle major,
      and may only remove what an earlier bundle release added.
- [ ] The bundle's `package.json` declares
      `"crombolo": { …, "migrations": "compatible" | "breaking" }`, derived
      from the plan the same way core's declaration is.
- [ ] `assertBundleTables(tables, version)` is exported, so a bundle's own test
      suite can enforce the same rules.

**Which core a bundle runs against**

- [ ] A bundle with tables must declare
      `peerDependencies["@crombolo/crombolo"]`.
- [ ] Boot refuses to mount a bundle whose range excludes the running `VERSION`,
      naming the bundle, its range and the running version. Nothing checks this
      today.

**Order and gates**

- [ ] `crombolo upgrade` applies core's pending steps first, then each bundle's,
      in the order `bundles` lists them.
- [ ] `upgrade --plan` and `upgrade check` list bundle steps under their bundle.
      The upgrade dashboard and `/status` (`status.bundles[id].pending`) show
      them.
- [ ] In production, boot refuses while any bundle step is pending, with
      `UpgradePendingError` naming the bundle. Development applies them
      automatically.
- [ ] A database ahead of a bundle's code refuses with `UpgradeStateError`,
      naming the bundle and both states.
- [ ] The pre-upgrade backup covers bundle tables. It does already, because they
      are in the same database; the test proves it.

**Runtime access: the `tables` capability**

- [ ] A fourth capability, offered only to a bundle that declares `tables`, and
      resolved against that bundle's schema alone.
- [ ] Operations: `select`, `count`, `insert`, `update`, `delete` and
      `transaction`.
- [ ] Filters: equality, `in`, `lt`/`lte`/`gt`/`gte` and `isNull`/`notNull`,
      combined with `and`/`or`.
- [ ] `update` and `delete` require a `where`. Unfiltered writes go through an
      explicit `truncate`.
- [ ] The table set is the final shape of the plan, worked out once at boot and
      typed from the declaration. So `context.tables.task` is typed, and
      `context.tables.node` does not exist.

**Guards**

The requirement is that the capability can never reach outside the bundle's own
tables, and never reach a core table.

- [ ] No identifier comes from the caller. Every table and column name is looked
      up in the bundle's resolved schema and quoted from there, and an unknown
      name is refused before any SQL is built. Values are always bound
      parameters.
- [ ] No `Db` is reachable. The capability, every table handle and the
      transaction handle are frozen objects over a closure, with no connection,
      dialect, `raw` or `exec`. A test walks each object's own and prototype
      properties to prove it.
- [ ] Every statement the capability or the builder emits passes through one
      guard function. It asserts that every table identifier carries the
      bundle's own prefix, and refuses the statement if not.
- [ ] A hostile-input suite. Each of these is refused, or bound as a value, and
      never reaches SQL as an identifier:
  - [ ] another bundle's logical and physical table names
  - [ ] core table names: `node`, `umbraco_user`, `key_value`,
        `migration_history`
  - [ ] quoted and escaped identifiers, `;`, comments and Unicode look-alikes
  - [ ] `__proto__` and `constructor` keys in `where` and `set`
  - [ ] nested filters at depth
- [ ] A property-based test generates arbitrary filter objects and asserts on
      the guard function's view of every emitted statement.

**Where it runs, and removal**

- [ ] The capability and bundle migrations run only on nodes that mount bundles,
      which are the ones that serve the backoffice. A `web` node neither
      applies bundle migrations nor checks their state at boot.
- [ ] Taking a bundle out of `bundles` leaves its tables, state and ledger rows
      in place. Re-adding it resumes from its recorded state.
- [ ] `crombolo bundle purge <id>` drops the bundle's tables and clears its
      state.
  - [ ] It runs after the same backup `upgrade` takes, and is ledgered as kind
        `purge` against the bundle.
  - [ ] It refuses while the bundle is still wired.
  - [ ] It lists what it will drop and asks for confirmation, unless `--yes` is
        given.

**Tests**

The tests use a fixture bundle with two releases (an expand-only `1.x`, and a
`2.0.0` with a contract), run under both dialects.

- [ ] The lint refuses a contract in a bundle minor, and a step edited after it
      shipped.
- [ ] `upgrade --plan` shows the bundle's statements, and `upgrade` applies core
      and then the bundle.
- [ ] Production boot refuses while a bundle step is pending. A bundle
      downgrade refuses, naming both states.
- [ ] **The core-upgrade guarantee.** The fixture bundle is installed against the
      earliest core state the plan supports, then the whole core plan is
      walked forward from there. The bundle's tables and data come through
      untouched. The reverse order is tested too: the bundle installed at the
      final state.
- [ ] A bundle whose peer range excludes the running version does not mount.
- [ ] `purge` drops exactly the bundle's tables and nothing else.
- [ ] **Exit:** the fixture bundle declares tables, upgrades across its own
      minor and major, and survives a walk of the entire core plan untouched,
      under both dialects. A deliberately escaping query is refused, whether
      it escapes by name, by injection or by reflection. `upgrade --plan` and
      the dashboard show bundle steps alongside core's.
- [ ] [`bundles.md`](../../bundles.md) gets a Part 4 describing this as built,
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
const open = await context.tables.task.select({
  where: { status: 'open', due: { lt: now } },
  orderBy: { due: 'asc' },
  limit: 50,
})
await context.tables.transaction(async (t) => {
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
