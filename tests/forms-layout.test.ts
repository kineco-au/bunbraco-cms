/**
 * Story 094: the form designer's layout operations, which are pure, and the
 * file a reorder writes — a move, not a rewrite.
 */
import { describe, expect, test } from 'bun:test'
import { parseForm, writeForm } from '@crombolo/schema'
import {
  addGroup,
  addPage,
  groupHasFields,
  layoutRows,
  moved,
  moveField,
  moveGroup,
  movePage,
  nudgeField,
  pageHasFields,
  removeGroup,
  removePage,
  setColumns,
  setGroupCaption,
  setPageCaption,
  withLayout,
} from '../packages/backoffice-host/plugin/forms-layout.js'

const field = (alias: string) => ({
  alias,
  type: 'shortAnswer',
  caption: alias,
  values: [],
  accept: [],
})

const form = () => ({
  alias: 'f',
  name: 'F',
  pages: [
    {
      caption: 'One',
      groups: [
        { columns: 1, fields: [field('a'), field('b'), field('c')] },
        { columns: 2, fields: [field('d')] },
      ],
    },
    { caption: 'Two', groups: [{ columns: 1, fields: [field('e')] }] },
  ],
})

const aliases = (f: ReturnType<typeof form>) =>
  f.pages.map((page) => page.groups.map((group) => group.fields.map((x) => x.alias).join('')))

describe('moving things', () => {
  test('moved clamps to the list and leaves the original alone', () => {
    const list = [1, 2, 3]
    expect(moved(list, 0, 9)).toEqual([2, 3, 1])
    expect(moved(list, 2, -1)).toEqual([3, 1, 2])
    expect(list).toEqual([1, 2, 3])
  })

  test('a field moves within its group and into another, on another page too', () => {
    const start = form()
    expect(
      aliases(moveField(start, { page: 0, group: 0, index: 0 }, { page: 0, group: 0, index: 2 })),
    ).toEqual([['bca', 'd'], ['e']])
    expect(
      aliases(moveField(start, { page: 0, group: 0, index: 1 }, { page: 1, group: 0, index: 0 })),
    ).toEqual([['ac', 'd'], ['be']])
    expect(aliases(start)).toEqual([['abc', 'd'], ['e']])
  })

  test('the keyboard steps a field one place, and across into the next group at an edge', () => {
    expect(aliases(nudgeField(form(), { page: 0, group: 0, index: 1 }, -1))).toEqual([
      ['bac', 'd'],
      ['e'],
    ])
    expect(aliases(nudgeField(form(), { page: 0, group: 0, index: 2 }, 1))).toEqual([
      ['ab', 'cd'],
      ['e'],
    ])
    expect(aliases(nudgeField(form(), { page: 0, group: 1, index: 0 }, 1))).toEqual([
      ['abc', ''],
      ['de'],
    ])
    expect(aliases(nudgeField(form(), { page: 0, group: 0, index: 0 }, -1))).toEqual([
      ['abc', 'd'],
      ['e'],
    ])
  })

  test('pages and groups reorder', () => {
    expect(movePage(form(), 1, 0).pages.map((p: { caption?: string }) => p.caption)).toEqual([
      'Two',
      'One',
    ])
    expect(aliases(moveGroup(form(), 0, 1, 0))).toEqual([['d', 'abc'], ['e']])
  })
})

describe('adding, naming and removing', () => {
  test('a page and a group are added empty, one group to a new page', () => {
    expect(addPage(form()).pages[2]).toEqual({ groups: [{ columns: 1, fields: [] }] })
    expect(addGroup(form(), 1).pages[1]?.groups).toHaveLength(2)
  })

  test('the last page and a page’s last group stay', () => {
    const single = {
      ...form(),
      pages: [form().pages[1] as ReturnType<typeof form>['pages'][number]],
    }
    expect(removePage(single, 0).pages).toHaveLength(1)
    expect(removeGroup(single, 0, 0).pages[0]?.groups).toHaveLength(1)
    expect(removePage(form(), 0).pages.map((p: { caption?: string }) => p.caption)).toEqual(['Two'])
  })

  test('a blank caption is removed rather than kept empty', () => {
    expect(setPageCaption(form(), 0, '  ').pages[0]).not.toHaveProperty('caption')
    expect(setGroupCaption(form(), 0, 0, 'About you').pages[0]?.groups[0]).toMatchObject({
      caption: 'About you',
    })
  })

  test('removing asks first only when fields would go too', () => {
    expect(pageHasFields(form().pages[1])).toBe(true)
    expect(pageHasFields({ groups: [{ columns: 1, fields: [] }] })).toBe(false)
    expect(groupHasFields({ columns: 1, fields: [] })).toBe(false)
  })

  test('a form with no pages gets one page and one group to edit', () => {
    expect(withLayout({ alias: 'x', name: 'X', pages: [] }).pages).toEqual([
      { groups: [{ columns: 1, fields: [] }] },
    ])
  })
})

describe('columns', () => {
  test('are held between 1 and 4', () => {
    expect(setColumns(form(), 0, 0, 9).pages[0]?.groups[0]?.columns).toBe(4)
    expect(setColumns(form(), 0, 0, 0).pages[0]?.groups[0]?.columns).toBe(1)
  })

  test('the preview lays fields out in rows of that many', () => {
    const group = { columns: 2, fields: [field('a'), field('b'), field('c')] }
    expect(layoutRows(group).map((row) => row.map((f: { alias: string }) => f.alias))).toEqual([
      ['a', 'b'],
      ['c'],
    ])
  })
})

describe('the file a reorder writes', () => {
  const FILE = `[form]
alias = "contact"
name = "Contact"

[[page]]

  [[page.group]]

    [[page.group.field]]
    alias = "name"
    type = "shortAnswer"
    caption = "Name"

    [[page.group.field]]
    alias = "email"
    type = "email"
    caption = "Email"
    mandatory = true

    [[page.group.field]]
    alias = "message"
    type = "longAnswer"
    caption = "Message"
`

  test('is the same lines in a new order: a move, not a rewrite', () => {
    const parsed = parseForm('schema/forms/contact.toml', FILE).value
    if (!parsed) throw new Error('fixture does not parse')
    const before = writeForm(parsed)
    const reordered = moveField(
      parsed as never,
      { page: 0, group: 0, index: 2 },
      { page: 0, group: 0, index: 0 },
    )
    const after = writeForm(reordered as never)
    expect(after).not.toBe(before)
    expect([...after.split('\n')].sort()).toEqual([...before.split('\n')].sort())
    expect(parseForm('schema/forms/contact.toml', after).problems).toEqual([])
  })
})
