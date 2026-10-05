/**
 * The assistant end to end, with a programmable provider so the whole loop runs
 * with no network: the model asks for tools, the tools read the CMS and record
 * proposals, and a person approves them.
 *
 * What these hold to is the property the feature is built on — the assistant
 * changes nothing. A proposal leaves the database untouched until it is approved,
 * an approval saves a draft rather than publishing, and a proposal that has gone
 * stale is refused instead of overwriting what happened in between.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AssistantProvider,
  ConverseInput,
  ConverseResult,
  MessagePart,
} from '@bunbraco/assistant'
import { DEFAULT_BACKOFFICE_PATH } from '@bunbraco/core'
import { ComponentRepository, ContentTypeRepository } from '@bunbraco/data'
import { type Harness, signedInServer, signIn, signInAsGroup, V1 } from './support/harness.ts'

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

const HOME_PAGE_TOML = `[document-type]
alias = "homePage"
name = "Home Page"
icon = "icon-home"
allow-at-root = true
components = ["homePage"]
default-component = "homePage"

[[property]]
alias = "title"
name = "Title"
type = "textstring"

[[property]]
alias = "bodyText"
name = "Body"
type = "textarea"
`

const VIEW = `import type { PageProps } from 'bunbraco'
export default function HomePage({ model }: PageProps) {
  return <h1>{model.text('title')}</h1>
}
`

/** Where the plugin's own routes live: the backoffice mount point, not the API prefix. */
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

/**
 * A provider whose turns are set per test, because a scripted tool call needs the
 * keys of content the test creates after the server is up. Falls through to a
 * closing message, so the loop always terminates.
 */
function programmable() {
  let turns: ConverseResult[] = []
  let at = 0
  const seen: ConverseInput[] = []
  const provider: AssistantProvider = {
    name: 'programmable',
    async converse(input) {
      seen.push(input)
      return turns[at++] ?? says('done')
    },
  }
  let failure: string | undefined
  return {
    provider: {
      name: 'programmable',
      async converse(input) {
        if (failure) throw new Error(failure)
        return provider.converse(input)
      },
    } satisfies AssistantProvider,
    seen,
    program(...next: ConverseResult[]) {
      turns = next
      at = 0
      failure = undefined
      seen.length = 0
    },
    /** Makes the model unreachable, as an expired credential or a dropped network would. */
    breaks(message: string) {
      failure = message
    },
  }
}

