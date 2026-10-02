/**
 * Type proposals as the TOML file they become.
 *
 * A document type is a file in `schema/`, and that file is what gets committed —
 * so the proposal holds the file, the reviewer reads and edits the file, and
 * approving writes it and imports it. That is the same path a commit or another
 * node's publish takes, which is the point: one writer, one direction.
 *
 * It also means these do not go through `authorization.ts`, so what is held to
 * here includes the Settings check that replaces it.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AssistantProvider, ConverseResult, MessagePart } from '@bunbraco/assistant'
import { DEFAULT_BACKOFFICE_PATH } from '@bunbraco/core'
import { ContentTypeRepository } from '@bunbraco/data'
import { type Harness, signedInServer, signIn, V1 } from './support/harness.ts'

const dirs: string[] = []
const open: Harness[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const ASSISTANT = `${DEFAULT_BACKOFFICE_PATH}/bunbraco/api/assistant`

const says = (text: string): ConverseResult => ({
  message: { role: 'assistant', parts: [{ kind: 'text', text }] },
  wantsTools: false,
})

const uses = (...calls: { name: string; input: Record<string, unknown> }[]): ConverseResult => ({
  message: {
    role: 'assistant',
    parts: calls.map(
      (call, index): MessagePart => ({
        kind: 'tool-use',
        id: `call-${index}`,
        name: call.name,
        input: call.input,
      }),
    ),
  },
  wantsTools: true,
})

function programmable() {
  let turns: ConverseResult[] = []
  let at = 0
  return {
    provider: {
      name: 'programmable',
      async converse() {
        return turns[at++] ?? says('done')
      },
    } satisfies AssistantProvider,
    program(...next: ConverseResult[]) {
      turns = next
      at = 0
    },
  }
}

const HOME = `[document-type]
alias = "homePage"
name = "Home Page"
allow-at-root = true
`

async function site() {
  const schemaDir = mkdtempSync(join(process.cwd(), 'output', 'assistant-schema-'))
  dirs.push(schemaDir)
  mkdirSync(join(schemaDir, 'document-types'), { recursive: true })
  writeFileSync(join(schemaDir, 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(schemaDir, 'document-types', 'home-page.toml'), HOME)

  const model = programmable()
  const h = await signedInServer({
    config: { schemaDir, schemaWritable: true, assistant: { provider: model.provider } },
  })
  open.push(h)
  return { h, model, schemaDir }
}

const chat = (h: Harness, message: string) =>
  h.call(`${ASSISTANT}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  })

interface ChangesetJson {
  changes: { key: string; kind: string; status: string; problems: { message: string }[] }[]
}
const review = (h: Harness) => h.json<ChangesetJson[]>(`${ASSISTANT}/changesets`)

const ARTICLE = `[document-type]
alias = "article"
name = "Article"
allow-at-root = true

[[property]]
alias = "title"
name = "Title"
type = "textstring"
`

describe('proposing a type as TOML', () => {
  test('reads the file as it stands, so an existing type is changed rather than rewritten', async () => {
    const { h, model } = await site()
    model.program(
      uses({ name: 'read_schema', input: { kind: 'document-type', alias: 'homePage' } }),
      says('Read it.'),
    )
    const response = await chat(h, 'what does the home page look like?')
    const answer = (await response.json()) as { history: unknown[] }
    const seen = JSON.stringify(answer.history)
    expect(seen).toContain('schema/document-types/home-page.toml')
    expect(seen).toContain('alias = \\"homePage\\"')
  })

  test('a new type is proposed as its file, and approving writes and imports it', async () => {
    const { h, model, schemaDir } = await site()
    model.program(
      uses({
        name: 'propose_document_type',
        input: { alias: 'article', toml: ARTICLE, summary: 'Add an Article type' },
      }),
    )
    await chat(h, 'add an article type')

    const change = (await review(h))[0]?.changes[0]
    expect(change).toMatchObject({ kind: 'document-type-create', status: 'proposed' })
    // Nothing yet: no file, nothing in the database.
    expect(existsSync(join(schemaDir, 'document-types', 'article.toml'))).toBe(false)
    expect(await new ContentTypeRepository(h.server.db).byAlias('article')).toBeUndefined()

    expect((await h.post(`${ASSISTANT}/changes/${change?.key}/approve`, {})).status).toBe(200)

    const written = readFileSync(join(schemaDir, 'document-types', 'article.toml'), 'utf8')
    expect(written).toContain('alias = "article"')
    expect(await new ContentTypeRepository(h.server.db).byAlias('article')).toBeDefined()
  })

  test('the file is written canonically, not as the model happened to format it', async () => {
    const { h, model, schemaDir } = await site()
    const untidy = '[document-type]\n\n\nname   =   "Article"\nalias="article"\n'
    model.program(
      uses({
        name: 'propose_document_type',
        input: { alias: 'article', toml: untidy, summary: 'Add it' },
      }),
    )
    await chat(h, 'add it')
    const change = (await review(h))[0]?.changes[0]
    expect((await h.post(`${ASSISTANT}/changes/${change?.key}/approve`, {})).status).toBe(200)

    const written = readFileSync(join(schemaDir, 'document-types', 'article.toml'), 'utf8')
    // One layout, one key order: what the backoffice itself would write.
    expect(written.startsWith('[document-type]\n')).toBe(true)
    expect(written).not.toContain('name   =')
  })

  test('the version moves by what the change costs, through the same import', async () => {
    const { h, model, schemaDir } = await site()
    model.program(
      uses({
        name: 'propose_document_type',
        input: { alias: 'article', toml: ARTICLE, summary: 'Add it' },
      }),
    )
    await chat(h, 'add it')
    const change = (await review(h))[0]?.changes[0]
    await h.post(`${ASSISTANT}/changes/${change?.key}/approve`, {})

    const version = /version = "([^"]+)"/.exec(
      readFileSync(join(schemaDir, 'schema.toml'), 'utf8'),
    )?.[1]
    // A new type is additive, so a minor.
    expect(version).toBe('1.1.0')
  })

  test('TOML that will not parse is a problem on the proposal, not a surprise at approval', async () => {
    const { h, model } = await site()
    model.program(
      uses({
        name: 'propose_document_type',
        input: { alias: 'broken', toml: '[document-type\nalias = ', summary: 'Add it' },
      }),
    )
    await chat(h, 'add it')

    const change = (await review(h))[0]?.changes[0]
    expect(change?.problems.length).toBeGreaterThan(0)
    const approved = await h.post(`${ASSISTANT}/changes/${change?.key}/approve`, {})
    expect(approved.status).toBe(409)
  })

  test('a property naming a data type that does not exist is caught before approval', async () => {
    const { h, model } = await site()
    const bad = `${ARTICLE.replace('textstring', 'noSuchEditor')}`
    model.program(
      uses({
        name: 'propose_document_type',
        input: { alias: 'article', toml: bad, summary: 'Add it' },
      }),
    )
    await chat(h, 'add it')
    const change = (await review(h))[0]?.changes[0]
    expect(change?.problems.map((problem) => problem.message).join(' ')).toContain('noSuchEditor')
  })

  test('the review reads as the file: the TOML on disk beside the TOML proposed', async () => {
    const { h, model } = await site()
    const changed = HOME.replace('Home Page', 'Renamed Home')
    model.program(
      uses({
        name: 'propose_document_type',
        input: { alias: 'homePage', toml: changed, summary: 'Rename it' },
      }),
    )
    await chat(h, 'rename it')
    const change = (await review(h))[0]?.changes[0]

    const shown = await h.json<{ source: { before: string; after: string }; stale: boolean }>(
      `${ASSISTANT}/changes/${change?.key}/diff`,
    )
    expect(shown.source.before).toContain('Home Page')
    expect(shown.source.after).toContain('Renamed Home')
    expect(shown.stale).toBe(false)
  })

  test('a file changed after the proposal is marked stale', async () => {
    const { h, model, schemaDir } = await site()
    model.program(
      uses({
        name: 'propose_document_type',
        input: { alias: 'homePage', toml: HOME.replace('Home Page', 'A'), summary: 'Rename' },
      }),
    )
    await chat(h, 'rename it')
    const change = (await review(h))[0]?.changes[0]

    writeFileSync(
      join(schemaDir, 'document-types', 'home-page.toml'),
      HOME.replace('Home Page', 'Somebody Else'),
    )
    const shown = await h.json<{ stale: boolean }>(`${ASSISTANT}/changes/${change?.key}/diff`)
    expect(shown.stale).toBe(true)
  })
})

describe('who may apply a type proposal', () => {
  test('a user without Settings is refused, even though they own the proposal', async () => {
    const { h, model } = await site()
    model.program(
      uses({
        name: 'propose_document_type',
        input: { alias: 'article', toml: ARTICLE, summary: 'Add it' },
      }),
    )

    // A writer: content, not settings.
    const groups = await h.json<{ items: { id: string; alias: string }[] }>(
      `${V1}/user-group?take=100`,
    )
    const writer = groups.items.find((group) => group.alias === 'writer')?.id as string
    expect(writer).toBeTruthy()
    const created = await h.post(`${V1}/user`, {
      kind: 'Default',
      email: 'writer@example.com',
      userName: 'writer@example.com',
      name: 'A Writer',
      userGroupIds: [{ id: writer }],
    })
    const key = created.headers.get('umb-generated-resource') as string
    const reset = await h.json<{ resetPassword: string }>(`${V1}/user/${key}/reset-password`, {
      method: 'POST',
    })
    const theirs = await signIn(h.server, {
      username: 'writer@example.com',
      password: reset.resetPassword,
    })

    // They raise it themselves, so ownership is not what stops them.
    await theirs.call(`${ASSISTANT}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'add it' }),
    })
    const change = (await theirs.json<ChangesetJson[]>(`${ASSISTANT}/changesets`))[0]?.changes[0]
    expect(change?.kind).toBe('document-type-create')

    const refused = await theirs.post(`${ASSISTANT}/changes/${change?.key}/approve`, {})
    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain('Settings')
    expect(await new ContentTypeRepository(h.server.db).byAlias('article')).toBeUndefined()
  })

  test('a read-only schema directory refuses it, naming source control', async () => {
    const schemaDir = mkdtempSync(join(process.cwd(), 'output', 'assistant-readonly-'))
    dirs.push(schemaDir)
    mkdirSync(join(schemaDir, 'document-types'), { recursive: true })
    writeFileSync(join(schemaDir, 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    writeFileSync(join(schemaDir, 'document-types', 'home-page.toml'), HOME)

    const model = programmable()
    const h = await signedInServer({
      config: { schemaDir, schemaWritable: false, assistant: { provider: model.provider } },
    })
    open.push(h)
    model.program(
      uses({
        name: 'propose_document_type',
        input: { alias: 'article', toml: ARTICLE, summary: 'Add it' },
      }),
    )
    await chat(h, 'add it')
    const change = (await review(h))[0]?.changes[0]

    const refused = await h.post(`${ASSISTANT}/changes/${change?.key}/approve`, {})
    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain('source control')
    expect(existsSync(join(schemaDir, 'document-types', 'article.toml'))).toBe(false)
  })
})
