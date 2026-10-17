/**
 * The command line reference on the product site (story 150) is written from
 * the CLI's manifest, so it says what the CLI does: every command, its
 * arguments and the exit codes, and nothing that has since changed.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ERROR_KINDS, OUTCOMES } from '../packages/cli/src/errors.ts'
import { buildManifest } from '../packages/cli/src/manifest.ts'
import { cliReferenceHtml } from '../packages/cli/src/reference.ts'
import { ROOT } from '../scripts/packages.ts'

const PAGE = join(
  ROOT,
  'sites/crombolo/bundles/demo-crombolo/content/nodes/3c1e9b52-7d40-4f18-9a6e-150c11ec0150.json',
)

describe('the command line reference page', () => {
  test('covers every command that is not hidden, and every exit code', async () => {
    const manifest = await buildManifest()
    const html = cliReferenceHtml(manifest)
    for (const command of Object.values(manifest.commands).filter((c) => !c.hidden))
      expect(html, command.id).toContain(`<code>crombolo ${command.id.replaceAll(':', ' ')}</code>`)
    for (const [kind, e] of Object.entries(ERROR_KINDS))
      expect(html).toContain(`<tr><td>${e.exitCode}</td><td><code>${kind}</code>`)
    for (const [name, o] of Object.entries(OUTCOMES))
      expect(html).toContain(`<tr><td>${o.code}</td><td><code>${name}</code>`)
    expect(html).not.toContain('<script')
  })

  test('the page the product site publishes is the one the CLI writes today', async () => {
    const node = JSON.parse(readFileSync(PAGE, 'utf8')) as {
      values: Array<{ property: string; value: { markup?: string } }>
    }
    const published = node.values.find((v) => v.property === 'nextSteps')?.value.markup
    expect(
      published === cliReferenceHtml(await buildManifest()),
      'the commands changed: run `bun run build:template demo/crombolo` to rewrite the page',
    ).toBe(true)
  })
})
