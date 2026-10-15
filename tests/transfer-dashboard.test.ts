/**
 * Story 103: a content import's conflicts are answered, and the import run,
 * from the Changes dashboard; the answers are those `--resolve` would give.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  answersByNode,
  ContentTypeRepository,
  DocumentRepository,
  type NodeRow,
  TransferAnswerRepository,
} from '@crombolo/data'
import { answerProblems, checkBundleContent, VERSION } from '@crombolo/server'
import {
  type ContentSet,
  choicesFor,
  exportBundle,
  newSeal,
  parseResolveFlags,
  resolutionsFor,
  writeBundle,
  writeBundlePackage,
  writeResolutions,
} from '@crombolo/transfer'
import { dialectUnderTest } from './support/db.ts'
import { BACKOFFICE, type Harness, signedInServer, signInAsGroup, V1 } from './support/harness.ts'

const PAGE_TOML = `[content-type]
alias = "page"
name = "Page"
allow-at-root = true
components = ["page"]
default-component = "page"

[[property]]
alias = "title"
name = "Title"
type = "textstring"

[[property]]
alias = "summary"
name = "Summary"
type = "textarea"
`

const API = `${BACKOFFICE}/crombolo/api`

const open: Harness[] = []
const dirs: string[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

interface Report {
  mayImport?: boolean
  transfers?: Array<{
    bundleId: string
    label: string
    answers: Array<{ nodeKey: string; handle: string; resolution: string }>
  }>
  findings: Array<{
    source: string
    scope: string
    code: string
    status: string
    subjectKey: string
    propertyAlias: string | null
    choices?: Array<{ handle: string; resolution: string }>
  }>
}

/** A page here, and a bundle package of the same page with both of its values changed. */
async function conflicted(sealedWith?: string) {
  const root = mkdtempSync(join(process.cwd(), 'output', 'transfer-dashboard-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'content-types'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'content-types', 'page.toml'), PAGE_TOML)
  writeFileSync(join(root, 'components', 'page.tsx'), 'export default () => <main />\n')
  const h = await signedInServer({
    config: { schemaDir: join(root, 'schema'), componentsDir: join(root, 'components') },
  })
  open.push(h)
  const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('page'))?.key as string
  const created = await h.post(`${V1}/document`, {
    documentType: { id: typeKey },
    template: null,
    parent: null,
    values: [
      { alias: 'title', culture: null, segment: null, value: 'Local title' },
      { alias: 'summary', culture: null, segment: null, value: 'Local summary' },
    ],
    variants: [{ culture: null, segment: null, name: 'Page' }],
  })
  expect(created.status).toBe(201)
  const key = created.headers.get('umb-generated-resource') as string
  const node = (await new DocumentRepository(h.server.db).nodes.byKey(key)) as NodeRow
  const { set } = await exportBundle(h.server.db, {
    roots: [node],
    asGiven: [key],
    descendants: true,
    snapshot: 'drafts',
    blueprints: false,
    withBlobs: false,
    siteName: 'Source',
    nodeId: 'source',
  })
  const changed: ContentSet = {
    ...set,
    nodes: set.nodes.map((n) => ({
      ...n,
      values: n.values.map((v) => ({
        ...v,
        value: v.property === 'title' ? 'Bundle title' : 'Bundle summary',
      })),
    })),
  }
  const dir = join(root, 'bundle')
  const info = {
    name: 'campaign',
    version: '1.0.0',
    id: 'campaign',
    label: 'Campaign',
    peerRange: `^${VERSION}`,
  }
  const payload = writeBundle(changed, undefined, [], {
    seal: sealedWith ? newSeal(sealedWith, { n: 2 ** 10, r: 8, p: 1 }) : undefined,
  })
  for (const file of writeBundlePackage(payload, { ...info, private: Boolean(sealedWith) })) {
    mkdirSync(join(dir, file.path, '..'), { recursive: true })
    writeFileSync(join(dir, file.path), file.bytes ?? (file.text as string))
  }
  // The check the CLI runs, which is what puts the import on the dashboard.
  const checked = await checkBundleContent(h.server.db, h.server.config, { bundle: dir })
  expect(checked.check.outstanding).toHaveLength(sealedWith ? 1 : 2)
  const bundleId = set.manifest.id
  const act = (verb: string, body: unknown = {}, client = h) =>
    client.post(`${API}/transfers/${bundleId}/${verb}`, body)
  const report = async (client = h) => client.json<Report>(`${API}/change-report`)
  const value = async (alias: string) =>
    (
      await new DocumentRepository(h.server.db, {
        nodeState: { version: '1.0.0', revision: '0' },
      }).byKey(key)
    )?.values.find((v) => v.alias === alias)?.value
  return { h, key, dir, bundleId, act, report, value }
}

describe('the answers a finding offers', () => {
  test('a differing property offers both versions, and leaving the item out', () => {
    expect(choicesFor({ code: 'local-edit', propertyAlias: 'title', culture: 'da-DK' })).toEqual([
      { handle: 'title@da-DK', resolution: 'take-bundle' },
      { handle: 'title@da-DK', resolution: 'keep-local' },
      { handle: '*', resolution: 'skip' },
    ])
  })

  test('every finding a person answers offers something, in step with the advice', () => {
    for (const code of [
      'local-edit',
      'missing-blob',
      'name-collision',
      'unresolved-reference',
      'person-conflict',
    ]) {
      expect(resolutionsFor(code).length, code).toBeGreaterThan(0)
      expect(
        choicesFor({ code, propertyAlias: 'title', culture: null }).length,
        code,
      ).toBeGreaterThan(0)
    }
    // Answered by deploying something, not by choosing.
    expect(
      choicesFor({ code: 'missing-content-type', propertyAlias: null, culture: null }),
    ).toEqual([])
  })

  test('an answer is checked before it is kept', () => {
    const nodeKey = '6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
    expect(answerProblems({ nodeKey, handle: 'title', resolution: 'keep-local' })).toEqual([])
    expect(answerProblems({ nodeKey, handle: 'title@en-US', resolution: null })).toEqual([])
    expect(
      answerProblems({ nodeKey: 'x', handle: 'title', resolution: 'keep-local' }),
    ).toHaveLength(1)
    expect(answerProblems({ nodeKey, handle: 'a b', resolution: 'keep-local' })).toHaveLength(1)
    expect(answerProblems({ nodeKey, handle: 'title', resolution: 'maybe' })).toHaveLength(1)
    expect(answerProblems({ nodeKey, handle: 'title', resolution: 'skip' })).toHaveLength(1)
  })

  test('stored answers come back by node, as resolutions.json holds them', () => {
    expect(
      answersByNode([
        { nodeKey: 'a', handle: '*', resolution: 'take-bundle' },
        { nodeKey: 'a', handle: 'title', resolution: 'keep-local' },
        { nodeKey: 'b', handle: '*', resolution: 'skip' },
      ]),
    ).toEqual({ a: { '*': 'take-bundle', title: 'keep-local' }, b: { '*': 'skip' } })
  })
})

describe(`answering and importing from the dashboard (${dialectUnderTest})`, () => {
  test('the dashboard lists the pending import, and offers each finding its answers', async () => {
    const { report, bundleId, key } = await conflicted()
    const read = await report()
    expect(read.mayImport).toBe(true)
    expect(read.transfers?.map((t) => [t.bundleId, t.label])).toEqual([[bundleId, 'Campaign']])
    const offered = read.findings.filter((f) => f.scope === bundleId && f.status === 'open')
    expect(offered.map((f) => f.propertyAlias).sort()).toEqual(['summary', 'title'])
    expect(offered.find((f) => f.propertyAlias === 'title')?.choices).toEqual([
      { handle: 'title', resolution: 'take-bundle' },
      { handle: 'title', resolution: 'keep-local' },
      { handle: '*', resolution: 'skip' },
    ])
    expect(offered[0]?.subjectKey).toBe(key)
  })

  test('answers are recorded and re-checked; the import waits until none is outstanding', async () => {
    const { act, key, value } = await conflicted()
    const first = await act('answer', { nodeKey: key, handle: 'title', resolution: 'keep-local' })
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ ok: true, outstanding: 1 })

    const early = await act('import', { backupTaken: true })
    expect(early.status).toBe(409)
    expect(await value('summary')).toBe('Local summary')

    const second = await act('answer', {
      nodeKey: key,
      handle: 'summary',
      resolution: 'take-bundle',
    })
    expect(await second.json()).toMatchObject({ ok: true, outstanding: 0 })
  })

  test('the answers download as the file the command line would have saved', async () => {
    const { h, act, key, bundleId, dir } = await conflicted()
    await act('answer', { nodeKey: key, handle: 'title', resolution: 'keep-local' })
    await act('answer', { nodeKey: key, handle: 'summary', resolution: 'take-bundle' })
    const downloaded = await h.call(`${API}/transfers/${bundleId}/resolutions`)
    expect(downloaded.status).toBe(200)
    expect(downloaded.headers.get('content-disposition')).toContain('resolutions.json')

    // What `content check --resolve … --save` writes for the same choices.
    const flags = parseResolveFlags([`${key}/title=keep-local`, `${key}/summary=take-bundle`])
    const viaFlags = await checkBundleContent(h.server.db, h.server.config, {
      bundle: dir,
      resolutions: flags.byNode,
    })
    expect(await downloaded.text()).toBe(
      writeResolutions({
        bundleId,
        under: null,
        all: viaFlags.decisions.all,
        byNode: viaFlags.decisions.byNode,
      }),
    )
  })

  test('the import runs from the dashboard, writes the chosen values, and clears what was pending', async () => {
    const { h, act, key, value, report, bundleId } = await conflicted()
    await act('answer', { nodeKey: key, handle: 'title', resolution: 'keep-local' })
    await act('answer', { nodeKey: key, handle: 'summary', resolution: 'take-bundle' })

    let imported = await act('import')
    if (dialectUnderTest === 'postgres') {
      // No backup command is configured, so a person has to confirm one was taken.
      expect(imported.status).toBe(409)
      expect(await imported.json()).toMatchObject({ needsBackup: true })
      imported = await act('import', { backupTaken: true })
    }
    expect(imported.status).toBe(200)
    expect(await imported.json()).toMatchObject({ ok: true, counts: { update: 1 } })
    expect(await value('title')).toBe('Local title')
    expect(await value('summary')).toBe('Bundle summary')
    expect((await report()).transfers).toEqual([])
    expect(await new TransferAnswerRepository(h.server.db).answers(bundleId)).toEqual([])
  })

  test('leaving the item out answers every one of its findings', async () => {
    const { act, key, value } = await conflicted()
    const answered = await act('answer', { nodeKey: key, handle: '*', resolution: 'skip' })
    expect(await answered.json()).toMatchObject({ outstanding: 0 })
    expect((await act('import', { backupTaken: true })).status).toBe(200)
    expect(await value('title')).toBe('Local title')
  })

  test('an answer can be taken back', async () => {
    const { act, key, report } = await conflicted()
    await act('answer', { nodeKey: key, handle: 'title', resolution: 'keep-local' })
    const cleared = await act('answer', { nodeKey: key, handle: 'title', resolution: null })
    expect(await cleared.json()).toMatchObject({ outstanding: 2 })
    expect((await report()).transfers?.[0]?.answers).toEqual([])
  })

  test('a malformed answer is refused, and an unknown bundle is not found', async () => {
    const { h, act, key } = await conflicted()
    expect(
      (await act('answer', { nodeKey: key, handle: 'title', resolution: 'skip' })).status,
    ).toBe(400)
    expect((await h.post(`${API}/transfers/not-a-bundle/check`, {})).status).toBe(404)
  })

  test('only those who may install packages see the answers or can act', async () => {
    const { h, act, key, report } = await conflicted()
    const groups = await h.post(`${V1}/user-group`, {
      name: 'Settings only',
      alias: 'settingsOnly',
      sections: ['Umb.Section.Settings'],
      languages: [],
      hasAccessToAllLanguages: true,
      documentRootAccess: true,
      documentStartNode: null,
      mediaRootAccess: true,
      mediaStartNode: null,
      elementRootAccess: false,
      elementStartNode: null,
      fallbackPermissions: [],
      permissions: [],
    })
    expect(groups.status).toBe(201)
    const settings = await signInAsGroup(h, 'settingsOnly')
    const seen = await report(settings)
    expect(seen.mayImport).toBe(false)
    expect(seen.findings.some((f) => f.choices)).toBe(false)
    expect(
      (await act('answer', { nodeKey: key, handle: 'title', resolution: 'keep-local' }, settings))
        .status,
    ).toBe(403)
    expect((await act('import', { backupTaken: true }, settings)).status).toBe(403)
  })
})

