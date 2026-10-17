/**
 * Regenerates the settings tables in docs/configuration.md from the settings
 * list, between the `settings:start` and `settings:end` markers.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { settingsMarkdown } from '@crombolo/server'

const FILE = join(import.meta.dir, '..', 'docs', 'configuration.md')
const REGION = /(<!-- settings:start -->)[\s\S]*?(<!-- settings:end -->)/

const before = readFileSync(FILE, 'utf8')
if (!REGION.test(before)) {
  console.error('docs/configuration.md has no settings:start / settings:end markers.')
  process.exit(1)
}
const after = before.replace(
  REGION,
  (_, start, end) => `${start}\n\n${settingsMarkdown()}\n\n${end}`,
)
if (after === before) console.log('docs/configuration.md is up to date.')
else {
  writeFileSync(FILE, after)
  console.log('docs/configuration.md: settings tables regenerated.')
}