async function site(options: { mcp?: boolean } = {}) {
  const root = mkdtempSync(join(process.cwd(), 'output', 'bunbraco-assistant-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'document-types', 'home-page.toml'), HOME_PAGE_TOML)
  writeFileSync(join(root, 'components', 'homePage.tsx'), VIEW)
  const model = programmable()
  const h = await signedInServer({
    config: {
      schemaDir: join(root, 'schema'),
      componentsDir: join(root, 'components'),
      assistant: { provider: model.provider, mcp: options.mcp === true },
    },
  })
  open.push(h)
  const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('homePage'))?.key as string
  const componentKey = (await new ComponentRepository(h.server.db).byAlias('homePage'))
    ?.key as string
  return { h, model, typeKey, componentKey }
}

async function createPage(h: Harness, typeKey: string, componentKey: string, name: string) {
  const response = await h.post(`${V1}/document`, {
    documentType: { id: typeKey },
    template: { id: componentKey },
    parent: null,
    values: [{ culture: null, segment: null, alias: 'title', value: 'Before' }],
    variants: [{ culture: null, segment: null, name }],
  })
  if (response.status !== 201) throw new Error(`create failed ${response.status}`)
  return response.headers.get('umb-generated-resource') as string
}

interface ChangesetJson {
  key: string
  origin: string
  changes: {
    key: string
    kind: string
    summary: string
    status: string
    effect: string
    problems: { message: string }[]
  }[]
}

const chat = (h: Harness, message: string, extra: Record<string, unknown> = {}) =>
  h.call(`${ASSISTANT}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, ...extra }),
  })

const review = (h: Harness) => h.json<ChangesetJson[]>(`${ASSISTANT}/changesets`)

/** Templates have no collection endpoint; the tree is what the Settings section lists. */
const componentAliases = async (h: Harness) => {
  const tree = await h.json<{ items: { id: string }[] }>(`${V1}/tree/template/root?take=100`)
  const aliases: string[] = []
  for (const item of tree.items) {
    const template = await h.json<{ alias: string }>(`${V1}/template/${item.id}`)
    aliases.push(template.alias)
  }
  return aliases
}

const titleOf = async (h: Harness, id: string) => {
  const document = await h.json<{ values: { alias: string; value: unknown }[] }>(
    `${V1}/document/${id}`,
  )
  return document.values.find((value) => value.alias === 'title')?.value
}

describe('proposing a page edit', () => {
  test('records the change, leaves the page alone, and applies as a draft when approved', async () => {
    const { h, model, typeKey, componentKey } = await site()
    const id = await createPage(h, typeKey, componentKey, 'Home')

    model.program(
      uses({
        name: 'propose_document_update',
        input: {
          documentId: id,
          summary: 'Set the title to After',
          values: [{ alias: 'title', value: 'After' }],
        },
      }),
      says('Proposed — approve it when you are happy.'),
    )
    const answered = await chat(h, 'retitle the home page')
    expect(answered.status).toBe(200)
    expect((await answered.json()) as { text: string }).toMatchObject({
      text: 'Proposed — approve it when you are happy.',
    })

    const change = (await review(h))[0]?.changes[0]
    expect(change).toMatchObject({
      kind: 'document',
      status: 'proposed',
      summary: 'Set the title to After',
    })
    expect(change?.effect).toContain('draft')

    // Nothing has happened to the page yet: this is the whole point.
    expect(await titleOf(h, id)).toBe('Before')

    const approved = await h.post(`${ASSISTANT}/changes/${change?.key}/approve`, {})
    expect(approved.status).toBe(200)
    expect(await titleOf(h, id)).toBe('After')
  })

  test('approving saves a draft and does not publish', async () => {
    const { h, model, typeKey, componentKey } = await site()
    const id = await createPage(h, typeKey, componentKey, 'Home')
    model.program(
      uses({
        name: 'propose_document_update',
        input: { documentId: id, summary: 'Retitle', values: [{ alias: 'title', value: 'After' }] },
      }),
    )
    await chat(h, 'retitle it')
    const change = (await review(h))[0]?.changes[0]
    expect((await h.post(`${ASSISTANT}/changes/${change?.key}/approve`, {})).status).toBe(200)

    const document = await h.json<{ variants: { state: string }[] }>(`${V1}/document/${id}`)
    for (const variant of document.variants) expect(variant.state).not.toBe('Published')
  })

  test('leaves property values it was not asked about alone', async () => {
    const { h, model, typeKey, componentKey } = await site()
    const id = await createPage(h, typeKey, componentKey, 'Home')
    await h.put(`${V1}/document/${id}`, {
      values: [
        { culture: null, segment: null, alias: 'title', value: 'Before' },
        { culture: null, segment: null, alias: 'bodyText', value: 'Keep me' },
      ],
      variants: [{ culture: null, segment: null, name: 'Home' }],
    })

    model.program(
      uses({
        name: 'propose_document_update',
        input: { documentId: id, summary: 'Retitle', values: [{ alias: 'title', value: 'After' }] },
      }),
    )
    await chat(h, 'retitle it')
    const change = (await review(h))[0]?.changes[0]
    await h.post(`${ASSISTANT}/changes/${change?.key}/approve`, {})

    const document = await h.json<{ values: { alias: string; value: unknown }[] }>(
      `${V1}/document/${id}`,
    )
    expect(document.values.find((value) => value.alias === 'bodyText')?.value).toBe('Keep me')
    expect(document.values.find((value) => value.alias === 'title')?.value).toBe('After')
  })

  test('keeps the page rendering: the template survives a values-only change', async () => {
    const { h, model, typeKey, componentKey } = await site()
    const id = await createPage(h, typeKey, componentKey, 'Home')
    model.program(
      uses({
        name: 'propose_document_update',
        input: { documentId: id, summary: 'Retitle', values: [{ alias: 'title', value: 'After' }] },
      }),
    )
    await chat(h, 'retitle it')
    const change = (await review(h))[0]?.changes[0]
    expect((await h.post(`${ASSISTANT}/changes/${change?.key}/approve`, {})).status).toBe(200)

    // The update handler reads the template from the body, so a proposal that left
    // it out would silently unset it and the page would stop rendering.
    const document = await h.json<{ template: { id: string } | null }>(`${V1}/document/${id}`)
    expect(document.template?.id).toBe(componentKey)
  })

  test('a new page takes its type’s default template when none is named', async () => {
    const { h, model, typeKey, componentKey } = await site()
    model.program(
      uses({
        name: 'propose_document_create',
        // No templateId: a page created without one has nothing to render with.
        input: { documentTypeId: typeKey, name: 'Fresh', summary: 'Add it' },
      }),
    )
    await chat(h, 'add a page')
    const change = (await review(h))[0]?.changes[0]
    expect((await h.post(`${ASSISTANT}/changes/${change?.key}/approve`, {})).status).toBe(200)

    const tree = await h.json<{ items: { id: string; variants: { name: string }[] }[] }>(
      `${V1}/tree/document/root?take=100`,
    )
    const created = tree.items.find((item) => item.variants[0]?.name === 'Fresh')?.id as string
    const document = await h.json<{ template: { id: string } | null }>(`${V1}/document/${created}`)
    expect(document.template?.id).toBe(componentKey)
  })

  test('a new page is proposed unpublished', async () => {
    const { h, model, typeKey, componentKey } = await site()
    model.program(
      uses({
        name: 'propose_document_create',
        input: {
          documentTypeId: typeKey,
          templateId: componentKey,
          name: 'Fresh',
          summary: 'Add a Fresh page',
          values: [{ alias: 'title', value: 'Fresh' }],
        },
      }),
    )
    await chat(h, 'add a page')
    const change = (await review(h))[0]?.changes[0]
    expect(change?.kind).toBe('document-create')
    expect((await h.post(`${ASSISTANT}/changes/${change?.key}/approve`, {})).status).toBe(200)

    const root = await h.json<{ items: { variants: { name: string; state: string }[] }[] }>(
      `${V1}/tree/document/root?take=100`,
    )
    const created = root.items.find((item) => item.variants[0]?.name === 'Fresh')
    expect(created).toBeDefined()
    expect(created?.variants[0]?.state).not.toBe('Published')
  })
})

describe('refusing to apply', () => {
  /** A proposal against a real page, left awaiting review. */
  async function proposed() {
    const { h, model, typeKey, componentKey } = await site()
    const id = await createPage(h, typeKey, componentKey, 'Home')
    model.program(
      uses({
        name: 'propose_document_update',
        input: { documentId: id, summary: 'Retitle', values: [{ alias: 'title', value: 'After' }] },
      }),
    )
    await chat(h, 'retitle it')
    const change = (await review(h))[0]?.changes[0]
    return { h, id, changeKey: change?.key as string }
  }

  test('approving the same change twice', async () => {
    const { h, changeKey } = await proposed()
    expect((await h.post(`${ASSISTANT}/changes/${changeKey}/approve`, {})).status).toBe(200)

    const again = await h.post(`${ASSISTANT}/changes/${changeKey}/approve`, {})
    expect(again.status).toBe(409)
    expect((await again.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('already applied'),
    })
  })

  test('a page somebody else saved in the meantime', async () => {
    const { h, id, changeKey } = await proposed()
    const edited = await h.put(`${V1}/document/${id}`, {
      values: [{ culture: null, segment: null, alias: 'title', value: 'Somebody else' }],
      variants: [{ culture: null, segment: null, name: 'Home' }],
    })
    expect(edited.status).toBe(200)

    const approved = await h.post(`${ASSISTANT}/changes/${changeKey}/approve`, {})
    expect(approved.status).toBe(409)
    expect((await approved.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('changed after this was proposed'),
    })
    // The other person's work survives.
    expect(await titleOf(h, id)).toBe('Somebody else')
  })

  test('a change that was discarded', async () => {
    const { h, id, changeKey } = await proposed()
    expect((await h.post(`${ASSISTANT}/changes/${changeKey}/discard`, {})).status).toBe(200)
    expect((await h.post(`${ASSISTANT}/changes/${changeKey}/approve`, {})).status).toBe(409)
    expect(await titleOf(h, id)).toBe('Before')
  })
})

describe('proposing a template', () => {
  test('one that breaks the guardrails is recorded with its problems and cannot be approved', async () => {
    const { h, model } = await site()
    model.program(
      uses({
        name: 'propose_template',
        input: {
          name: 'Sneaky',
          alias: 'sneaky',
          summary: 'Add a template',
          content: `import { $ } from 'bun'\nexport default async () => <p>{await $\`whoami\`.text()}</p>\n`,
        },
      }),
    )
    await chat(h, 'add a template')

    const change = (await review(h))[0]?.changes[0]
    expect(change?.problems.map((problem) => problem.message)).toEqual([
      'bun is not an allowed import; use bunbraco or a file beside this one',
    ])

    const approved = await h.post(`${ASSISTANT}/changes/${change?.key}/approve`, {})
    expect(approved.status).toBe(409)
    expect((await approved.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('problems that must be fixed'),
    })

    expect(await componentAliases(h)).not.toContain('sneaky')
  })

  test('a clean one says it goes live at once, and does when approved', async () => {
    const { h, model } = await site()
    model.program(
      uses({
        name: 'propose_template',
        input: {
          name: 'Landing',
          alias: 'landing',
          summary: 'Add a landing template',
          content: `import type { PageProps } from 'bunbraco'\nexport default function Landing({ model }: PageProps) {\n  return <h1>{model.text('title')}</h1>\n}\n`,
        },
      }),
    )
    await chat(h, 'add a landing template')

    const change = (await review(h))[0]?.changes[0]
    expect(change?.problems).toEqual([])
    expect(change?.effect).toContain('immediately')
    expect((await h.post(`${ASSISTANT}/changes/${change?.key}/approve`, {})).status).toBe(200)

    expect(await componentAliases(h)).toContain('landing')
  })
})

