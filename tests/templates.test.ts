/**
 * The starter templates and what `bunbraco init` writes.
 *
 * `tests/integration/new-site.integration.ts` boots a scaffolded site; this
 * holds the shipped templates to the rules a site is held to — valid schema, a
 * view for every template alias, a bundle that reads back — so a template that
 * would fail in somebody's terminal fails here first.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  findTemplate,
  listTemplates,
  packageNameFor,
  type SiteTemplate,
  scaffoldFiles,
} from '@bunbraco/cli'
import { allProperties, loadSchemaDirectory, validateSchemaSet } from '@bunbraco/schema'
import { loadBundle } from '@bunbraco/transfer'

const templates = listTemplates()
const byId = (id: string): SiteTemplate => {
  const found = findTemplate(id)
  if (!found) throw new Error(`no template "${id}"`)
  return found
}

describe('the starter templates', () => {
  test('are listed with what they contain, and an unknown one is not invented', () => {
    expect(templates.map((t) => t.id)).toEqual(['basic', 'demo/harbourstone'])
    for (const template of templates) {
      expect(template.name).not.toBe('')
      expect(template.description).not.toBe('')
    }
    // A family is a directory of templates, so more demos need no code.
    expect(byId('demo/harbourstone').id).toContain('/')
    expect(findTemplate('demo')).toBeUndefined()
    expect(findTemplate('nope')).toBeUndefined()
  })

  test.each(templates.map((t) => [t.id] as const))('%s has schema a site would accept', (id) => {
    const template = byId(id)
    const loaded = loadSchemaDirectory(join(template.dir, 'files', 'schema'))
    const views = new Set(
      readdirSync(join(template.dir, 'files', 'Views'))
        .filter((name) => name.endsWith('.tsx'))
        .map((name) => name.replace(/\.tsx$/, '')),
    )
    const problems = [
      ...loaded.problems,
      ...validateSchemaSet(loaded.set, { templateAliases: views }),
    ]
    expect(problems.map((p) => `${p.file}: ${p.message}`)).toEqual([])

    // Keys in the files, or the first sync in a new site would assign its own
    // and the bundle's content types would match nothing.
    for (const type of [...loaded.set.documentTypes, ...(loaded.set.mediaTypes ?? [])]) {
      expect(type.key, type.alias).toBeTruthy()
      for (const property of allProperties(type)) expect(property.key, property.alias).toBeTruthy()
    }
    for (const dataType of loaded.set.dataTypes) expect(dataType.key, dataType.alias).toBeTruthy()
  })

  test.each(templates.map((t) => [t.id] as const))('%s ships a bundle that reads back', (id) => {
    const template = byId(id)
    expect(template.bundle).toBe(`bundles/${id.replaceAll('/', '-')}`)
    const loaded = loadBundle(join(template.dir, 'bundle'))
    // Integrity is over the node files' text, so this also catches a formatter
    // or an editor having been let loose on a committed artifact.
    expect(loaded.problems.map((p) => `${p.file}: ${p.message}`)).toEqual([])
    expect(loaded.set?.nodes.length ?? 0).toBeGreaterThan(0)

    const set = loaded.set
    if (!set) return
    // Every type the bundle needs is one this template's own files define.
    const aliases = new Set(
      loadSchemaDirectory(join(template.dir, 'files', 'schema')).set.documentTypes.map(
        (t) => t.alias,
      ),
    )
    const seeded = new Set(['Image', 'File', 'Folder'])
    for (const type of set.manifest.dependencies.schema.contentTypes)
      expect(aliases.has(type.alias) || seeded.has(type.alias), type.alias).toBe(true)
    // And nothing it expects to find at the destination, which a new site has not got.
    expect(set.manifest.dependencies.expected).toEqual([])
  })

  test('the demo carries the bytes for every media file its bundle names', () => {
    const template = byId('demo/harbourstone')
    const loaded = loadBundle(join(template.dir, 'bundle'))
    // Integrity covers the bytes, so a loaded bundle is one whose images are
    // the images it was built with.
    expect(loaded.problems).toEqual([])
    const blobs = loaded.set?.manifest.blobs ?? []
    expect(blobs.length).toBeGreaterThan(0)
    for (const blob of blobs) {
      // Carried, so a new site gets its images wherever its media lives — a
      // disk, a bucket, a container — rather than only on a local disk.
      expect(blob.included, blob.key).toBe(true)
      const file = loaded.blobs.get(blob.key)
      expect(file, blob.key).toBeTruthy()
      expect(readFileSync(file as string).length).toBe(blob.size as number)
    }
  })
})

describe('what init writes', () => {
  test('is a package, a config, a server and a schema directory', () => {
    const paths = scaffoldFiles().map((f) => f.path)
    expect(paths).toContain('package.json')
    expect(paths).toContain('bunbraco.config.ts')
    expect(paths).toContain('server.ts')
    expect(paths).toContain('tsconfig.json')
    expect(paths).toContain('schema/schema.toml')
    expect(paths).toContain('.gitignore')
    expect(paths).not.toContain('.env')
  })

  test('names the site, and the package after it', () => {
    const files = scaffoldFiles({ siteName: 'Harbourstone Distillery' })
    const manifest = JSON.parse(
      files.find((f) => f.path === 'package.json')?.text ?? '{}',
    ) as Record<string, unknown>
    expect(manifest.name).toBe('harbourstone-distillery')
    expect(files.find((f) => f.path === 'bunbraco.config.ts')?.text).toContain(
      "siteName: 'Harbourstone Distillery'",
    )
    // A name npm will take, whatever was typed.
    expect(packageNameFor('  Ardbeg & Co. ')).toBe('ardbeg-co')
    expect(packageNameFor('***')).toBe('my-site')
    // A quote in the name must not end the string it is written into.
    expect(
      scaffoldFiles({ siteName: "Mac's" }).find((f) => f.path === 'bunbraco.config.ts')?.text,
    ).toContain("siteName: 'Mac\\'s'")
  })

  test('adds the Postgres environment only when asked, and gitignores it', () => {
    const files = scaffoldFiles({ siteName: 'Site', postgres: true })
    const env = files.find((f) => f.path === '.env')?.text ?? ''
    expect(env).toContain('BUNBRACO_DB=postgres')
    expect(env).toContain('BUNBRACO_POSTGRES_URL=')
    expect(env).toContain('BUNBRACO_PG_DUMP')
    expect(files.find((f) => f.path === '.gitignore')?.text).toContain('.env')
  })

  test('puts a template’s files where a site keeps them, and wires the import into `start`', () => {
    const template = byId('demo/harbourstone')
    const files = scaffoldFiles({ siteName: 'Harbourstone', template })
    const paths = files.map((f) => f.path)

    expect(paths).toContain('Views/homePage.tsx')
    expect(paths).toContain('schema/document-types/home-page.toml')
    expect(paths).toContain('css/site.css')
    expect(paths.some((p) => p.startsWith('bundles/demo-harbourstone/nodes/'))).toBe(true)
    expect(paths).toContain('bundles/demo-harbourstone/bundle.json')
    // The images travel inside the bundle, not as a directory of their own.
    expect(paths.some((p) => p.startsWith('bundles/demo-harbourstone/blobs/'))).toBe(true)
    expect(paths.some((p) => p.startsWith('media/'))).toBe(false)
    // Everything from the template is copied, not rewritten.
    for (const file of files.filter((f) => f.path.startsWith('bundles/')))
      expect(file.copyFrom).toBeTruthy()

    const manifest = JSON.parse(files.find((f) => f.path === 'package.json')?.text ?? '{}') as {
      scripts: Record<string, string>
    }
    expect(manifest.scripts.start).toBe(
      'bunbraco start --bundle bundles/demo-harbourstone --publish',
    )
  })

  test('lets a template win over the file it would otherwise scaffold', () => {
    const files = scaffoldFiles({ template: byId('basic') })
    const schemaFiles = files.filter((f) => f.path === 'schema/schema.toml')
    // One entry, and it is the template's — `init` skips a file that is already
    // on disk, so planning both would have let the scaffolded one win.
    expect(schemaFiles).toHaveLength(1)
    expect(schemaFiles[0]?.copyFrom).toBeTruthy()
  })
})
