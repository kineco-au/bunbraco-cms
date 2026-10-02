/**
 * WP-6.6: dictionary items — the Translation section's tree, list and editor,
 * move rules, and `.udt` export and import as Umbraco writes them.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { DictionaryRepository } from '@bunbraco/data'
import {
  dictionaryToUdt,
  importDictionaryUdt,
  readUdt,
  writeDictionaryUdt,
  writeUdt,
} from '@bunbraco/server'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

const open: Harness[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
})

async function site() {
  const h = await signedInServer()
  open.push(h)
  await h.post(`${V1}/language`, {
    isoCode: 'da-DK',
    name: 'Danish',
    isDefault: false,
    isMandatory: false,
    fallbackIsoCode: 'en-US',
  })
  const create = async (
    name: string,
    parent: string | null,
    translations: Record<string, string>,
  ) => {
    const response = await h.post(`${V1}/dictionary`, {
      name,
      parent: parent ? { id: parent } : null,
      translations: Object.entries(translations).map(([isoCode, translation]) => ({
        isoCode,
        translation,
      })),
    })
    return response
  }
  const key = async (name: string, parent: string | null, translations: Record<string, string>) => {
    const response = await create(name, parent, translations)
    expect(response.status).toBe(201)
    return response.headers.get('umb-generated-resource') as string
  }
  return { h, create, key }
}

describe('dictionary items', () => {
  test('create, read, list, tree and update', async () => {
    const { h, create, key } = await site()
    const labels = await key('Labels', null, {})
    const readMore = await key('Labels.ReadMore', labels, {
      'en-US': 'Read more',
      'da-DK': 'Læs mere',
    })
    await key('Labels.Back', labels, { 'en-US': 'Back' })

    expect(await h.json<unknown>(`${V1}/dictionary/${readMore}`)).toEqual<unknown>({
      id: readMore,
      name: 'Labels.ReadMore',
      translations: [
        { isoCode: 'da-DK', translation: 'Læs mere' },
        { isoCode: 'en-US', translation: 'Read more' },
      ],
    })
    // Names are unique
    const duplicate = await create('Labels.Back', null, {})
    expect(duplicate.status).toBe(409)
    expect((await duplicate.json()).operationStatus).toBe('DuplicateItemKey')
    // A parent must exist, and translations name real languages
    expect((await create('Orphan', crypto.randomUUID(), {})).status).toBe(404)
    expect((await create('Klingon', null, { 'tlh-QO': 'x' })).status).toBe(400)

    const list = await h.json<{ total: number; items: Array<Record<string, unknown>> }>(
      `${V1}/dictionary?skip=0&take=10`,
    )
    expect(list.total).toBe(3)
    expect(list.items.find((i) => i.id === readMore)).toEqual({
      id: readMore,
      name: 'Labels.ReadMore',
      parent: { id: labels },
      translatedIsoCodes: ['da-DK', 'en-US'],
    })
    expect(
      (await h.json<{ total: number }>(`${V1}/dictionary?filter=back&skip=0&take=10`)).total,
    ).toBe(1)

    const root = await h.json<{ items: Array<{ id: string; hasChildren: boolean }> }>(
      `${V1}/tree/dictionary/root?skip=0&take=10`,
    )
    expect(root.items).toEqual([
      { id: labels, name: 'Labels', parent: null, hasChildren: true, flags: [] },
    ] as never)
    const children = await h.json<{ items: Array<{ name: string }> }>(
      `${V1}/tree/dictionary/children?parentId=${labels}&skip=0&take=10`,
    )
    expect(children.items.map((c) => c.name)).toEqual(['Labels.Back', 'Labels.ReadMore'])
    const ancestors = await h.json<Array<{ id: string }>>(
      `${V1}/tree/dictionary/ancestors?descendantId=${readMore}`,
    )
    expect(ancestors.map((a) => a.id)).toEqual([labels, readMore])
    expect(await h.json<unknown>(`${V1}/item/dictionary?id=${readMore}`)).toEqual<unknown>([
      { id: readMore, name: 'Labels.ReadMore', flags: [] },
    ])

    const updated = await h.put(`${V1}/dictionary/${readMore}`, {
      name: 'Labels.More',
      translations: [{ isoCode: 'en-US', translation: 'More' }],
    })
    expect(updated.status).toBe(200)
    expect(
      await h.json<{ name: string; translations: unknown[] }>(`${V1}/dictionary/${readMore}`),
    ).toMatchObject({
      name: 'Labels.More',
      translations: [{ isoCode: 'en-US', translation: 'More' }],
    })
  })

  test('move refuses a target below itself; delete takes the branch', async () => {
    const { h, key } = await site()
    const a = await key('A', null, {})
    const b = await key('B', a, {})
    const c = await key('C', null, {})
    expect((await h.put(`${V1}/dictionary/${a}/move`, { target: { id: b } })).status).toBe(400)
    expect((await h.put(`${V1}/dictionary/${a}/move`, { target: { id: a } })).status).toBe(400)
    expect((await h.put(`${V1}/dictionary/${b}/move`, { target: { id: c } })).status).toBe(200)
    expect((await h.put(`${V1}/dictionary/${b}/move`, { target: null })).status).toBe(200)
    expect(
      (await h.json<{ parent: unknown }[]>(`${V1}/tree/dictionary/ancestors?descendantId=${b}`))
        .length,
    ).toBe(1)
    await h.put(`${V1}/dictionary/${b}/move`, { target: { id: a } })
    expect((await h.del(`${V1}/dictionary/${a}`)).status).toBe(200)
    expect((await h.call(`${V1}/dictionary/${b}`)).status).toBe(404)
    expect((await h.del(`${V1}/dictionary/${a}`)).status).toBe(404)
  })

  test('export writes a .udt that import reads back, children included', async () => {
    const { h, key } = await site()
    const parent = await key('Nav', null, { 'en-US': 'Navigation' })
    await key('Nav.Home', parent, { 'en-US': 'Home', 'da-DK': 'Hjem' })

    const exported = await h.call(`${V1}/dictionary/${parent}/export?includeChildren=true`)
    expect(exported.status).toBe(200)
    expect(exported.headers.get('content-disposition')).toBe('attachment; filename="Nav.udt"')
    const xml = await exported.text()
    expect(xml).toContain(`<DictionaryItem Key="${parent}" Name="Nav">`)
    expect(xml).toContain('<Value LanguageCultureAlias="da-DK"><![CDATA[Hjem]]></Value>')
    expect(readUdt(xml)?.[0]?.children[0]?.name).toBe('Nav.Home')
    const alone = await (await h.call(`${V1}/dictionary/${parent}/export`)).text()
    expect(alone).not.toContain('Nav.Home')

    // Delete it all, then import the file under a new parent
    await h.del(`${V1}/dictionary/${parent}`)
    const holder = await key('Imported', null, {})
    const fileId = crypto.randomUUID()
    const form = new FormData()
    form.set('Id', fileId)
    form.set('File', new File([xml], 'Nav.udt'))
    await h.call(`${V1}/temporary-file`, { method: 'POST', body: form })
    const imported = await h.post(`${V1}/dictionary/import`, {
      temporaryFile: { id: fileId },
      parent: { id: holder },
    })
    expect(imported.status).toBe(201)
    expect(imported.headers.get('umb-generated-resource')).toBe(parent)
    const children = await h.json<{ items: Array<{ id: string; name: string }> }>(
      `${V1}/tree/dictionary/children?parentId=${parent}&skip=0&take=10`,
    )
    expect(children.items.map((c) => c.name)).toEqual(['Nav.Home'])
    expect(
      await h.json<{ translations: unknown[] }>(`${V1}/dictionary/${children.items[0]?.id}`),
    ).toMatchObject({
      translations: [
        { isoCode: 'da-DK', translation: 'Hjem' },
        { isoCode: 'en-US', translation: 'Home' },
      ],
    })
    // Not a .udt, or gone
    const bad = crypto.randomUUID()
    const badForm = new FormData()
    badForm.set('Id', bad)
    badForm.set('File', new File(['<nope/>'], 'nope.udt'))
    await h.call(`${V1}/temporary-file`, { method: 'POST', body: badForm })
    expect((await h.post(`${V1}/dictionary/import`, { temporaryFile: { id: bad } })).status).toBe(
      400,
    )
    expect(
      (await h.post(`${V1}/dictionary/import`, { temporaryFile: { id: crypto.randomUUID() } }))
        .status,
    ).toBe(404)
  })

  test('the .udt writer escapes attributes and CDATA terminators', () => {
    const xml = writeUdt({
      key: 'k',
      name: 'a "quoted" <name>',
      translations: [{ isoCode: 'en-US', translation: 'ends ]]> here & <b>bold</b>' }],
      children: [],
    })
    expect(readUdt(xml)).toEqual([
      {
        key: 'k',
        name: 'a "quoted" <name>',
        translations: [{ isoCode: 'en-US', translation: 'ends ]]> here & <b>bold</b>' }],
        children: [],
      },
    ])
    expect(
      readUdt('<DictionaryItems><DictionaryItem Key="a" Name="A" /></DictionaryItems>'),
    ).toEqual([{ key: 'a', name: 'A', translations: [], children: [] }])
    expect(readUdt('<DictionaryItem Key="a" Name="A">')).toBeUndefined()
    expect(readUdt('<Other />')).toBeUndefined()
  })

  /**
   * The dictionary stays in the database because translators work in
   * production, so this pair is how a lower environment gets the translations
   * (`docs/09-schema-as-code.md`). The endpoint and the CLI share one
   * implementation, which is what these exercise.
   */
  test('the whole dictionary round trips, items upserting by key', async () => {
    const h = await signedInServer()
    open.push(h)
    const repo = new DictionaryRepository(h.server.db)
    const parent = crypto.randomUUID()
    const child = crypto.randomUUID()
    expect(
      await repo.create({
        key: parent,
        name: 'Greeting',
        parentKey: null,
        translations: [{ isoCode: 'en-US', translation: 'Hello' }],
      }),
    ).toBe('Success')
    expect(
      await repo.create({
        key: child,
        name: 'Greeting.Formal',
        parentKey: parent,
        translations: [{ isoCode: 'en-US', translation: 'Good day' }],
      }),
    ).toBe('Success')

    // More than one root needs the `<DictionaryItems>` wrapper, which is why
    // the writer has a multi-item form at all.
    const second = crypto.randomUUID()
    expect(
      await repo.create({ key: second, name: 'Farewell', parentKey: null, translations: [] }),
    ).toBe('Success')

    const items = await dictionaryToUdt(repo)
    expect(items.map((i) => i.name).sort()).toEqual(['Farewell', 'Greeting'])
    expect(items.find((i) => i.name === 'Greeting')?.children.map((c) => c.name)).toEqual([
      'Greeting.Formal',
    ])
    const text = writeDictionaryUdt(items)

    // Applying it where it came from is a no-op that still reports the items.
    const again = await importDictionaryUdt(h.server.db, text, null)
    expect(again).toMatchObject({ ok: true, imported: 3, skipped: [] })
    expect((await repo.get(child))?.translations).toEqual([
      { isoCode: 'en-US', translation: 'Good day' },
    ])
  })

  test('a translation for a language this site has not got is skipped, and said so', async () => {
    const h = await signedInServer()
    open.push(h)
    const key = crypto.randomUUID()
    const text = writeUdt({
      key,
      name: 'Elsewhere',
      translations: [
        { isoCode: 'en-US', translation: 'Here' },
        { isoCode: 'fr-FR', translation: 'Là' },
      ],
      children: [],
    })
    const outcome = await importDictionaryUdt(h.server.db, text, null)
    // Umbraco's behaviour: the item imports, the unknown language is dropped
    // rather than the whole file refused — but the caller is told which.
    expect(outcome).toMatchObject({ ok: true, imported: 1, skipped: ['fr-FR'] })
    expect((await new DictionaryRepository(h.server.db).get(key))?.translations).toEqual([
      { isoCode: 'en-US', translation: 'Here' },
    ])
  })

  test('a file that is not a dictionary export is refused by name', async () => {
    const h = await signedInServer()
    open.push(h)
    expect(await importDictionaryUdt(h.server.db, '<Other />', null)).toMatchObject({
      ok: false,
      reason: 'not a dictionary export',
    })
    // A well-formed key that names nothing. A malformed one is a different
    // matter — Postgres' `uuid` column rejects it outright, as it does anywhere
    // else in the data layer, and keys are validated before they reach here.
    expect(
      await importDictionaryUdt(
        h.server.db,
        '<DictionaryItem Key="00000000-0000-4000-8000-000000000001" Name="A" />',
        '00000000-0000-4000-8000-000000000002',
      ),
    ).toMatchObject({ ok: false, reason: 'the parent item does not exist' })
  })

  test('an export of nothing is empty rather than a file with no items', async () => {
    const h = await signedInServer()
    open.push(h)
    expect(await dictionaryToUdt(new DictionaryRepository(h.server.db))).toEqual([])
  })
})