describe('the read tools', () => {
  test('query answers a read', async () => {
    const { h, model, typeKey } = await site()
    model.program(
      uses({
        name: 'query',
        input: { operationId: 'GetDocumentTypeById', params: { id: typeKey } },
      }),
      says('It is called Home Page.'),
    )
    const response = await chat(h, 'what is that type called?')
    const answer = (await response.json()) as { text: string; history: unknown[] }
    expect(answer.text).toBe('It is called Home Page.')

    // The tool result went back to the model, with the type's real name in it.
    expect(JSON.stringify(answer.history)).toContain('Home Page')
  })

  test('the transcript the browser sends back is capped before it is paid for', async () => {
    const { h, model } = await site()
    // The browser holds the conversation and returns it every turn, and every
    // turn is billed, so how much of it is sent is not the caller's to decide.
    model.program(says('done'))
    await chat(h, 'and now this', {
      history: Array.from({ length: 60 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        parts: [{ kind: 'text', text: `turn ${i}` }],
      })),
    })
    // The loop mutates the array it hands the provider, so the recording holds
    // the reply too; what the history turned into is counted by its own text.
    const textsSent = (): string[] =>
      (model.seen.at(-1)?.messages ?? []).flatMap((message) =>
        message.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])),
      )

    const kept = textsSent().filter((text) => /^turn \d+$/.test(text))
    expect(kept).toHaveLength(40)
    expect(kept[0]).toBe('turn 20')
    expect(kept.at(-1)).toBe('turn 59')

    // And by size, so one enormous turn cannot stand in for many.
    model.program(says('done'))
    const huge = 'x'.repeat(1_000_000)
    await chat(h, 'small', { history: [{ role: 'user', parts: [{ kind: 'text', text: huge }] }] })
    expect(textsSent()).not.toContain(huge)
  })

  test('query refuses an operation that would change something', async () => {
    const { h, model, typeKey, componentKey } = await site()
    const id = await createPage(h, typeKey, componentKey, 'Home')
    model.program(
      uses({ name: 'query', input: { operationId: 'PutDocumentByIdPublish', params: { id } } }),
      says('I cannot publish.'),
    )
    const response = await chat(h, 'publish it')
    const answer = (await response.json()) as { history: unknown[] }
    expect(JSON.stringify(answer.history)).toContain('not available to the assistant')

    // And it is still unpublished.
    const document = await h.json<{ variants: { state: string }[] }>(`${V1}/document/${id}`)
    for (const variant of document.variants) expect(variant.state).not.toBe('Published')
  })

  test('list_operations offers reads and nothing else', async () => {
    const { h, model } = await site()
    model.program(uses({ name: 'list_operations', input: { area: 'document' } }), says('done'))
    const response = await chat(h, 'what can you read?')
    const answer = (await response.json()) as { history: unknown[] }
    const listed = JSON.stringify(answer.history)
    expect(listed).toContain('GetDocumentById')
    expect(listed).not.toContain('PutDocumentByIdPublish')
    expect(listed).not.toContain('DeleteDocumentById')
  })

  test('an unknown tool is reported to the model rather than throwing', async () => {
    const { h, model } = await site()
    model.program(
      uses({ name: 'delete_everything', input: {} }),
      says('That is not something I can do.'),
    )
    const response = await chat(h, 'delete everything')
    expect(response.status).toBe(200)
    const answer = (await response.json()) as { history: unknown[] }
    expect(JSON.stringify(answer.history)).toContain('is not a tool the assistant has')
  })
})

