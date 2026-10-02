/**
 * WP-6.3's exit, through the API: a page with a property for every built-in
 * data type round-trips — what the editor sends is what it reads back — and
 * renders, each value as templates receive it.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ContentTypeRepository, DEFAULT_DATA_TYPES, TemplateRepository } from '@bunbraco/data'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

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

/** Every built-in a property can use: list views configure collections, not properties. */
const EDITORS = DEFAULT_DATA_TYPES.filter((d) => d.editorAlias !== 'Umbraco.ListView')

const TYPE = `[document-type]
alias = "everyEditor"
name = "Every editor"
allow-at-root = true
templates = ["everyEditor"]
default-template = "everyEditor"
${EDITORS.map((d) => `\n[[property]]\nalias = "${d.alias}"\nname = "${d.name}"\ntype = "${d.alias}"\n`).join('')}`

const VIEW = `export default function EveryEditor({ model }) {
  const show = (v) => (v === null || v === undefined ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v))
  return <dl>{model.properties.map((p) => <><dt>{p.alias}</dt><dd>{show(model.value(p.alias))}</dd></>)}</dl>
}
`

describe('every built-in editor', () => {
  test('round-trips what the editor sends, and renders', async () => {
    const root = mkdtempSync(join(process.cwd(), 'output', 'every-editor-'))
    dirs.push(root)
    mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
    mkdirSync(join(root, 'Views'), { recursive: true })
    writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    writeFileSync(join(root, 'schema', 'document-types', 'every-editor.toml'), TYPE)
    writeFileSync(join(root, 'Views', 'everyEditor.tsx'), VIEW)
    const h = await signedInServer({
      config: {
        schemaDir: join(root, 'schema'),
        viewsDir: join(root, 'Views'),
        mediaDir: join(root, 'media'),
      },
    })
    open.push(h)
    const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('everyEditor'))
      ?.key as string
    const templateKey = (await new TemplateRepository(h.server.db).byAlias('everyEditor'))
      ?.key as string
    const upload = async (name: string, body: BlobPart) => {
      const id = crypto.randomUUID()
      const form = new FormData()
      form.set('Id', id)
      form.set('File', new File([body], name))
      await h.call(`${V1}/temporary-file`, { method: 'POST', body: form })
      return id
    }

    // What the backoffice sends for each, by editor
    const target = crypto.randomUUID()
    const sent: Record<string, unknown> = {
      label: 'A label',
      labelInt: 42,
      labelBigInt: '9007199254740993',
      labelDecimal: 1.5,
      labelBytes: '2048',
      labelPixels: 640,
      textarea: 'Line one\nLine two',
      textstring: 'Hello',
      richtext: {
        markup: '<p>Rich</p>',
        blocks: { layout: {}, contentData: [], settingsData: [], expose: [] },
      },
      numeric: 7,
      trueFalse: true,
      checkboxList: ['Red', 'Blue'],
      dropdown: ['Only'],
      datePicker: '2026-01-02 00:00:00',
      radiobox: 'Yes',
      dropdownMultiple: ['One', 'Two'],
      approvedColor: { label: 'Primary', value: '#1b264f' },
      datePickerWithTime: '2026-01-02 03:04:05',
      tags: ['news', 'bun'],
      contentPicker: `umb://document/${target.replaceAll('-', '')}`,
      memberPicker: `umb://member/${crypto.randomUUID().replaceAll('-', '')}`,
      multiUrlPicker: [
        {
          name: 'Umbraco',
          type: 'external',
          url: 'https://umbraco.com',
          target: '_blank',
          unique: null,
          queryString: null,
        },
      ],
      mediaPicker: [
        {
          key: crypto.randomUUID(),
          mediaKey: crypto.randomUUID(),
          mediaTypeAlias: 'Image',
          crops: [],
          focalPoint: null,
        },
      ],
      multipleMediaPicker: [],
      imageMediaPicker: [],
      multipleImageMediaPicker: [],
      dateTimeWithTimeZone: { date: '2026-01-02T03:04:05+01:00', timeZone: 'Europe/Paris' },
    }
    const uploads: Record<string, unknown> = {
      upload: { src: '', temporaryFileId: await upload('brochure.pdf', '%PDF') },
      uploadVideo: { src: '', temporaryFileId: await upload('clip.mp4', 'mp4') },
      uploadAudio: { src: '', temporaryFileId: await upload('song.mp3', 'mp3') },
      uploadArticle: { src: '', temporaryFileId: await upload('paper.docx', 'docx') },
      uploadVectorGraphics: { src: '', temporaryFileId: await upload('logo.svg', '<svg/>') },
      imageCropper: {
        src: '',
        temporaryFileId: await upload(
          'photo.png',
          await Bun.file(join(import.meta.dir, 'fixtures', 'pixel.png')).bytes(),
        ),
        crops: [],
        focalPoint: { left: 0.25, top: 0.75 },
      },
    }
    // Every editor has a value in the test
    const covered = new Set([
      ...Object.keys(sent),
      ...Object.keys(uploads),
      'labelDateTime',
      'labelTime',
    ])
    expect(EDITORS.map((d) => d.alias).filter((alias) => !covered.has(alias))).toEqual([])

    const created = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      template: { id: templateKey },
      parent: null,
      values: Object.entries({ ...sent, ...uploads }).map(([alias, value]) => ({
        alias,
        culture: null,
        segment: null,
        value,
      })),
      variants: [{ culture: null, segment: null, name: 'Everything' }],
    })
    expect(created.status).toBe(201)
    const key = created.headers.get('umb-generated-resource') as string

    const read = await h.json<{
      values: Array<{ alias: string; value: unknown; editorAlias: string }>
    }>(`${V1}/document/${key}`)
    const back = Object.fromEntries(read.values.map((v) => [v.alias, v.value]))
    for (const [alias, value] of Object.entries(sent))
      expect([alias, back[alias]]).toEqual([alias, value])
    // Uploads come back as their placed files
    for (const alias of Object.keys(uploads))
      expect([alias, (back[alias] as { src: string }).src]).toEqual([
        alias,
        expect.stringMatching(/^\/media\/[0-9a-f]{8}\//),
      ])
    expect(back.imageCropper).toMatchObject({ crops: [], focalPoint: { left: 0.25, top: 0.75 } })
    // Each value names the editor that renders it
    for (const d of EDITORS)
      if (back[d.alias] !== undefined)
        expect(read.values.find((v) => v.alias === d.alias)?.editorAlias).toBe(d.editorAlias)

    // Saving again what was read changes nothing
    const again = await h.put(`${V1}/document/${key}`, {
      template: { id: templateKey },
      values: read.values.map((v) => ({
        alias: v.alias,
        culture: null,
        segment: null,
        value: v.value,
      })),
      variants: [{ culture: null, segment: null, name: 'Everything' }],
    })
    expect(again.status).toBe(200)
    const versions = await h.json<{ total: number }>(
      `${V1}/document-version?documentId=${key}&skip=0&take=10`,
    )
    expect(versions.total).toBe(2)
    const reread = await h.json<{ values: Array<{ alias: string; value: unknown }> }>(
      `${V1}/document/${key}`,
    )
    expect(Object.fromEntries(reread.values.map((v) => [v.alias, v.value]))).toEqual(back)

    // And it renders, each value as a template receives it
    await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })
    const html = await (await h.call('/')).text()
    const shown = (alias: string) => new RegExp(`<dt>${alias}</dt><dd>([^<]*)</dd>`).exec(html)?.[1]
    expect(shown('textstring')).toBe('Hello')
    expect(shown('trueFalse')).toBe('true')
    expect(shown('numeric')).toBe('7')
    expect(shown('datePickerWithTime')).toBe('2026-01-02 03:04:05')
    expect(shown('richtext')).toBe('&lt;p&gt;Rich&lt;/p&gt;')
    expect(shown('upload')).toMatch(/^\/media\/[0-9a-f]{8}\/brochure\.pdf$/)
    // A picker pointing at nothing published is null
    expect(shown('contentPicker')).toBe('null')
    expect(shown('multiUrlPicker')).toContain('https://umbraco.com')
    expect(shown('tags')).toBe('[&quot;news&quot;,&quot;bun&quot;]')
  })
})
