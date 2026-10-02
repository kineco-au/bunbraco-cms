/**
 * The README is a summary plus getting started; everything else lives in `docs/`.
 * That arrangement only works while the index is true, and an index is exactly the
 * thing nobody notices has gone stale — so it is checked rather than maintained by
 * good intentions.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')

/** Generated rather than written, so it is reference material and not part of the index. */
const GENERATED = new Set(['api-coverage.md'])

const docs = readdirSync(join(ROOT, 'docs'))
  .filter((file) => file.endsWith('.md'))
  .sort()

/** An anchor as GitHub derives it from a heading. */
const slug = (heading: string) =>
  heading
    .replace(/^#+\s*/, '')
    .toLowerCase()
    .replace(/[^\w\- ]+/g, '')
    .replace(/ /g, '-')

describe('the README', () => {
  test('links every design document, so none is orphaned', () => {
    const missing = docs
      .filter((file) => !GENERATED.has(file))
      .filter((file) => !readme.includes(`docs/${file}`))
    expect(missing).toEqual([])
  })

  test('links nothing that is not there', () => {
    const linked = [...readme.matchAll(/\]\((docs\/[\w.-]+\.md)[^)]*\)/g)].map(
      (m) => m[1] as string,
    )
    expect(linked.length).toBeGreaterThan(10)
    const dangling = [...new Set(linked)].filter((path) => !existsSync(join(ROOT, path)))
    expect(dangling).toEqual([])
  })

  test('has no dead internal anchor', () => {
    // The split moved most sections out; a `(#...)` left pointing at one of them
    // reads as a working link and goes nowhere.
    const anchors = [...readme.matchAll(/\]\(#([\w-]+)\)/g)].map((m) => m[1] as string)
    const headings = new Set((readme.match(/^#{1,6} .*$/gm) ?? []).map((heading) => slug(heading)))
    expect([...new Set(anchors)].filter((anchor) => !headings.has(anchor))).toEqual([])
  })

  test('stays a summary rather than becoming the manual again', () => {
    // It was 1,538 lines before the detail moved into `docs/`. The number is a
    // smell test, not a budget: well past this and the split has quietly undone
    // itself.
    expect(readme.split('\n').length).toBeLessThan(600)
  })

  test('still tells a newcomer how to run it, both ways', () => {
    for (const command of ['bun run start:local', 'bun run docker:up', 'bun run db:up'])
      expect(readme).toContain(command)
  })
})

describe('every design document', () => {
  for (const file of docs) {
    test(`${file} links nothing in docs/ that is missing`, () => {
      const text = readFileSync(join(ROOT, 'docs', file), 'utf8')
      const linked = [...text.matchAll(/\]\(([\w.-]+\.md)[^)]*\)/g)].map((m) => m[1] as string)
      const dangling = [...new Set(linked)].filter(
        (path) => !existsSync(join(ROOT, 'docs', path)) && !existsSync(join(ROOT, path)),
      )
      expect(dangling).toEqual([])
    })
  }
})
