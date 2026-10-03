/** Shared by the importer's tests: the fixture, and putting a plan on disk as the CLI does. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ImportPlan } from '@bunbraco/import-umbraco'

/** An Umbraco 17 site with Umbraco Commerce; see `tests/fixtures/umbraco/README.md`. */
export const DEMO_STORE = join(
  import.meta.dir,
  '..',
  'fixtures',
  'umbraco',
  'UmbracoCommerceDemoStore_v17.0.0.bacpac',
)

export async function writePlan(dir: string, plan: ImportPlan): Promise<void> {
  for (const file of plan.files) {
    const target = join(dir, file.path)
    mkdirSync(dirname(target), { recursive: true })
    if (file.copyFrom !== undefined) await Bun.write(target, Bun.file(file.copyFrom))
    else writeFileSync(target, file.bytes ?? file.text ?? '')
  }
}