describe('when the model is unreachable', () => {
  test('the failure is reported and the CMS is unaffected', async () => {
    const { h, model, typeKey, componentKey } = await site()
    const id = await createPage(h, typeKey, componentKey, 'Home')
    model.breaks('bedrock is not reachable')

    const response = await chat(h, 'do something')
    expect(response.status).toBe(502)
    expect((await response.json()) as { error: string }).toMatchObject({
      error: 'bedrock is not reachable',
    })

    // The rest of the backoffice is untouched by it.
    expect((await h.call(`${V1}/document/${id}`)).status).toBe(200)
    expect(await titleOf(h, id)).toBe('Before')
    expect(await review(h)).toHaveLength(1)
    expect((await review(h))[0]?.changes).toEqual([])
  })
})

describe('reviewing before approving', () => {
  interface ReviewJson {
    kind: string
    creating: boolean
    stale: boolean
    fields: { name: string; culture: string | null; before: unknown; after: unknown }[]
    source?: { before: string; after: string }
  }
  const diffOf = (h: Harness, key: string) => h.json<ReviewJson>(`${ASSISTANT}/changes/${key}/diff`)

  test('a page edit shows only what differs, old value beside new', async () => {
    const { h, model, typeKey, componentKey } = await site()
    const id = await createPage(h, typeKey, componentKey, 'Home')
    await h.put(`${V1}/document/${id}`, {
      values: [
        { culture: null, segment: null, alias: 'title', value: 'Before' },
        { culture: null, segment: null, alias: 'bodyText', value: 'Unchanged' },
      ],
      variants: [{ culture: null, segment: null, name: 'Home' }],
    })

    model.program(
      uses({
        name: 'propose_document_update',
        input: {
          documentId: id,
          summary: 'Retitle',
          values: [
            { alias: 'title', value: 'After' },
            { alias: 'bodyText', value: 'Unchanged' },
          ],
        },
      }),
    )
    await chat(h, 'retitle it')
    const change = (await review(h))[0]?.changes[0]

    const shown = await diffOf(h, change?.key as string)
    expect(shown.kind).toBe('document')
    expect(shown.stale).toBe(false)
    // bodyText is proposed with the value it already has, so it is not a change.
    expect(shown.fields).toEqual([
      { name: 'title', culture: null, before: 'Before', after: 'After' },
    ])
  })

  test('a template shows both sides of the source', async () => {
    const { h, model } = await site()
    const content = `import type { PageProps } from 'bunbraco'\nexport default ({ model }: PageProps) => <h2>{model.text('title')}</h2>\n`
    model.program(
      uses({
        name: 'propose_template',
        input: { name: 'Landing', alias: 'landing', summary: 'Add it', content },
      }),
    )
    await chat(h, 'add a template')
    const change = (await review(h))[0]?.changes[0]

    const shown = await diffOf(h, change?.key as string)
    expect(shown.creating).toBe(true)
    expect(shown.source?.before).toBe('')
    expect(shown.source?.after).toBe(content)
  })

  test('a proposal whose page moved on is marked stale before anyone approves it', async () => {
    const { h, model, typeKey, componentKey } = await site()
    const id = await createPage(h, typeKey, componentKey, 'Home')
    model.program(
      uses({
        name: 'propose_document_update',
        input: { documentId: id, summary: 'Retitle', values: [{ alias: 'title', value: 'After' }] },
      }),
    )
    await chat(h, 'retitle it')
    const change = (await review(h))[0]?.changes[0]
    expect((await diffOf(h, change?.key as string)).stale).toBe(false)

    await h.put(`${V1}/document/${id}`, {
      values: [{ culture: null, segment: null, alias: 'title', value: 'Somebody else' }],
      variants: [{ culture: null, segment: null, name: 'Home' }],
    })

    const shown = await diffOf(h, change?.key as string)
    expect(shown.stale).toBe(true)
    // And the diff is against what is there now, not what was there then.
    expect(shown.fields[0]?.before).toBe('Somebody else')
  })

  test('a new page shows every value as added', async () => {
    const { h, model, typeKey } = await site()
    model.program(
      uses({
        name: 'propose_document_create',
        input: {
          documentTypeId: typeKey,
          name: 'Fresh',
          summary: 'Add it',
          values: [{ alias: 'title', value: 'Fresh' }],
        },
      }),
    )
    await chat(h, 'add a page')
    const change = (await review(h))[0]?.changes[0]

    const shown = await diffOf(h, change?.key as string)
    expect(shown.creating).toBe(true)
    expect(shown.fields).toEqual([
      { name: 'title', culture: null, before: undefined, after: 'Fresh' },
    ])
  })

  test('a key that belongs to nobody is not found', async () => {
    const { h } = await site()
    expect((await h.call(`${ASSISTANT}/changes/${crypto.randomUUID()}/diff`)).status).toBe(404)
  })
})

describe('a proposal belongs to the person it was made for', () => {
  test('another signed-in user can neither read nor approve it, knowing its key', async () => {
    const { h, model, typeKey, componentKey } = await site()
    const id = await createPage(h, typeKey, componentKey, 'Home')
    model.program(
      uses({
        name: 'propose_document_update',
        input: { documentId: id, summary: 'Retitle', values: [{ alias: 'title', value: 'After' }] },
      }),
    )
    await chat(h, 'retitle it')
    const changeKey = (await review(h))[0]?.changes[0]?.key as string

    const groups = await h.json<{ items: { id: string; alias: string }[] }>(
      `${V1}/user-group?take=100`,
    )
    const admins = groups.items.find((group) => group.alias === 'admin')?.id as string
    const created = await h.post(`${V1}/user`, {
      kind: 'Default',
      email: 'other@example.com',
      userName: 'other@example.com',
      name: 'Someone Else',
      userGroupIds: [{ id: admins }],
    })
    expect(created.status).toBe(201)
    const key = created.headers.get('umb-generated-resource') as string
    const reset = await h.json<{ resetPassword: string }>(`${V1}/user/${key}/reset-password`, {
      method: 'POST',
    })
    const other = await signIn(h.server, {
      username: 'other@example.com',
      password: reset.resetPassword,
    })

    // An administrator, so permissions are not what stops them — ownership is.
    expect(await other.json<unknown[]>(`${ASSISTANT}/changesets`)).toEqual([])
    expect((await other.call(`${ASSISTANT}/changes/${changeKey}/diff`)).status).toBe(404)
    expect((await other.post(`${ASSISTANT}/changes/${changeKey}/approve`, {})).status).toBe(404)

    // Untouched, and still approvable by the person it was proposed for.
    expect(await titleOf(h, id)).toBe('Before')
    expect((await h.post(`${ASSISTANT}/changes/${changeKey}/approve`, {})).status).toBe(200)
  })
})