describe(`an encrypted import from the dashboard (${dialectUnderTest})`, () => {
  test('waits for the passphrase, refuses a wrong one, and is answered and imported with it', async () => {
    const PASS = 'a passphrase for the dashboard'
    const { act, report, value } = await conflicted(PASS)
    const sealed = await report()
    expect(sealed.findings.filter((f) => f.status === 'open').map((f) => f.code)).toEqual([
      'content-sealed',
    ])

    const wrong = await act('check', { passphrase: 'not this one' })
    expect(wrong.status).toBe(409)
    expect(await wrong.json()).toMatchObject({ ok: false, needsPassphrase: true })
    const blind = await act('import', { backupTaken: true })
    expect(blind.status).toBe(409)
    expect(await blind.json()).toMatchObject({ needsPassphrase: true })
    expect(await value('title')).toBe('Local title')

    const opened = await act('check', { passphrase: PASS })
    expect(await opened.json()).toMatchObject({ ok: true, outstanding: 2 })
    const local = (await report()).findings.filter(
      (f) => f.status === 'open' && f.code === 'local-edit',
    )
    expect(local).toHaveLength(2)
    for (const finding of local)
      await act('answer', {
        nodeKey: finding.subjectKey,
        handle: finding.propertyAlias,
        resolution: 'take-bundle',
        passphrase: PASS,
      })
    const imported = await act('import', { backupTaken: true, passphrase: PASS })
    expect(imported.status).toBe(200)
    expect(await value('title')).toBe('Bundle title')
  })
})
