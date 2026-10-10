/**
 * The template editor's inserts write TSX into a view. The Razor they are
 * translated from comes from Umbraco's own vendored builders, so a change to
 * their output upstream fails here rather than in somebody's view.
 */
import { describe, expect, test } from 'bun:test'
import { queryExpression } from '../packages/api-management/src/handlers/template-query.ts'
import {
  getInsertDictionarySnippet,
  getInsertPartialSnippet,
  getQuerySnippet,
  getUmbracoFieldSnippet,
} from '../packages/backoffice-dist/dist/packages/templating/utils/index.js'
import { toTsxSnippet } from '../packages/backoffice-host/plugin/tsx-snippets.js'

const source = (path: string) => Bun.file(`packages/backoffice-host/${path}`).text()

describe('a value insert', () => {
  test('reads the property as text', () => {
    expect(toTsxSnippet(getUmbracoFieldSnippet('title'))).toBe("{model.text('title')}")
  })

  test('keeps its fallback and default', () => {
    expect(toTsxSnippet(getUmbracoFieldSnippet('title', null, true))).toBe(
      "{model.text('title', { fallback: 'ancestors' })}",
    )
    expect(toTsxSnippet(getUmbracoFieldSnippet('title', 'Untitled'))).toBe(
      "{model.text('title', { fallback: 'defaultValue', default: 'Untitled' })}",
    )
    // Ancestors first, then the default: `value()` falls to `default` when the
    // ancestors have nothing
    expect(toTsxSnippet(getUmbracoFieldSnippet('title', 'Untitled', true))).toBe(
      "{model.text('title', { fallback: 'ancestors', default: 'Untitled' })}",
    )
  })

  test('quotes what an editor typed', () => {
    expect(toTsxSnippet(getUmbracoFieldSnippet('title', "It's \\ here"))).toBe(
      "{model.text('title', { fallback: 'defaultValue', default: 'It\\'s \\\\ here' })}",
    )
  })
})

test('a dictionary insert reads the item in the page culture', () => {
  expect(toTsxSnippet(getInsertDictionarySnippet('Footer.Copyright'))).toBe(
    "{dictionary('Footer.Copyright')}",
  )
})

test('a query lists its selection as links, in markup rather than a Razor block', () => {
  const expression = queryExpression({
    rootKey: null,
    documentTypeAlias: 'article',
    filters: [],
    sort: null,
    take: 5,
  })
  expect(toTsxSnippet(getQuerySnippet(expression))).toBe(
    [
      '<ul>',
      '  {nav.children(model)',
      "    .filter((item) => item.contentType.alias === 'article')",
      '    .slice(0, 5)',
      '    .map((item) => (',
      '      <li>',
      '        <a href={item.url}>{item.name}</a>',
      '      </li>',
      '    ))}',
      '</ul>',
      '',
    ].join('\n'),
  )
})

test('anything else is inserted as it came', () => {
  expect(toTsxSnippet('plain text')).toBe('plain text')
  // Hidden, so never asked for; not something to guess at either
  const partial = getInsertPartialSnippet('shared/footer')
  expect(toTsxSnippet(partial)).toBe(partial)
})

describe('the template editor', () => {
  test('translates what it inserts into a view, and only a view', async () => {
    const editors = await source('plugin/tsx-editors.js')
    expect(editors).toContain("import { toTsxSnippet } from './tsx-snippets.js'")
    expect(editors).toContain('views.has(this) ? toTsxSnippet(text) : text')
  })

  test('hides the inserts with no TSX equivalent', async () => {
    const editors = await source('plugin/tsx-editors.js')
    // Umbraco's own switch, the one the partial view editor already sets
    expect(editors).toMatch(/defineProperty\(menu, 'hidePartialViews'/)
    expect(editors).toContain("querySelector('#sections-button')")
  })
})