/** A second administrator, so ownership rather than permission is what is tested. */
async function otherAdmin(h: Harness): Promise<Harness> {
  const groups = await h.json<{ items: { id: string; alias: string }[] }>(
    `${V1}/user-group?take=100`,
  )
  const admins = groups.items.find((group) => group.alias === 'admin')?.id as string
  const email = `other-${crypto.randomUUID().slice(0, 8)}@example.com`
  const created = await h.post(`${V1}/user`, {
    kind: 'Default',
    email,
    userName: email,
    name: 'Someone Else',
    userGroupIds: [{ id: admins }],
  })
  const key = created.headers.get('umb-generated-resource') as string
  const reset = await h.json<{ resetPassword: string }>(`${V1}/user/${key}/reset-password`, {
    method: 'POST',
  })
  return await signIn(h.server, { username: email, password: reset.resetPassword })
}

describe('reading and editing a proposal', () => {
  /** A proposed template, which is the kind the editing pane opens as code. */
  async function proposedTemplate(content: string) {
    const { h, model } = await site()
    model.program(
      uses({
        name: 'propose_template',
        input: { name: 'Landing', alias: 'landing', summary: 'Add it', content },
      }),
    )
    await chat(h, 'add a template')
    const key = (await review(h))[0]?.changes[0]?.key as string
    return { h, key }
  }

  const CLEAN = `import type { PageProps } from 'bunbraco'\nexport default ({ model }: PageProps) => <h1>{model.text('title')}</h1>\n`

  test('the detail carries the body the editor works on; the list does not', async () => {
    const { h, key } = await proposedTemplate(CLEAN)

    const listed = (await review(h))[0]?.changes[0] as unknown as { body?: unknown }
    expect(listed.body).toBeUndefined()

    const detail = await h.json<{ body: { content: string; alias: string }; kind: string }>(
      `${ASSISTANT}/changes/${key}`,
    )
    expect(detail.kind).toBe('template-create')
    expect(detail.body.content).toBe(CLEAN)
  })

  test('an edit replaces what approving would send', async () => {
    const { h, key } = await proposedTemplate(CLEAN)
    // Both tags: the scan compiles what it is given, and <h2>…</h1> does not.
    const edited = CLEAN.replaceAll('h1', 'h2')

    const saved = await h.call(`${ASSISTANT}/changes/${key}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: { content: edited } }),
    })
    expect(saved.status).toBe(200)
    expect((await saved.json()) as { problems: unknown[] }).toMatchObject({ problems: [] })

    expect((await h.post(`${ASSISTANT}/changes/${key}/approve`, {})).status).toBe(200)
    const templates = await componentAliases(h)
    expect(templates).toContain('landing')
  })

  test('an edit that breaks the guardrails blocks approval, as the original would', async () => {
    const { h, key } = await proposedTemplate(CLEAN)

    const saved = await h.call(`${ASSISTANT}/changes/${key}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: { content: 'await Bun.$`ls`\n' } }),
    })
    expect(saved.status).toBe(200)
    expect((await saved.json()) as { problems: { message: string }[] }).toMatchObject({
      problems: [{ message: 'Bun is not allowed in a proposed template' }],
    })

    // The scan runs on what a person typed, not only on what the model wrote.
    const approved = await h.post(`${ASSISTANT}/changes/${key}/approve`, {})
    expect(approved.status).toBe(409)
    expect(await approved.text()).toContain('problems that must be fixed')
  })

  test('only the field the kind is edited through is accepted', async () => {
    const { h, key } = await proposedTemplate(CLEAN)

    // A template is edited through its source. Renaming it, or pointing it at a
    // different alias, is writing a different proposal rather than reviewing this one.
    const refused = await h.call(`${ASSISTANT}/changes/${key}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: { content: CLEAN, alias: 'somethingElse' } }),
    })
    expect(refused.status).toBe(400)
    expect(await refused.text()).toContain('fixed at proposal time')

    // The alias is untouched by the attempt.
    const detail = await h.json<{ body: { alias: string } }>(`${ASSISTANT}/changes/${key}`)
    expect(detail.body.alias).toBe('landing')
  })

  test('the edit merges onto what was proposed rather than replacing it', async () => {
    const { h, key } = await proposedTemplate(CLEAN)
    const edited = CLEAN.replaceAll('h1', 'h2')

    await h.call(`${ASSISTANT}/changes/${key}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: { content: edited } }),
    })

    const detail = await h.json<{ body: { alias: string; name: string; content: string } }>(
      `${ASSISTANT}/changes/${key}`,
    )
    expect(detail.body.content).toBe(edited)
    // Sending only `content` must not lose the rest of the prepared request.
    expect(detail.body.alias).toBe('landing')
    expect(detail.body.name).toBe('Landing')
  })

  test('a page proposal is edited through its values and nothing else', async () => {
    const { h, model, typeKey, componentKey } = await site()
    const id = await createPage(h, typeKey, componentKey, 'Home')
    model.program(
      uses({
        name: 'propose_document_update',
        input: { documentId: id, summary: 'Retitle', values: [{ alias: 'title', value: 'After' }] },
      }),
    )
    await chat(h, 'retitle it')
    const key = (await review(h))[0]?.changes[0]?.key as string

    const refused = await h.call(`${ASSISTANT}/changes/${key}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        body: { variants: [{ culture: null, segment: null, name: 'Hijacked' }] },
      }),
    })
    expect(refused.status).toBe(400)
    expect(await refused.text()).toContain('values')
    expect(await titleOf(h, id)).toBe('Before')
  })

  test('an applied proposal can no longer be edited', async () => {
    const { h, key } = await proposedTemplate(CLEAN)
    expect((await h.post(`${ASSISTANT}/changes/${key}/approve`, {})).status).toBe(200)

    const late = await h.call(`${ASSISTANT}/changes/${key}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: { content: CLEAN } }),
    })
    expect(late.status).toBe(409)
  })

  test('another user can neither read nor edit it', async () => {
    const { h, key } = await proposedTemplate(CLEAN)
    const other = await otherAdmin(h)
    expect((await other.call(`${ASSISTANT}/changes/${key}`)).status).toBe(404)
    const attempted = await other.call(`${ASSISTANT}/changes/${key}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: { content: 'anything' } }),
    })
    expect(attempted.status).toBe(404)
  })
})

describe('describing what a proposal does', () => {
  test('a new page reads as words, not as a request body', async () => {
    const { h, model, typeKey, componentKey } = await site()
    model.program(
      uses({
        name: 'propose_document_create',
        input: {
          documentTypeId: typeKey,
          templateId: componentKey,
          name: 'Fresh',
          summary: 'Add a page',
          values: [{ alias: 'title', value: 'Fresh' }],
        },
      }),
    )
    await chat(h, 'add a page')
    const key = (await review(h))[0]?.changes[0]?.key as string

    const shown = await h.json<{ lines: string[]; editable?: string }>(
      `${ASSISTANT}/changes/${key}/diff`,
    )
    const text = shown.lines.join(' ')
    // The fixed parts are named, resolved to names rather than ids.
    expect(text).toContain('Fresh')
    expect(text).toContain('Home Page')
    expect(text).toContain('root of the tree')
    expect(text).toContain('unpublished')
    expect(shown.editable).toContain('property values')
  })

  test('a page change names the page and says approving only drafts it', async () => {
    const { h, model, typeKey, componentKey } = await site()
    const id = await createPage(h, typeKey, componentKey, 'Home')
    model.program(
      uses({
        name: 'propose_document_update',
        input: { documentId: id, summary: 'Retitle', values: [{ alias: 'title', value: 'After' }] },
      }),
    )
    await chat(h, 'retitle it')
    const key = (await review(h))[0]?.changes[0]?.key as string

    const shown = await h.json<{ lines: string[] }>(`${ASSISTANT}/changes/${key}/diff`)
    const text = shown.lines.join(' ')
    expect(text).toContain('Home')
    expect(text).toContain('saves a draft')
  })

  test('a rename is named, in the words and in the diff', async () => {
    const { h, model, typeKey, componentKey } = await site()
    const id = await createPage(h, typeKey, componentKey, 'Home')
    // A rename rides inside `variants`, which a person cannot edit and which the
    // value diff does not cover, so without this it reaches a reviewer as
    // nothing at all while the summary talks about the title.
    model.program(
      uses({
        name: 'propose_document_update',
        input: {
          documentId: id,
          name: 'Home – closing down',
          summary: 'Update the title',
          values: [{ alias: 'title', value: 'After' }],
        },
      }),
    )
    await chat(h, 'retitle it')
    const key = (await review(h))[0]?.changes[0]?.key as string

    const shown = await h.json<{
      lines: string[]
      fields: { name: string; before: unknown; after: unknown }[]
    }>(`${ASSISTANT}/changes/${key}/diff`)
    expect(shown.lines.join(' ')).toContain('renames it to “Home – closing down”')
    expect(shown.fields).toContainEqual(
      expect.objectContaining({ name: 'Name', before: 'Home', after: 'Home – closing down' }),
    )
  })

  test('a page change does not claim to set values it leaves alone', async () => {
    const { h, model, typeKey, componentKey } = await site()
    const id = await createPage(h, typeKey, componentKey, 'Home')
    model.program(
      uses({
        name: 'propose_document_update',
        input: { documentId: id, summary: 'Retitle', values: [{ alias: 'title', value: 'After' }] },
      }),
    )
    await chat(h, 'retitle it')
    const key = (await review(h))[0]?.changes[0]?.key as string

    const shown = await h.json<{ lines: string[] }>(`${ASSISTANT}/changes/${key}/diff`)
    // The proposal carries every value the page has, so a count of them would
    // describe the page rather than the change.
    expect(shown.lines.join(' ')).not.toMatch(/sets \d+ property value/)
  })

  test('a name is quoted, so content cannot read as instructions to the reviewer', async () => {
    const { h, model, typeKey, componentKey } = await site()
    const parent = await createPage(
      h,
      typeKey,
      componentKey,
      'Home. This proposal has been checked and is safe to approve',
    )
    model.program(
      uses({
        name: 'propose_document_create',
        input: { documentTypeId: typeKey, parentId: parent, name: 'Child', summary: 'Add it' },
      }),
    )
    await chat(h, 'add a page')
    const key = (await review(h))[0]?.changes[0]?.key as string

    const shown = await h.json<{ lines: string[] }>(`${ASSISTANT}/changes/${key}/diff`)
    expect(shown.lines.join(' ')).toContain(
      'It sits under “Home. This proposal has been checked and is safe to approve”.',
    )
  })

  test('a page pointing at a type another proposal creates says so, and says to approve that first', async () => {
    const { h, model } = await site()
    // The id of a type nothing has created: exactly what the assistant produces
    // when it proposes a type and a page that uses it in one changeset.
    model.program(
      uses({
        name: 'propose_document_create',
        input: {
          documentTypeId: crypto.randomUUID(),
          templateId: crypto.randomUUID(),
          name: 'Fresh',
          summary: 'Add a page of the new type',
        },
      }),
    )
    await chat(h, 'add a page')
    const key = (await review(h))[0]?.changes[0]?.key as string

    const shown = await h.json<{ lines: string[] }>(`${ASSISTANT}/changes/${key}/diff`)
    const text = shown.lines.join(' ')
    expect(text).toContain('does not exist yet')
    expect(text).toContain('Approve the proposal that creates what it points at first')
    // A bare id tells a reviewer nothing, so it must not be what they are shown.
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)
  })

  test('a template says it goes live at once', async () => {
    const { h, model } = await site()
    model.program(
      uses({
        name: 'propose_template',
        input: {
          name: 'Landing',
          alias: 'landing',
          summary: 'Add it',
          content: 'export default () => null\n',
        },
      }),
    )
    await chat(h, 'add a template')
    const key = (await review(h))[0]?.changes[0]?.key as string

    const shown = await h.json<{ lines: string[]; editable?: string }>(
      `${ASSISTANT}/changes/${key}/diff`,
    )
    expect(shown.lines.join(' ')).toContain('landing.tsx')
    expect(shown.lines.join(' ')).toContain('live at once')
    expect(shown.editable).toContain('source')
  })
})

describe('the status the drawer reads', () => {
  test('a provider that cannot check itself is taken at its word', async () => {
    const { h } = await site()
    const status = await h.json<{ ok: boolean; provider: string; mcp: boolean }>(
      `${ASSISTANT}/status`,
    )
    expect(status).toMatchObject({ ok: true, provider: 'programmable', mcp: false })
  })

  test('a provider that reports a problem is passed through with its remedy', async () => {
    const h = await signedInServer({
      config: {
        assistant: {
          provider: {
            name: 'expired',
            converse: () => Promise.reject(new Error('unused')),
            check: async () => ({
              ok: false,
              detail: 'Token is expired.',
              remedy: 'Run `aws sso login --profile dev`.',
            }),
          },
        },
      },
    })
    open.push(h)
    const status = await h.json<{ ok: boolean; detail: string; remedy: string }>(
      `${ASSISTANT}/status`,
    )
    expect(status).toMatchObject({
      ok: false,
      detail: 'Token is expired.',
      remedy: 'Run `aws sso login --profile dev`.',
    })
  })

  test('a plain read is cached; refresh asks the provider again, deeply', async () => {
    const asked: (boolean | undefined)[] = []
    const h = await signedInServer({
      config: {
        assistant: {
          provider: {
            name: 'counting',
            converse: () => Promise.reject(new Error('unused')),
            check: async (deep?: boolean) => {
              asked.push(deep)
              return { ok: true, detail: 'fine', model: deep ? 'ok' : 'unchecked' }
            },
          },
        },
      },
    })
    open.push(h)
    // Boot already asked deeply, so a plain read costs nothing more.
    await h.json(`${ASSISTANT}/status`)
    await h.json(`${ASSISTANT}/status`)
    const before = asked.length
    await h.json(`${ASSISTANT}/status?refresh=1`)
    expect(asked.length).toBe(before + 1)
    expect(asked.at(-1)).toBe(true)
    expect(asked.at(0)).toBe(true)

    // A second refresh straight away does not: a deep check is a paid model
    // call, so it is not something a caller can repeat at will.
    await h.json(`${ASSISTANT}/status?refresh=1`)
    expect(asked.length).toBe(before + 1)
  })

  test('the configuration behind it is for whoever can fix it', async () => {
    const h = await signedInServer({
      config: {
        assistant: {
          provider: {
            name: 'telling',
            converse: () => Promise.reject(new Error('unused')),
            check: async () => ({
              ok: false,
              detail: 'anthropic.claude in eu-central-1 via profile dev did not answer',
              remedy: 'Run `aws sso login --profile dev`.',
              expires: '2026-09-30T04:00:00.000Z',
            }),
          },
        },
      },
    })
    open.push(h)

    const asAdmin = await h.json<{ detail: string; remedy?: string; canRefresh: boolean }>(
      `${ASSISTANT}/status`,
    )
    expect(asAdmin.detail).toContain('profile dev')
    expect(asAdmin.remedy).toContain('aws sso login')
    expect(asAdmin.canRefresh).toBe(true)

    // A writer gets the fact, not the model id, the region, the profile the
    // credentials came from or when they run out.
    const writer = await signInAsGroup(h)
    const asWriter = await writer.json<{
      ok: boolean
      detail: string
      remedy?: string
      expires?: string
      canRefresh: boolean
    }>(`${ASSISTANT}/status`)
    expect(asWriter.ok).toBe(false)
    expect(asWriter.detail).toBe('The assistant is unavailable. An administrator can see why.')
    expect(asWriter.detail).not.toContain('profile')
    expect(asWriter.remedy).toBeUndefined()
    expect(asWriter.expires).toBeUndefined()
    // And the drawer is told not to offer a re-check it would be refused.
    expect(asWriter.canRefresh).toBe(false)
  })

  test('a check that throws is reported, not propagated', async () => {
    const h = await signedInServer({
      config: {
        assistant: {
          provider: {
            name: 'broken-check',
            converse: () => Promise.reject(new Error('unused')),
            check: () => Promise.reject(new Error('the credential chain fell over')),
          },
        },
      },
    })
    open.push(h)
    const status = await h.json<{ ok: boolean; detail: string }>(`${ASSISTANT}/status`)
    expect(status).toMatchObject({ ok: false, detail: 'the credential chain fell over' })
  })

  test('a bad model does not stop the site booting or serving', async () => {
    const h = await signedInServer({
      config: {
        assistant: {
          provider: {
            name: 'no-access',
            converse: () => Promise.reject(new Error('unused')),
            check: async () => ({ ok: false, detail: 'AccessDeniedException' }),
          },
        },
      },
    })
    open.push(h)
    expect((await h.call(`${V1}/tree/document/root?take=10`)).status).toBe(200)
    expect((await h.call(`${ASSISTANT}/status`)).status).toBe(200)
  })
})

describe('in the backoffice', () => {
  interface ManifestJson {
    name: string
    extensions: { type: string; alias: string; element?: string }[]
  }
  const manifests = (h: Harness) => h.json<ManifestJson[]>(`${V1}/manifest/manifest`)

  test('the drawer is registered as its own manifest and its module is served', async () => {
    const { h } = await site()
    const ours = (await manifests(h)).find((manifest) => manifest.name === 'Bunbraco Assistant')
    expect(ours?.extensions.map((extension) => `${extension.type}:${extension.alias}`)).toEqual([
      'headerApp:Bunbraco.HeaderApp.Assistant',
    ])

    const element = ours?.extensions[0]?.element as string
    expect(element.startsWith(`${DEFAULT_BACKOFFICE_PATH}/bunbraco/`)).toBe(true)
    const served = await h.call(element)
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toContain('javascript')
    expect(await served.text()).toContain('customElements.define')
  })

  test('the core manifest is left alone, so nothing else has to know about the feature', async () => {
    const { h } = await site()
    const core = (await manifests(h)).find((manifest) => manifest.name === 'Bunbraco')
    expect(core?.extensions.map((extension) => extension.alias)).not.toContain(
      'Bunbraco.HeaderApp.Assistant',
    )
  })
})

describe('the drawer element', () => {
  /**
   * Source-level guards for two mistakes that nothing else here can catch: both
   * rendered a perfectly working control as invisible, and both were only found by
   * opening the backoffice and looking at it.
   */
  const source = () => Bun.file('packages/backoffice-host/plugin/assistant/drawer.js').text()

  test('icons go through umb-icon, which is what resolves a registry name', async () => {
    const drawer = await source()
    expect(drawer).toContain('<umb-icon name="icon-wand">')
    // `uui-icon` renders an empty box for an Umbraco icon name.
    expect(drawer).not.toContain('<uui-icon')
  })

  test('the transparent button background is scoped to the header launcher', async () => {
    const drawer = await source()
    // Unscoped, this made every button in the panel — Send, Approve, Discard —
    // white on white.
    expect(drawer).toContain('.launcher {')
    expect(drawer).not.toMatch(/\n {4}uui-button \{/)
  })

  test('the re-check button is not offered when the server would refuse it', async () => {
    const drawer = await source()
    expect(drawer).toContain('state.canRefresh === false')
  })
})

describe('when it is not configured', () => {
  test('the backoffice is served no assistant extension', async () => {
    const h = await signedInServer()
    open.push(h)
    const all = await h.json<{ name: string }[]>(`${V1}/manifest/manifest`)
    expect(all.map((manifest) => manifest.name)).not.toContain('Bunbraco Assistant')
  })

  test('there is no assistant endpoint at all', async () => {
    const h = await signedInServer()
    open.push(h)
    for (const path of ['/chat', '/changesets', '/mcp']) {
      expect((await h.call(`${ASSISTANT}${path}`, { method: 'POST' })).status).toBe(404)
    }
  })

  test('the changeset tables exist and are empty, so the migration is unconditional', async () => {
    const h = await signedInServer()
    open.push(h)
    const rows = await h.server.db.query<{ total: number }>(
      'SELECT COUNT(*) AS total FROM assistant_changeset',
    )
    expect(Number(rows[0]?.total)).toBe(0)
  })
})

describe('MCP', () => {
  const rpc = (h: Harness, method: string, params?: Record<string, unknown>) =>
    h.call(`${ASSISTANT}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })

  test('handshakes and lists the same tools the model gets', async () => {
    const { h } = await site({ mcp: true })
    const initialised = (await (await rpc(h, 'initialize')).json()) as {
      result: { protocolVersion: string }
    }
    expect(initialised.result.protocolVersion).toBe('2025-06-18')

    const listed = (await (await rpc(h, 'tools/list')).json()) as {
      result: { tools: { name: string }[] }
    }
    const names = listed.result.tools.map((tool) => tool.name)
    expect(names).toContain('query')
    expect(names).toContain('propose_document_update')
    // No apply and no publish over MCP: approval is a person's act in the backoffice.
    expect(names.filter((name) => /approve|apply|publish|delete/.test(name))).toEqual([])
  })

  test('the handshake alone raises no changeset', async () => {
    const { h } = await site({ mcp: true })
    await rpc(h, 'initialize')
    await rpc(h, 'tools/list')
    expect(await review(h)).toEqual([])
  })

  test('a proposal over MCP shows up for review in the backoffice, having changed nothing', async () => {
    const { h, typeKey, componentKey } = await site({ mcp: true })
    const id = await createPage(h, typeKey, componentKey, 'Home')

    const called = (await (
      await rpc(h, 'tools/call', {
        name: 'propose_document_update',
        arguments: {
          documentId: id,
          summary: 'Retitle the home page',
          values: [{ alias: 'title', value: 'From an agent' }],
        },
      })
    ).json()) as { result: { isError: boolean } }
    expect(called.result.isError).toBe(false)

    const changesets = await review(h)
    expect(changesets[0]?.origin).toBe('mcp')
    expect(changesets[0]?.changes[0]).toMatchObject({
      summary: 'Retitle the home page',
      status: 'proposed',
    })
    expect(await titleOf(h, id)).toBe('Before')
  })

  test('several proposals in one run land in one changeset', async () => {
    const { h, typeKey, componentKey } = await site({ mcp: true })
    const id = await createPage(h, typeKey, componentKey, 'Home')
    for (const value of ['One', 'Two']) {
      await rpc(h, 'tools/call', {
        name: 'propose_document_update',
        arguments: { documentId: id, summary: `Set ${value}`, values: [{ alias: 'title', value }] },
      })
    }
    const changesets = await review(h)
    expect(changesets).toHaveLength(1)
    expect(changesets[0]?.changes.map((change) => change.summary)).toEqual(['Set One', 'Set Two'])
  })

  test('mcp is off unless it is asked for', async () => {
    const { h } = await site()
    expect((await rpc(h, 'initialize')).status).toBe(404)
  })

  test('an unknown method is a JSON-RPC error, not a crash', async () => {
    const { h } = await site({ mcp: true })
    const response = (await (await rpc(h, 'resources/list')).json()) as { error: { code: number } }
    expect(response.error.code).toBe(-32601)
  })

  test('it needs a signed-in user like everything else', async () => {
    const { h } = await site({ mcp: true })
    const anonymous = await h.server.fetch(
      new Request(`http://localhost${ASSISTANT}/mcp`, {
        // No cookie: the same 401 any other signed-in route gives.
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    )
    expect(anonymous.status).toBe(401)
  })
})
