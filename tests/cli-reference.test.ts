/**
 * The command line reference in the product site's docs is written from the
 * CLI's manifest, so it says what the CLI does: every command, its arguments
 * and the exit codes, and nothing that has since changed.
 */

import { describe, expect, test } from 'bun:test'
import { ERROR_KINDS, OUTCOMES } from '../packages/cli/src/errors.ts'
import { buildManifest } from '../packages/cli/src/manifest.ts'
import {
  CLI_PAGES,
  cliIndexHtml,
  cliReferencePages,
  commandAnchor,
  exitCodesHtml,
  unplacedTopics,
} from '../packages/cli/src/reference.ts'

describe('the command line reference', () => {
  test('every topic has a page, so a new command cannot go unlisted', async () => {
    expect(unplacedTopics(await buildManifest())).toEqual([])
    const topics = CLI_PAGES.flatMap((page) => page.topics)
    expect(new Set(topics).size).toBe(topics.length)
  })

  test('covers every command that is not hidden, once, anchored on its page', async () => {
    const manifest = await buildManifest()
    const pages = cliReferencePages(manifest)
    expect(pages.map((page) => page.slug)).toEqual(CLI_PAGES.map((page) => page.slug))
    const listed = pages.flatMap((page) => page.commands)
    for (const command of Object.values(manifest.commands).filter((c) => !c.hidden)) {
      const name = command.id.replaceAll(':', ' ')
      expect(
        listed.filter((n) => n === name),
        name,
      ).toHaveLength(1)
      const page = pages.find((p) => p.commands.includes(name))
      expect(page?.html).toContain(
        `<h2 id="${commandAnchor(name)}"><code>crombolo ${name}</code></h2>`,
      )
    }
    for (const page of pages) expect(page.html).not.toContain('<script')
  })

  test('the index links every command to its anchor', async () => {
    const pages = cliReferencePages(await buildManifest())
    const index = cliIndexHtml(pages, '/docs/reference/command-line/')
    expect(index).toContain(
      '<a href="/docs/reference/command-line/content/#content-publish"><code>crombolo content publish</code></a>',
    )
    expect(index).toContain('<a href="/docs/reference/exit-codes/">')
  })

  test('the exit codes are every error kind and outcome', async () => {
    const html = exitCodesHtml(await buildManifest())
    for (const [kind, e] of Object.entries(ERROR_KINDS))
      expect(html).toContain(`<tr><td>${e.exitCode}</td><td><code>${kind}</code>`)
    for (const [name, o] of Object.entries(OUTCOMES))
      expect(html).toContain(`<tr><td>${o.code}</td><td><code>${name}</code>`)
    expect(html).toContain('<h2 id="envelope">')
  })
})
