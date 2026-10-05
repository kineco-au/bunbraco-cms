/**
 * The schema-as-code core: strict parsing, whole-set validation, and a canonical
 * writer that round-trips. docs/09-schema-as-code.md.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  allProperties,
  BUILTIN_DATA_TYPE_ALIASES,
  fileNameFor,
  hashSchemaSet,
  loadSchemaDirectory,
  parseDataType,
  parseDocumentType,
  parseLanguages,
  parseSchemaVersion,
  type SchemaDocumentType,
  type SchemaSet,
  validateSchemaSet,
  writeDataType,
  writeDocumentType,
  writeLanguages,
} from '@bunbraco/schema'

const HOME_PAGE = `
# a comment, which the writer will drop
[document-type]
key = "8c3a6c2e-5d4f-4d3e-9d6d-2b7f8a1c9e10"
alias = "homePage"
name = "Home Page"
description = "The site landing page"
notes = "Owned by marketing."
icon = "icon-home"
allow-at-root = true
compositions = ["seoFields"]
allow-children = ["textPage", "newsPage"]
components = ["homePage"]
default-component = "homePage"

[document-type.cleanup]
keep-all-newer-than-days = 7

[[tab]]
name = "Content"

[[tab.property]]
alias = "title"
name = "Title"
description = "Shown as the page heading"
type = "textstring"
mandatory = true
mandatory-message = "Please add a title"

[[tab.property]]
alias = "bodyText"
name = "Body"
type = "richtext"

[[tab]]
name = "SEO"

[[tab.group]]
name = "Meta"

[[tab.group.property]]
alias = "metaDescription"
name = "Meta description"
type = "textarea"
regex = "^.{0,160}$"
regex-message = "Keep it under 160 characters"
default = ""
since = "2.1"

[[property]]
alias = "hidden"
name = "Ungrouped"
type = "trueFalse"
`

function set(overrides: Partial<SchemaSet> = {}): SchemaSet {
  return { version: '1.0', documentTypes: [], dataTypes: [], languages: [], ...overrides }
}

function type(alias: string, extra: Partial<SchemaDocumentType> = {}): SchemaDocumentType {
  return {
    alias,
    name: alias,
    icon: 'icon-document',
    allowAtRoot: false,
    isElement: false,
    allowInLibrary: false,
    variesByCulture: false,
    variesBySegment: false,
    compositions: [],
    allowChildren: [],
    components: [],
    cleanup: { prevent: false },
    properties: [],
    tabs: [],
    ...extra,
  }
}

const prop = (alias: string, typeAlias = 'textstring', extra = {}) => ({
  alias,
  name: alias,
  type: typeAlias,
  mandatory: false,
  variesByCulture: false,
  variesBySegment: false,
  labelOnTop: false,
  ...extra,
})

describe('parsing', () => {
  test('reads the documented example, with defaults applied', () => {
    const { value, problems } = parseDocumentType('home-page.toml', HOME_PAGE)
    expect(problems).toEqual([])
    expect(value?.alias).toBe('homePage')
    expect(value?.key).toBe('8c3a6c2e-5d4f-4d3e-9d6d-2b7f8a1c9e10')
    expect(value?.allowAtRoot).toBe(true)
    expect(value?.isElement).toBe(false)
    expect(value?.cleanup).toEqual({
      prevent: false,
      keepAllNewerThanDays: 7,
      keepLatestPerDayForDays: undefined,
    })
    expect(value?.tabs.map((t) => t.name)).toEqual(['Content', 'SEO'])
    expect(value?.tabs[1]?.groups[0]?.properties[0]?.alias).toBe('metaDescription')
    expect(value?.tabs[1]?.groups[0]?.properties[0]?.default).toBe('')
    expect(value?.tabs[1]?.groups[0]?.properties[0]?.since).toBe('2.1')
    expect(value?.properties.map((p) => p.alias)).toEqual(['hidden'])
    expect(allProperties(value as SchemaDocumentType).map((p) => p.alias)).toEqual([
      'hidden',
      'title',
      'bodyText',
      'metaDescription',
    ])
  })

  test('rejects an unknown key, naming the file and where', () => {
    const { value, problems } = parseDocumentType(
      'x.toml',
      '[document-type]\nalias = "a"\nname = "A"\nallow-at-rooot = true\n',
    )
    expect(value).toBeUndefined()
    expect(problems).toHaveLength(1)
    expect(problems[0]?.file).toBe('x.toml')
    expect(problems[0]?.path).toBe('document-type.allow-at-rooot')
    expect(problems[0]?.message).toContain('unknown key')
  })

  test('rejects a missing required key and a wrong type, reporting every problem', () => {
    const { problems } = parseDocumentType(
      'x.toml',
      '[document-type]\nname = 5\n[[tab]]\n[[tab.property]]\nalias = "p"\nname = "P"\n',
    )
    const paths = problems.map((p) => p.path).sort()
    expect(paths).toEqual([
      'document-type.alias',
      'document-type.name',
      'tab[0].name',
      'tab[0].property[0].type',
    ])
  })

  test('reports invalid TOML with the file name', () => {
    const { problems } = parseDataType('bad.toml', '[data-type\nalias = "x"')
    expect(problems[0]?.file).toBe('bad.toml')
    expect(problems[0]?.message).toContain('invalid TOML')
  })

  test('parses data types, languages and the schema version', () => {
    expect(
      parseDataType(
        'd.toml',
        '[data-type]\nalias = "shortText"\nname = "Short"\neditor = "Umbraco.TextBox"\n[data-type.config]\nmaxChars = 80\n',
      ).value,
    ).toEqual({
      key: undefined,
      alias: 'shortText',
      name: 'Short',
      notes: undefined,
      editor: 'Umbraco.TextBox',
      editorUi: undefined,
      config: { maxChars: 80 },
      since: undefined,
    })
    expect(
      parseLanguages(
        'l.toml',
        '[[language]]\niso = "en-US"\nname = "English"\ndefault = true\n[[language]]\niso = "da-DK"\nname = "Danish"\nfallback = "en-US"\n',
      ).value,
    ).toEqual([
      { iso: 'en-US', name: 'English', default: true, mandatory: false, fallback: undefined },
      { iso: 'da-DK', name: 'Danish', default: false, mandatory: false, fallback: 'en-US' },
    ])
    expect(parseSchemaVersion('s.toml', '[schema]\nversion = "2.1"\n').value).toBe('2.1')
  })
})

describe('canonical writer', () => {
  test('round-trips a document type exactly, dropping comments', () => {
    const parsed = parseDocumentType('home-page.toml', HOME_PAGE).value as SchemaDocumentType
    const written = writeDocumentType(parsed)
    expect(written).not.toContain('# a comment')
    expect(written.startsWith('[document-type]\nkey = ')).toBe(true)
    const again = parseDocumentType('home-page.toml', written)
    expect(again.problems).toEqual([])
    expect(again.value).toEqual(parsed)
    // Writing the re-parsed model yields byte-identical output: canonical.
    expect(writeDocumentType(again.value as SchemaDocumentType)).toBe(written)
  })

  test('round-trips data types and languages', () => {
    const d = {
      alias: 'shortText',
      name: 'Short',
      editor: 'Umbraco.TextBox',
      editorUi: 'Umb.PropertyEditorUi.TextBox',
      config: { maxChars: 80, placeholder: 'x "y"' },
      key: undefined,
      notes: 'n',
      since: undefined,
    }
    expect(parseDataType('d.toml', writeDataType(d)).value).toEqual(d)
    const langs = [
      { iso: 'en-US', name: 'English', default: true, mandatory: true, fallback: undefined },
      { iso: 'da-DK', name: 'Danish', default: false, mandatory: false, fallback: 'en-US' },
    ]
    expect(parseLanguages('l.toml', writeLanguages(langs)).value).toEqual(langs)
  })

  test('a config key cannot write lines of its own, however it is spelled', () => {
    // A value alias arrives from the API and from proposed TOML, so it is the one
    // key in the writer that is not ours. Bare, a newline in it would turn one
    // line into several and the file would stop parsing — which a site only finds
    // out about at its next boot.
    const d = {
      alias: 'shortText',
      name: 'Short',
      editor: 'Umbraco.TextBox',
      editorUi: 'Umb.PropertyEditorUi.TextBox',
      config: { 'a\nb = 1\n[evil]': 2, 'plain-key': 'kept' },
      key: undefined,
      notes: undefined,
      since: undefined,
    }
    const written = writeDataType(d)
    expect(written).toContain('"a\\nb = 1\\n[evil]" = 2')
    expect(written).toContain('plain-key = "kept"')
    // One table, not two: the injected header is part of a key, not a section.
    expect(written.match(/^\[.*\]$/gm)).toEqual(['[data-type]', '[data-type.config]'])
    const again = parseDataType('d.toml', written)
    expect(again.problems).toEqual([])
    expect(again.value).toEqual(d)
  })

  test('omits defaults so files stay short', () => {
    const written = writeDocumentType(type('plain'))
    expect(written).toBe('[document-type]\nalias = "plain"\nname = "plain"\n')
  })

  test('names files as kebab-case of the alias', () => {
    expect(fileNameFor('homePage')).toBe('home-page.toml')
    expect(fileNameFor('SEOFields')).toBe('seo-fields.toml')
  })
})

describe('validation', () => {
  test('a coherent set has no problems', () => {
    const problems = validateSchemaSet(
      set({
        documentTypes: [
          type('seo', { isElement: true, properties: [prop('metaTitle')] }),
          type('home', {
            allowAtRoot: true,
            compositions: ['seo'],
            allowChildren: ['text'],
            components: ['home'],
            defaultComponent: 'home',
            tabs: [{ name: 'Content', properties: [prop('title')], groups: [] }],
          }),
          type('text'),
        ],
        languages: [{ iso: 'en-US', name: 'English', default: true, mandatory: true }],
      }),
      { componentAliases: new Set(['home']) },
    )
    expect(problems).toEqual([])
  })

  test('reports every kind of reference problem at once', () => {
    const problems = validateSchemaSet(
      set({
        documentTypes: [
          type('a', {
            compositions: ['b'],
            allowChildren: ['nope'],
            components: ['t'],
            defaultComponent: 'other',
            properties: [prop('x', 'unknownType'), prop('x')],
          }),
          type('b', { compositions: ['a'] }),
          type('c'),
          type('c'),
        ],
        languages: [
          { iso: 'en-US', name: 'E', default: true, mandatory: false },
          { iso: 'da-DK', name: 'D', default: true, mandatory: false, fallback: 'sv-SE' },
        ],
      }),
      { componentAliases: new Set() },
    )
    const messages = problems.map((p) => p.message)
    expect(messages.some((m) => m.includes('duplicate type alias "c"'))).toBe(true)
    expect(messages.some((m) => m.includes('unknown data type "unknownType"'))).toBe(true)
    expect(messages.some((m) => m === 'duplicate property alias')).toBe(true)
    expect(messages.some((m) => m.includes('unknown type "nope"'))).toBe(true)
    expect(messages.some((m) => m.includes('"other" is not in components'))).toBe(true)
    expect(messages.some((m) => m.includes('no components/t.tsx'))).toBe(true)
    expect(messages.some((m) => m.includes('composition cycle: a -> b -> a'))).toBe(true)
    expect(messages.some((m) => m.includes('exactly one language must be default; found 2'))).toBe(
      true,
    )
    expect(messages.some((m) => m.includes('unknown language "sv-SE"'))).toBe(true)
  })

  test('a culture-variant property needs a culture-variant type', () => {
    const problems = validateSchemaSet(
      set({
        documentTypes: [
          type('a', { properties: [prop('x', 'textstring', { variesByCulture: true })] }),
        ],
      }),
    )
    expect(problems.map((p) => p.path)).toEqual(['property "x".varies-by-culture'])
  })

  test('built-in data types need no file, and can be overridden', () => {
    expect(BUILTIN_DATA_TYPE_ALIASES.has('textstring')).toBe(true)
    const problems = validateSchemaSet(
      set({
        dataTypes: [{ alias: 'textstring', name: 'Mine', editor: 'Umbraco.TextBox', config: {} }],
        documentTypes: [type('a', { properties: [prop('x', 'textstring')] })],
      }),
    )
    expect(problems).toEqual([])
  })

  test('versions must be dotted numbers', () => {
    const problems = validateSchemaSet(
      set({ version: 'v2', documentTypes: [type('a', { since: 'soon' })] }),
    )
    expect(problems.map((p) => p.path).sort()).toEqual(['document-type.since', 'schema.version'])
  })
})

describe('loading a directory', () => {
  function scaffold(): string {
    const dir = mkdtempSync(join(tmpdir(), 'bb-schema-'))
    mkdirSync(join(dir, 'document-types'), { recursive: true })
    mkdirSync(join(dir, 'data-types'), { recursive: true })
    writeFileSync(join(dir, 'schema.toml'), '[schema]\nversion = "1.2"\n')
    writeFileSync(join(dir, 'document-types', 'home-page.toml'), HOME_PAGE)
    writeFileSync(
      join(dir, 'document-types', 'seo.toml'),
      '[document-type]\nalias = "seoFields"\nname = "SEO"\nis-element = true\n',
    )
    writeFileSync(
      join(dir, 'data-types', 'short.toml'),
      '[data-type]\nalias = "shortText"\nname = "Short"\neditor = "Umbraco.TextBox"\n',
    )
    writeFileSync(
      join(dir, 'languages.toml'),
      '[[language]]\niso = "en-US"\nname = "English"\ndefault = true\n',
    )
    return dir
  }

  test('assembles the set and remembers each file', () => {
    const dir = scaffold()
    const loaded = loadSchemaDirectory(dir)
    expect(loaded.problems).toEqual([])
    expect(loaded.set.version).toBe('1.2')
    expect(loaded.set.documentTypes.map((t) => t.alias).sort()).toEqual(['homePage', 'seoFields'])
    expect(loaded.set.dataTypes.map((d) => d.alias)).toEqual(['shortText'])
    expect(loaded.set.languages[0]?.iso).toBe('en-US')
    expect(loaded.files.get('homePage')).toBe(join(dir, 'document-types', 'home-page.toml'))
  })

  test('problems carry a schema-relative file path', () => {
    const dir = scaffold()
    writeFileSync(
      join(dir, 'document-types', 'bad.toml'),
      '[document-type]\nalias = "bad"\nname = "Bad"\ncolour = "red"\n',
    )
    const loaded = loadSchemaDirectory(dir)
    expect(loaded.problems[0]?.file).toBe('schema/document-types/bad.toml')
  })

  test('the hash ignores order, whitespace and comments, and notices meaning', () => {
    const a = loadSchemaDirectory(scaffold()).set
    const b: SchemaSet = { ...a, documentTypes: [...a.documentTypes].reverse() }
    expect(hashSchemaSet(a)).toBe(hashSchemaSet(b))
    const dir = scaffold()
    writeFileSync(
      join(dir, 'document-types', 'home-page.toml'),
      `${HOME_PAGE}\n# trailing comment\n\n`,
    )
    expect(hashSchemaSet(loadSchemaDirectory(dir).set)).toBe(hashSchemaSet(a))
    const changed: SchemaSet = {
      ...a,
      documentTypes: a.documentTypes.map((t) =>
        t.alias === 'homePage' ? { ...t, name: 'Renamed' } : t,
      ),
    }
    expect(hashSchemaSet(changed)).not.toBe(hashSchemaSet(a))
  })
})
