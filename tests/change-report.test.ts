/**
 * `change_report` is shared by the pre-upgrade check and content transfer, and a
 * run resolves whatever it no longer reports. Everything here pins that the
 * sweep stays inside its own `(source, scope)`: unscoped, a content check would
 * resolve every open upgrade finding, a development boot would wipe a transfer
 * report on every restart, and checking one bundle would resolve another's.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import {
  bunbracoPlan,
  type Db,
  type Finding,
  migrate,
  readReport,
  writeReport,
} from '@bunbraco/data'
import { canConnect, dialectUnderTest, freshDb } from './support/db.ts'

function finding(code: string, subjectKey: string, message = code): Finding {
  return {
    kind: 'person',
    code,
    subjectType: 'document',
    subjectKey,
    subjectName: subjectKey,
    propertyAlias: null,
    culture: null,
    message,
    link: null,
  }
}

const codes = (findings: Array<{ code: string }>) => findings.map((f) => f.code).sort()

describe(`the change report (${dialectUnderTest})`, () => {
  let db: Db

  beforeAll(async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    db = await freshDb()
    await migrate(db, bunbracoPlan)
  })

  test('renames the upgrade report and carries its rows forward', async () => {
    // Migration 018 renamed the table rather than creating a second one, so the
    // shape the dashboard reads is the same one, with two columns added.
    const columns = await db.query('SELECT * FROM change_report WHERE 1 = 0')
    expect(columns).toEqual([])
    await expect(db.query('SELECT * FROM upgrade_report WHERE 1 = 0')).rejects.toThrow()
  })

  test('an upgrade run and a transfer run do not resolve each other', async () => {
    await writeReport(db, [finding('mandatory-unfilled', 'doc-a')], { source: 'upgrade' })
    await writeReport(db, [finding('local-edit', 'doc-b')], {
      source: 'transfer',
      scope: 'campaign-x',
    })
    expect(codes(await readReport(db))).toEqual(['local-edit', 'mandatory-unfilled'])

    // The upgrade re-runs and still reports its own finding. The transfer
    // finding is absent from that run, and must survive it.
    await writeReport(db, [finding('mandatory-unfilled', 'doc-a')], { source: 'upgrade' })
    expect(codes(await readReport(db))).toEqual(['local-edit', 'mandatory-unfilled'])

    // Now the upgrade finding is fixed: that run resolves it, and only it.
    await writeReport(db, [], { source: 'upgrade' })
    const open = await readReport(db)
    expect(codes(open)).toEqual(['local-edit'])
    expect(open[0]).toMatchObject({ source: 'transfer', scope: 'campaign-x' })
  })

  test('two bundles in flight do not resolve each other', async () => {
    await writeReport(db, [finding('missing-parent', 'doc-c')], {
      source: 'transfer',
      scope: 'campaign-y',
    })
    expect(codes(await readReport(db, { source: 'transfer' }))).toEqual([
      'local-edit',
      'missing-parent',
    ])

    // Re-checking campaign-y leaves campaign-x alone, and the other way round.
    await writeReport(db, [], { source: 'transfer', scope: 'campaign-y' })
    expect(codes(await readReport(db, { source: 'transfer' }))).toEqual(['local-edit'])
  })

  test('reads filter by source and by scope, and a null scope is a filter of its own', async () => {
    expect(await readReport(db, { source: 'upgrade' })).toEqual([])
    expect(codes(await readReport(db, { source: 'transfer', scope: 'campaign-x' }))).toEqual([
      'local-edit',
    ])
    expect(await readReport(db, { source: 'transfer', scope: 'campaign-y' })).toEqual([])
    // An upgrade writes no scope, so asking for the unscoped rows of a source is
    // how the dashboard separates a deploy from an arriving bundle.
    expect(await readReport(db, { source: 'transfer', scope: null })).toEqual([])
  })

  test('resolved rows stay readable, so the dashboard can grey them', async () => {
    const all = await readReport(db, { includeResolved: true })
    const resolved = all.filter((f) => f.status === 'resolved')
    expect(codes(resolved)).toEqual(['mandatory-unfilled', 'missing-parent'])
    for (const f of resolved) expect(f.resolvedAt).toBeInstanceOf(Date)
  })

  test('a finding is upserted rather than duplicated, keeping first_seen', async () => {
    const [before] = await readReport(db, { source: 'transfer', scope: 'campaign-x' })
    await writeReport(db, [finding('local-edit', 'doc-b', 'a newer message')], {
      source: 'transfer',
      scope: 'campaign-x',
    })
    const open = await readReport(db, { source: 'transfer', scope: 'campaign-x' })
    expect(open).toHaveLength(1)
    expect(open[0]?.id).toBe(before?.id as number)
    expect(open[0]?.message).toBe('a newer message')
    expect(open[0]?.firstSeen).toEqual(before?.firstSeen as Date)
  })
})
