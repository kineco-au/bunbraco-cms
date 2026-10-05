/**
 * The append-only value model's own guarantees, tested at the data layer.
 * docs/02-data-model.md, "Values are append-only".
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { hashPassword, passwordConfigJson } from '@bunbraco/auth'
import {
  appendSchemaState,
  BASELINE_NODE_STATE,
  bunbracoPlan,
  ContentTypeRepository,
  compareVersions,
  currentSchemaState,
  type Db,
  DocumentRepository,
  makeStateCurrent,
  migrate,
  seedContent,
  seedIdentity,
  WriteRejectedError,
} from '@bunbraco/data'
import { canConnect, dialectUnderTest, freshDb } from './support/db.ts'

const TEXTSTRING = '0cc0eba1-9960-42c9-bf9b-60e150b429ae'
const open: Db[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.close()
      .catch(() => {})
})

async function prepared(): Promise<{ db: Db; typeKey: string }> {
  const db = await freshDb()
  open.push(db)
  await migrate(db, bunbracoPlan)
  await seedIdentity(db, {
    admin: { name: 'A', login: 'a@b.c', email: 'a@b.c', password: 'x' },
    hashPassword,
    passwordConfig: passwordConfigJson(),
  })
  await seedContent(db)
  const typeKey = crypto.randomUUID()
  await new ContentTypeRepository(db).save({
    key: typeKey,
    alias: 'page',
    name: 'Page',
    description: null,
    icon: 'icon-document',
    allowedAsRoot: true,
    variesByCulture: false,
    variesBySegment: false,
    isElement: false,
    allowedInLibrary: false,
    collectionKey: null,
    cleanup: {
      preventCleanup: false,
      keepAllVersionsNewerThanDays: null,
      keepLatestVersionPerDayForDays: null,
    },
    containers: [],
    properties: [prop('title', TEXTSTRING, 0), prop('summary', TEXTSTRING, 1)],
    compositions: [],
    allowedContentTypes: [],
    allowedComponentKeys: [],
    defaultComponentKey: null,
    parentKey: null,
  })
  return { db, typeKey }
}

function prop(alias: string, dataTypeKey: string, sortOrder: number) {
  return {
    key: crypto.randomUUID(),
    alias,
    name: alias,
    description: null,
    dataTypeKey,
    containerKey: null,
    sortOrder,
    variesByCulture: false,
    variesBySegment: false,
    mandatory: false,
    mandatoryMessage: null,
    regEx: null,
    regExMessage: null,
    labelOnTop: false,
  }
}

const invariant = (alias: string, value: unknown) => ({
  alias,
  culture: null,
  segment: null,
  value,
})
const save = (key: string, typeKey: string, values: Array<{ alias: string; value: unknown }>) => ({
  key,
  contentTypeKey: typeKey,
  componentKey: null,
  parentKey: null,
  values: values.map((v) => invariant(v.alias, v.value)),
  variants: [{ culture: null, segment: null, name: 'Page' }],
})

async function valueRows(db: Db, key: string) {
  return db.query<{
    alias: string
    event_id: number
    is_current: unknown
    varchar_value: string | null
    schema_state_id: number
  }>(
    `SELECT p.alias, pv.event_id, pv.is_current, pv.varchar_value, pv.schema_state_id
     FROM property_value pv JOIN property_type p ON p.id = pv.property_type_id JOIN node n ON n.id = pv.node_id
     WHERE n.unique_id = ? ORDER BY pv.id`,
    [key],
  )
}

describe('compareVersions', () => {
  test('compares numerically per segment', () => {
    expect(compareVersions('2.1', '2.1')).toBe(0)
    expect(compareVersions('2.1', '2.10')).toBe(-1)
    expect(compareVersions('2.1.4573', '2.1')).toBe(1)
    expect(compareVersions('0', '0.0.1')).toBe(-1)
  })
})

describe(`append-only values (${dialectUnderTest})`, () => {
  let available = true
  beforeAll(async () => {
    available = await canConnect()
  })

  test('an unchanged value appends nothing; a changed one appends exactly one row', async () => {
    if (!available) return
    const { db, typeKey } = await prepared()
    const repo = new DocumentRepository(db)
    const key = crypto.randomUUID()
    await repo.create(
      save(key, typeKey, [
        { alias: 'title', value: 'A' },
        { alias: 'summary', value: 'S' },
      ]),
    )
    expect(await valueRows(db, key)).toHaveLength(2)

    await repo.update(
      save(key, typeKey, [
        { alias: 'title', value: 'A' },
        { alias: 'summary', value: 'S' },
      ]),
    )
    // Same values: a save event, but no value versions.
    expect(await valueRows(db, key)).toHaveLength(2)

    await repo.update(
      save(key, typeKey, [
        { alias: 'title', value: 'B' },
        { alias: 'summary', value: 'S' },
      ]),
    )
    const rows = await valueRows(db, key)
    expect(rows).toHaveLength(3)
    expect(rows.filter((r) => r.alias === 'title').map((r) => r.varchar_value)).toEqual(['A', 'B'])
    // Exactly one current row per key, and it is the newest.
    const current = rows.filter((r) => r.is_current === true || r.is_current === 1)
    expect(current.map((r) => `${r.alias}=${r.varchar_value}`).sort()).toEqual([
      'summary=S',
      'title=B',
    ])
  })

  test('a value that stops being sent is cleared as a version, not deleted', async () => {
    if (!available) return
    const { db, typeKey } = await prepared()
    const repo = new DocumentRepository(db)
    const key = crypto.randomUUID()
    await repo.create(save(key, typeKey, [{ alias: 'title', value: 'A' }]))
    await repo.update(save(key, typeKey, []))
    const rows = await valueRows(db, key)
    expect(rows.map((r) => r.varchar_value)).toEqual(['A', null])
    expect((await repo.byKey(key))?.values).toEqual([])
    // History still has it.
    const versions = await repo.versions(key)
    const first = versions.at(-1)?.id as string
    await repo.rollback(first)
    expect((await repo.byKey(key))?.values.map((v) => v.value)).toEqual(['A'])
  })

  test('publish copies nothing: the published read is as-of the publish event', async () => {
    if (!available) return
    const { db, typeKey } = await prepared()
    const repo = new DocumentRepository(db)
    const key = crypto.randomUUID()
    await repo.create(save(key, typeKey, [{ alias: 'title', value: 'live' }]))
    const before = (await valueRows(db, key)).length
    await repo.publish(key, null)
    expect((await valueRows(db, key)).length).toBe(before)

    await repo.update(save(key, typeKey, [{ alias: 'title', value: 'draft' }]))
    const published = await repo.loadPublished()
    expect(published.find((p) => p.key === key)?.values.map((v) => v.value)).toEqual(['live'])
    expect((await repo.byKey(key))?.values.map((v) => v.value)).toEqual(['draft'])
  })

  test('a node reads as-of its own schema state, so a newer conversion is invisible to it', async () => {
    if (!available) return
    const { db, typeKey } = await prepared()
    const repo = new DocumentRepository(db)
    const key = crypto.randomUUID()
    await repo.create(save(key, typeKey, [{ alias: 'title', value: 'old-format' }]))
    await repo.publish(key, null)
    const oldState = await currentSchemaState(db)

    // A value migration by a newer deployment: appends a converted twin under
    // the SAME event with a newer schema state, so as-of reads pick it by
    // state, not by event.
    const newState = await appendSchemaState(db, { version: '1', revision: '0', status: 'current' })
    const [original] = await db.query<{
      id: number
      node_id: number
      property_type_id: number
      event_id: number
    }>(
      `SELECT pv.id, pv.node_id, pv.property_type_id, pv.event_id FROM property_value pv
       JOIN node n ON n.id = pv.node_id WHERE n.unique_id = ?`,
      [key],
    )
    await db.exec('UPDATE property_value SET is_current = ? WHERE id = ?', [
      db.dialect.boolValue(false),
      original?.id,
    ])
    await db.exec(
      `INSERT INTO property_value (node_id, property_type_id, event_id, schema_state_id, is_current, varchar_value)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        original?.node_id,
        original?.property_type_id,
        original?.event_id,
        newState.id,
        db.dialect.boolValue(true),
        'new-format',
      ],
    )

    const newNode = new DocumentRepository(db, { nodeState: { version: '1', revision: '0' } })
    expect((await newNode.loadPublished()).find((p) => p.key === key)?.values[0]?.value).toBe(
      'new-format',
    )
    expect(
      (await repo.loadPublished(oldState.id)).find((p) => p.key === key)?.values[0]?.value,
    ).toBe('old-format')
  })

  test('only a node at the current schema state may write', async () => {
    if (!available) return
    const { db, typeKey } = await prepared()
    const oldNode = new DocumentRepository(db, { nodeState: BASELINE_NODE_STATE })
    const key = crypto.randomUUID()
    await oldNode.create(save(key, typeKey, [{ alias: 'title', value: 'A' }]))

    // A prepared state does not gate: old nodes stay writable while editors fill things in.
    const preparedState = await appendSchemaState(db, {
      version: '1',
      revision: '0',
      status: 'prepared',
    })
    await oldNode.update(save(key, typeKey, [{ alias: 'title', value: 'B' }]))

    // The cut-over: the prepared state becomes current, and the old node is refused.
    await makeStateCurrent(db, preparedState.id)
    await expect(
      oldNode.update(save(key, typeKey, [{ alias: 'title', value: 'C' }])),
    ).rejects.toBeInstanceOf(WriteRejectedError)
    await expect(oldNode.publish(key, null)).rejects.toBeInstanceOf(WriteRejectedError)

    // It can still read.
    expect((await oldNode.byKey(key))?.values[0]?.value).toBe('B')

    // A node at the current state writes, and its rows carry that state.
    const newNode = new DocumentRepository(db, { nodeState: { version: '1', revision: '0' } })
    await newNode.update(save(key, typeKey, [{ alias: 'title', value: 'C' }]))
    const rows = await valueRows(db, key)
    expect(rows.at(-1)?.schema_state_id).toBe(preparedState.id)
  })

  test('the error names both states', async () => {
    if (!available) return
    const { db, typeKey } = await prepared()
    await appendSchemaState(db, { version: '3.2', revision: '77', status: 'current' })
    const oldNode = new DocumentRepository(db, { nodeState: { version: '3.1', revision: '90' } })
    try {
      await oldNode.create(save(crypto.randomUUID(), typeKey, []))
      throw new Error('expected rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(WriteRejectedError)
      expect((error as Error).message).toContain('3.1+90')
      expect((error as Error).message).toContain('3.2+77')
    }
  })
})

describe(`retirement (${dialectUnderTest})`, () => {
  let available = true
  beforeAll(async () => {
    available = await canConnect()
  })

  test('removing a property keeps every value, and re-adding it brings them back', async () => {
    if (!available) return
    const { db, typeKey } = await prepared()
    const types = new ContentTypeRepository(db)
    const docs = new DocumentRepository(db)
    const key = crypto.randomUUID()
    await docs.create(
      save(key, typeKey, [
        { alias: 'title', value: 'T' },
        { alias: 'summary', value: 'S' },
      ]),
    )

    // Drop `summary` from the type: retired, not deleted.
    const withoutSummary = (await types.byKey(typeKey)) as NonNullable<
      Awaited<ReturnType<typeof types.byKey>>
    >
    const summary = withoutSummary.properties.find((p) => p.alias === 'summary')
    await types.save({
      ...withoutSummary,
      properties: withoutSummary.properties.filter((p) => p.alias !== 'summary'),
    })

    expect((await types.byKey(typeKey))?.properties.map((p) => p.alias)).toEqual(['title'])
    expect((await types.retiredProperties(typeKey)).map((p) => p.alias)).toEqual(['summary'])
    // The editor no longer sees it…
    expect((await docs.byKey(key))?.values.map((v) => v.alias)).toEqual(['title'])
    // …but the rows are all still there.
    expect((await valueRows(db, key)).map((r) => r.alias).sort()).toEqual(['summary', 'title'])

    // Put it back under the same key: revived, values visible again.
    await types.save({
      ...withoutSummary,
      properties: [
        ...withoutSummary.properties.filter((p) => p.alias !== 'summary'),
        summary as NonNullable<typeof summary>,
      ],
    })
    expect(await types.retiredProperties(typeKey)).toEqual([])
    expect((await docs.byKey(key))?.values.map((v) => `${v.alias}=${v.value}`).sort()).toEqual([
      'summary=S',
      'title=T',
    ])
  })

  test('a save stamps new elements with the schema state that introduced them', async () => {
    if (!available) return
    const { db, typeKey } = await prepared()
    const state = await appendSchemaState(db, { version: '2', revision: '5', status: 'prepared' })
    const types = new ContentTypeRepository(db)
    const existing = (await types.byKey(typeKey)) as NonNullable<
      Awaited<ReturnType<typeof types.byKey>>
    >
    await types.save(
      { ...existing, properties: [...existing.properties, prop('intro', TEXTSTRING, 2)] },
      { sinceStateId: state.id },
    )
    const rows = await db.query<{ alias: string; since_state_id: number | null }>(
      'SELECT alias, since_state_id FROM property_type ORDER BY sort_order',
    )
    expect(rows.find((r) => r.alias === 'intro')?.since_state_id).toBe(state.id)
    // Pre-existing properties are untouched.
    expect(rows.find((r) => r.alias === 'title')?.since_state_id ?? null).toBeNull()
  })
})

describe(`revival through the API path (${dialectUnderTest})`, () => {
  test('a property removed and re-added with a new key but the same alias comes back with its values', async () => {
    const { db, typeKey } = await prepared()
    const types = new ContentTypeRepository(db)
    const type = (await types.byKey(typeKey)) as NonNullable<
      Awaited<ReturnType<typeof types.byKey>>
    >
    const title = type.properties.find(
      (p) => p.alias === 'title',
    ) as (typeof type.properties)[number]
    const repo = new DocumentRepository(db)
    const key = crypto.randomUUID()
    await repo.create(save(key, typeKey, [{ alias: 'title', value: 'kept' }]))

    // Removed…
    await types.save({ ...type, properties: [] })
    expect((await types.byKey(typeKey))?.properties).toEqual([])
    // …and re-added as the backoffice does: a fresh key, the same alias
    await types.save({ ...type, properties: [{ ...title, key: crypto.randomUUID() }] })
    const back = await types.byKey(typeKey)
    expect(back?.properties.map((p) => [p.key, p.alias])).toEqual([[title.key, 'title']])
    expect((await repo.byKey(key))?.values.map((v) => v.value)).toEqual(['kept'])
  })
})
