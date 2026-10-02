/**
 * The current user's permission verbs — what makes the backoffice show Create,
 * Publish, Delete — and the development log of operations still answering 501.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { hashPassword, passwordConfigJson } from '@bunbraco/auth'
import {
  BUILT_IN_GROUP_PERMISSIONS,
  bunbracoPlan,
  type Db,
  migrate,
  STATE_RECYCLE_BIN,
  seedIdentity,
} from '@bunbraco/data'
import { freshDb, undoMigrationsSinceContentEditing } from './support/db.ts'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

const open: Harness[] = []
const dbs: Db[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
  while (dbs.length > 0)
    await dbs
      .pop()
      ?.close()
      .catch(() => {})
})

describe('permission verbs', () => {
  test("the administrator's fallback permissions are Umbraco's admin set, Create included", async () => {
    const h = await signedInServer()
    open.push(h)
    const me = await h.json<{ fallbackPermissions: string[]; permissions: unknown[] }>(
      `${V1}/user/current`,
    )
    expect(me.fallbackPermissions).toContain('Umb.Document.Create')
    expect(me.fallbackPermissions).toContain('Umb.Document.Publish')
    expect([...me.fallbackPermissions].sort()).toEqual(
      [...(BUILT_IN_GROUP_PERMISSIONS.admin ?? [])].sort(),
    )
    expect(me.permissions).toEqual([])
  })

  test('migration 007 grants the defaults to a database seeded without them, once', async () => {
    const db = await freshDb()
    dbs.push(db)
    await migrate(db, bunbracoPlan)
    await seedIdentity(db, {
      admin: { name: 'A', login: 'a@b.c', email: 'a@b.c', password: 'x' },
      hashPassword,
      passwordConfig: passwordConfigJson(),
    })
    const count = async () =>
      Number(
        (await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM user_group_permission'))[0]?.n,
      )
    const seeded = await count()
    const expected = Object.values(BUILT_IN_GROUP_PERMISSIONS).reduce(
      (n, list) => n + list.length,
      0,
    )
    expect(seeded).toBe(expected)

    // An older database: groups exist, permissions do not, and 007 has not run
    await db.exec('DELETE FROM user_group_permission')
    // …nor anything a later migration added
    await db.exec('DROP TABLE member_property_type')
    // …and before migration 010's tables
    await undoMigrationsSinceContentEditing(db)
    await db.exec("UPDATE key_value SET value = ? WHERE key = 'Bunbraco.Core.Upgrader.State'", [
      STATE_RECYCLE_BIN,
    ])
    const result = await migrate(db, bunbracoPlan)
    // 007, and whatever the plan has added since
    expect(result.applied[0]).toBe('GrantBuiltInGroupPermissions')
    expect(await count()).toBe(expected)
  })
})

describe('the development 501 log', () => {
  test('records each missing operation once, counting repeats, and leaves implemented ones alone', async () => {
    const h = await signedInServer({ config: { development: true } })
    open.push(h)
    expect(h.server.notImplemented.entries()).toEqual([])
    await h.call(`${V1}/health-check-group?skip=0&take=10`)
    await h.call(`${V1}/health-check-group?skip=0&take=10`)
    await h.call(`${V1}/telemetry?skip=0&take=10`)
    await h.call(`${V1}/document-type/configuration`)
    const entries = h.server.notImplemented.entries()
    expect(entries.map((e) => [e.operationId, e.method, e.path, e.count])).toEqual([
      ['GetHealthCheckGroup', 'GET', '/umbraco/management/api/v1/health-check-group', 2],
      ['GetTelemetry', 'GET', '/umbraco/management/api/v1/telemetry', 1],
    ])
  })

  test('is not wired up in production', async () => {
    const h = await signedInServer({ config: { development: false } })
    open.push(h)
    expect((await h.call(`${V1}/health-check-group?skip=0&take=10`)).status).toBe(501)
    expect(h.server.notImplemented.entries()).toEqual([])
  })
})
