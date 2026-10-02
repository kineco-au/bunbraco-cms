/**
 * Models Builder over `bunbraco generate`: the dashboard reports whether
 * `schema/content-types.d.ts` still matches the TOML, and its Generate button
 * writes the file. Umbraco flags staleness from a marker file; here the schema
 * is compared with what it would generate, so the answer cannot go stale.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareModels, createModelsBuilderPort, intendedTypes } from '@bunbraco/server'
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

const ARTICLE = `[document-type]
key = "0b1c8e3a-1111-4a5b-9c1d-000000000001"
alias = "article"
name = "Article"
allow-at-root = true

[[property]]
key = "0b1c8e3a-2222-4a5b-9c1d-000000000002"
alias = "title"
name = "Title"
type = "textstring"
`

function schemaDir(article = ARTICLE): string {
  const root = mkdtempSync(join(process.cwd(), 'output', 'models-'))
  dirs.push(root)
  const dir = join(root, 'schema')
  mkdirSync(join(dir, 'document-types'), { recursive: true })
  writeFileSync(join(dir, 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(dir, 'document-types', 'article.toml'), article)
  return dir
}

describe('the generated models', () => {
  test('are out of date until they are written, then current', async () => {
    const dir = schemaDir()
    const port = createModelsBuilderPort({ schemaDir: dir })

    expect(await port.status()).toBe('OutOfDate')
    expect((await port.info()).outOfDateModels).toBe(true)

    expect(await port.build()).toEqual({ ok: true })
    const written = readFileSync(join(dir, 'content-types.d.ts'), 'utf8')
    expect(written).toContain('interface Article')
    expect(written).toContain('title')

    expect(await port.status()).toBe('Current')
    const info = await port.info()
    expect(info.outOfDateModels).toBe(false)
    expect(info.lastError).toBeNull()
  })

  test('go stale when the schema changes underneath them', async () => {
    const dir = schemaDir()
    const port = createModelsBuilderPort({ schemaDir: dir })
    await port.build()
    expect(await port.status()).toBe('Current')

    writeFileSync(
      join(dir, 'document-types', 'article.toml'),
      `${ARTICLE}
[[property]]
key = "0b1c8e3a-3333-4a5b-9c1d-000000000003"
alias = "summary"
name = "Summary"
type = "textarea"
`,
    )
    expect(await port.status()).toBe('OutOfDate')
    expect(readFileSync(join(dir, 'content-types.d.ts'), 'utf8')).not.toContain('summary')

    await port.build()
    expect(readFileSync(join(dir, 'content-types.d.ts'), 'utf8')).toContain('summary')
    expect(await port.status()).toBe('Current')
  })

  test('report Unknown, not a guess, when the schema will not generate', async () => {
    const dir = schemaDir('[document-type]\nalias = "broken"\n')
    const port = createModelsBuilderPort({ schemaDir: dir })

    expect(await compareModels(dir)).toBeUndefined()
    expect(await port.status()).toBe('Unknown')
    expect((await port.info()).outOfDateModels).toBe(false)

    const result = await port.build()
    expect(result.ok).toBe(false)
    expect(existsSync(join(dir, 'content-types.d.ts'))).toBe(false)
    // The failure is only visible on the dashboard, as it is in Umbraco.
    expect((await port.info()).lastError).toBeTruthy()
  })

  test('a build that succeeds clears the error a previous one recorded', async () => {
    const dir = schemaDir('[document-type]\nalias = "broken"\n')
    const port = createModelsBuilderPort({ schemaDir: dir })
    await port.build()
    expect((await port.info()).lastError).toBeTruthy()

    writeFileSync(join(dir, 'document-types', 'article.toml'), ARTICLE)
    expect(await port.build()).toEqual({ ok: true })
    expect((await port.info()).lastError).toBeNull()
  })

  test('a missing schema directory is a problem, not a crash', () => {
    const result = intendedTypes(join(process.cwd(), 'output', 'no-such-schema-dir'))
    expect('problems' in result).toBe(true)
  })
})

describe('the models builder endpoints', () => {
  test('serve the dashboard, the status, and generate on request', async () => {
    const h = await signedInServer()
    open.push(h)

    const dashboard = await h.json<{
      mode: string
      canGenerate: boolean
      outOfDateModels: boolean
      trackingOutOfDateModels: boolean
      lastError: string | null
      version: string | null
      modelsNamespace: string | null
    }>(`${V1}/models-builder/dashboard`)
    // The client only explains Umbraco's own mode strings, and only shows the
    // Generate button when canGenerate is true.
    expect(dashboard.mode).toBe('SourceCodeManual')
    expect(dashboard.canGenerate).toBe(true)
    expect(dashboard.trackingOutOfDateModels).toBe(true)
    expect(dashboard.version).toBeTruthy()
    expect(dashboard.modelsNamespace).toContain('content-types.d.ts')

    const status = await h.json<{ status: string }>(`${V1}/models-builder/status`)
    expect(['OutOfDate', 'Current', 'Unknown']).toContain(status.status)

    // A build answers 200 whether or not it generated, as Umbraco's does.
    const build = await h.post(`${V1}/models-builder/build`, {})
    expect(build.status).toBe(200)
  })
})
