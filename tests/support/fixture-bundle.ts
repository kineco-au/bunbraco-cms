/**
 * The fixture bundle story 062 is tested with: `acme-tasks`, in two releases.
 * 1.x only expands — a table, then a column with a backfill and an index — and
 * 2.0.0 contracts, removing a column 1.0.0 added.
 */
import { defineBundleTables } from '@crombolo/data'
import type { ServerBundle } from '@crombolo/server'
import { stubBundlePackage } from './bundles.ts'

export const TASKS_ID = 'acme-tasks'

const tasks = {
  name: 'tasks',
  release: '1.0.0',
  up: (s) =>
    s.createTable('task', {
      id: s.uuid().primaryKey(),
      node_key: s.uuid().indexed(),
      assignee: s.uuid().nullable(),
      status: s.varchar(32).default('open'),
      due: s.timestamp().nullable(),
      done: s.boolean().default(false),
      detail: s.json().nullable(),
      legacy: s.text().nullable(),
    }),
} as const satisfies Parameters<typeof defineBundleTables>[1][number]

const priority = {
  name: 'task-priority',
  release: '1.1.0',
  up: (s) => [
    s.addColumn('task', 'priority', s.integer().default(0)),
    s.addIndex('task', ['status', 'due']),
  ],
  // Urgent work keeps the priority it was always given.
  backfill: (data) => data.task.update({ where: { status: 'urgent' }, set: { priority: 9 } }),
} as const satisfies Parameters<typeof defineBundleTables>[1][number]

const dropLegacy = {
  name: 'drop-legacy',
  release: '2.0.0',
  up: (s) => s.dropColumn('task', 'legacy'),
} as const satisfies Parameters<typeof defineBundleTables>[1][number]

/** The 1.x line: expand only. */
export const tasksV1 = defineBundleTables(TASKS_ID, [tasks, priority])

/** 2.0.0: 1.x and a contract. */
export const tasksV2 = defineBundleTables(TASKS_ID, [tasks, priority, dropLegacy])

/** The package each release is, for what boot reads off it. */
export const tasksPackage = (version: '1.1.0' | '2.0.0') =>
  stubBundlePackage(TASKS_ID, {
    packageName: '@acme/tasks',
    version,
    name: 'Tasks',
    field: {
      id: TASKS_ID,
      server: 'tasks',
      migrations: version === '2.0.0' ? 'breaking' : 'compatible',
    },
  })

/** The bundle as a site wires it, at either release. */
export function tasksBundle(tables: typeof tasksV1 | typeof tasksV2 = tasksV1): ServerBundle {
  const bundle: ServerBundle<'tables', typeof tasksV1> = {
    id: TASKS_ID,
    section: 'settings',
    capabilities: ['tables'],
    tables: tasksV1,
    routes: [
      {
        method: 'POST',
        path: 'tasks',
        async handler({ request, host }) {
          const body = (await request.json()) as { id: string; node: string }
          await host.tables.task.insert({ id: body.id, node_key: body.node })
          // @ts-expect-error The capability is typed from the declaration: there is no `node` table.
          void host.tables.node
          return Response.json({ count: await host.tables.task.count() })
        },
      },
    ],
  }
  return { ...bundle, tables } as unknown as ServerBundle
}
