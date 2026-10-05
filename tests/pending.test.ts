/**
 * Pending elements: what `check --fix` creates early under a prepared state,
 * and what a file's `since` delays, is editable on the live site but never
 * required, never rendered, and never offered for creation — until the node
 * that reads it reaches that version. docs/09 "since"; docs/10 "Fix early".
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { toDocumentTypeResponse } from '@bunbraco/api-management'
import { hashPassword, passwordConfigJson } from '@bunbraco/auth'
import {
  bunbracoPlan,
  ContentTypeRepository,
  currentSchemaState,
  type Db,
  DocumentRepository,
  makeStateCurrent,
  migrate,
  type NodeSchemaState,
  PublishBlockedError,
  pendingUntil,
  seedContent,
  seedIdentity,
} from '@bunbraco/data'
import { loadSchemaDirectory, syncSchema } from '@bunbraco/schema'
import { canConnect, dialectUnderTest, freshDb } from './support/db.ts'

const open: Db[] = []
const dirs: string[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.close()
      .catch(() => {})
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

async function prepared(): Promise<Db> {
  const db = await freshDb()
  open.push(db)
  await migrate(db, bunbracoPlan)
  await seedIdentity(db, {
    admin: { name: 'A', login: 'a@b.c', email: 'a@b.c', password: 'x' },
    hashPassword,
    passwordConfig: passwordConfigJson(),
  })
  await seedContent(db)
  return db
}

function schemaDir(version: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(process.cwd(), 'output', 'pending-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'document-types'), { recursive: true })
  writeFileSync(join(dir, 'schema.toml'), `[schema]\nversion = "${version}"\n`)
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source)
  return dir
}

const ARTICLE_V1 = `[document-type]
key = "0b1c8e3a-2222-4a5b-9c1d-000000000001"
alias = "article"
name = "Article"
allow-at-root = true

[[property]]
key = "0b1c8e3a-2222-4a5b-9c1d-000000000002"
alias = "title"
name = "Title"
type = "textstring"
`

const ARTICLE_V2 = `${ARTICLE_V1}
[[property]]
key = "0b1c8e3a-2222-4a5b-9c1d-000000000003"
alias = "summary"
name = "Summary"
type = "textarea"
mandatory = true
`

const LANDING_SINCE = `[document-type]
key = "0b1c8e3a-2222-4a5b-9c1d-000000000010"
alias = "landing"
name = "Landing"
allow-at-root = true
since = "2.0.0"

[[property]]
key = "0b1c8e3a-2222-4a5b-9c1d-000000000011"
alias = "hero"
name = "Hero"
type = "textstring"
`

const V1: NodeSchemaState = { version: '1.0.0', revision: '1' }
const V2: NodeSchemaState = { version: '1.1.0', revision: '2' }

function page(typeKey: string, values: Record<string, string>) {
  return {
    key: crypto.randomUUID(),
    contentTypeKey: typeKey,
    parentKey: null,
    componentKey: null,
    variants: [{ culture: null, segment: null, name: 'Page' }],
    values: Object.entries(values).map(([alias, value]) => ({
      alias,
      culture: null,
      segment: null,
      value,
    })),
    userId: 1,
  }
}

describe('the pending rule', () => {
  test('a row is pending when its creating state or its file since is newer than the node', () => {
    const node = { version: '1.0.0', revision: '5' }
    expect(
      pendingUntil({ since: { version: '1.0.0', revision: '5' }, sinceVersion: null }, node),
    ).toBeNull()
    expect(
      pendingUntil({ since: { version: '1.0.0', revision: '6' }, sinceVersion: null }, node),
    ).toEqual({ version: '1.0.0', revision: '6' })
    expect(
      pendingUntil({ since: { version: '0.9.0', revision: '9' }, sinceVersion: '2.0' }, node),
    ).toEqual({ version: '2.0', revision: '0' })
    expect(pendingUntil({ since: null, sinceVersion: '1.0.0' }, node)).toBeNull()
  })
})

describe(`pending elements (${dialectUnderTest})`, () => {
  beforeAll(async () => {
    if (!(await canConnect())) throw new Error(`cannot connect to ${dialectUnderTest}`)
  })

  test('a property created early under a prepared state is editable, not required, not rendered, then live after the cut-over', async () => {
    const db = await prepared()
    // The live deployment
    const live = await syncSchema(
      db,
      loadSchemaDirectory(schemaDir('1.0.0', { 'document-types/article.toml': ARTICLE_V1 })),
      { nodeId: 'node-a', ...V1 },
      { mode: 'production' },
    )
    expect(live.action).toBe('applied')
    const typeKey = (await new ContentTypeRepository(db).byAlias('article'))?.key as string
    const oldNode = new DocumentRepository(db, { nodeState: V1, nodeId: 'node-a' })
    const existing = await oldNode.create(page(typeKey, { title: 'Existing' }))

    // `check --fix` from the next artifact: the mandatory summary arrives under a prepared state
    const early = await syncSchema(
      db,
      loadSchemaDirectory(schemaDir('1.1.0', { 'document-types/article.toml': ARTICLE_V2 })),
      { nodeId: 'cli', ...V2 },
      { mode: 'production', status: 'prepared' },
    )
    expect(early.action).toBe('applied')
    expect(early.created.properties).toBe(1)
    expect((await currentSchemaState(db)).version).toBe('1.0.0')

    // The live node sees it as pending
    const onOld = await new ContentTypeRepository(db, { nodeState: V1 }).byAlias('article')
    const summary = onOld?.properties.find((p) => p.alias === 'summary')
    expect(summary?.pending).toEqual({ version: '1.1.0', revision: '2' })
    expect(onOld?.properties.find((p) => p.alias === 'title')?.pending).toBeNull()
    const response = toDocumentTypeResponse(onOld as NonNullable<typeof onOld>)
    expect(response.properties.find((p) => p.alias === 'summary')?.name).toBe(
      'Summary (goes live in 1.1.0)',
    )
    expect(response.properties.find((p) => p.alias === 'summary')?.description).toContain(
      'editable now',
    )

    // …can publish without it, and can fill it in
    expect((await oldNode.publish(existing.key, null))?.key).toBe(existing.key)
    await oldNode.update({
      ...page(typeKey, { title: 'Existing', summary: 'filled early' }),
      key: existing.key,
    })
    expect((await oldNode.byKey(existing.key))?.values.map((v) => v.alias).sort()).toEqual([
      'summary',
      'title',
    ])
    await oldNode.publish(existing.key, null)
    // …but it is not in the published model on the old node
    const rendered = (await oldNode.loadPublished()).find((p) => p.key === existing.key)
    expect(rendered?.values.map((v) => v.alias)).toEqual(['title'])

    // A node at the new version requires it and renders it
    const newNode = new DocumentRepository(db, { nodeState: V2, nodeId: 'node-b' })
    const blank = await oldNode.create(page(typeKey, { title: 'Blank' }))
    await expect(newNode.publish(blank.key, null)).rejects.toBeInstanceOf(PublishBlockedError)
    await expect(newNode.publish(blank.key, null)).rejects.toThrow(/'Summary'/)
    expect(
      (await newNode.loadPublished())
        .find((p) => p.key === existing.key)
        ?.values.map((v) => v.alias)
        .sort(),
    ).toEqual(['summary', 'title'])

    // The cut-over: the prepared state becomes current, and the old node is now behind
    await makeStateCurrent(db, early.state?.id as number)
    expect((await currentSchemaState(db)).version).toBe('1.1.0')
    await expect(oldNode.publish(existing.key, null)).rejects.toThrow(/writes are refused/)
  })

  test('a type with since in its file is hidden from the create menu until its version, on every node', async () => {
    const db = await prepared()
    const dir = schemaDir('1.1.0', {
      'document-types/article.toml': ARTICLE_V1,
      'document-types/landing.toml': LANDING_SINCE,
    })
    expect(
      (
        await syncSchema(
          db,
          loadSchemaDirectory(dir),
          { nodeId: 'n', ...V2 },
          { mode: 'production' },
        )
      ).action,
    ).toBe('applied')
    const types = new ContentTypeRepository(db, { nodeState: V2 })
    const landing = await types.byAlias('landing')
    expect(landing?.sinceVersion).toBe('2.0.0')
    expect(landing?.pending).toEqual({ version: '2.0.0', revision: '0' })
    expect((await types.allowedAtRoot(0, 10)).items.map((t) => t.alias)).toEqual(['article'])
    // A node that has reached 2.0.0 offers it
    const later = new ContentTypeRepository(db, { nodeState: { version: '2.0.0', revision: '1' } })
    expect((await later.allowedAtRoot(0, 10)).items.map((t) => t.alias).sort()).toEqual([
      'article',
      'landing',
    ])
    // Without a node state nothing is pending: the CLI and sync read everything
    expect((await new ContentTypeRepository(db).byAlias('landing'))?.pending).toBeNull()
  })
})
