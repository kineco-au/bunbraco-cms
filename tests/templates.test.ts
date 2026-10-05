/**
 * The starter templates and what `bunbraco init` writes.
 *
 * `tests/integration/new-site.integration.ts` boots a scaffolded site; this
 * holds the shipped templates to the rules a site is held to — valid schema, a
 * view for every template alias, a bundle that reads back — so a template that
 * would fail in somebody's terminal fails here first.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  findTemplate,
  listTemplates,
  packageNameFor,
  type SiteTemplate,
  scaffoldFiles,
} from '@bunbraco/cli'
import { allFormFields, type SchemaForm } from '@bunbraco/core'
import { allProperties, loadSchemaDirectory, validateSchemaSet } from '@bunbraco/schema'
import { listComponents } from '@bunbraco/server'
import { loadBundle } from '@bunbraco/transfer'
import { ROOT } from '../scripts/packages.ts'

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
    // Every component at any depth, keyed by the path that is its alias —
    // which is what the schema names and what the server scans for.
    const views = new Set(
      listComponents(join(template.dir, 'files', 'components')).map((c) => c.alias),
    )
    const problems = [
      ...loaded.problems,
      ...validateSchemaSet(loaded.set, { componentAliases: views }),
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

describe('the demo’s form', () => {
  const template = byId('demo/harbourstone')
  const forms = loadSchemaDirectory(join(template.dir, 'files', 'schema')).set.forms ?? []

  test('is a file in the schema directory, like the types beside it', () => {
    expect(forms.map((form) => form.alias)).toEqual(['contactEnquiry'])
    expect(forms[0]?.key).toBeTruthy()
  })

  test('is pointed at by the page that renders it', () => {
    // A `formPicker` stores a UUID, so a key that matches no file renders
    // nothing at all — silently, and only on the page nobody checked.
    const set = loadBundle(join(template.dir, 'bundle')).set
    const picked = (set?.nodes ?? []).flatMap((node) =>
      (node.values ?? [])
        .filter((value) => value.editor === 'Bunbraco.FormPicker')
        .map((value) => String(value.value)),
    )
    expect(picked).not.toBeEmpty()
    for (const key of picked) expect(forms.map((form) => form.key)).toContain(key)
  })

  test('is reachable from a property the content type declares', () => {
    const types = loadSchemaDirectory(join(template.dir, 'files', 'schema')).set.documentTypes
    const property = types
      .flatMap((type) => allProperties(type))
      .find((candidate) => candidate.alias === 'enquiryForm')
    expect(property?.type).toBe('formPicker')
  })

  test('is rendered by the view, with the submission passed through', () => {
    // Without `submission` a refused submission comes back on a bare page
    // instead of inside the site's own layout, which is the whole point of the
    // prop being on PageProps.
    const view = readFileSync(
      join(template.dir, 'files', 'components', 'pages', 'contactPage.tsx'),
      'utf8',
    )
    expect(view).toContain('<Form')
    expect(view).toContain('submission={submission}')
  })

  test('collects something, and asks before storing it', () => {
    const form = forms[0]
    expect(form?.storeEntries).toBe(true)
    const fields = allFormFields(form as SchemaForm)
    expect(fields.some((field) => field.type === 'dataConsent' && field.mandatory)).toBe(true)
    // The spam guards, which cost a visitor nothing and need no third party.
    expect(form?.honeypot).toBe(true)
    expect(form?.minimumSubmitSeconds).toBeGreaterThan(0)
  })
})

describe('a template that wires a server bundle', () => {
  test('adds the dependency and the import that turns it on', () => {
    const files = scaffoldFiles({ template: byId('demo/harbourstone'), siteName: 'Harbourstone' })
    const manifest = JSON.parse(
      files.find((file) => file.path === 'package.json')?.text as string,
    ) as { dependencies: Record<string, string> }
    expect(Object.keys(manifest.dependencies)).toContain('@bunbraco/simple-redirects')

    const config = files.find((file) => file.path === 'bunbraco.config.ts')?.text as string
    expect(config).toContain("import { redirects } from '@bunbraco/simple-redirects'")
    expect(config).toContain('bundles: [redirects()]')
    // The site is still named what was asked for, which a template shipping its
    // own config file would have thrown away.
    expect(config).toContain("siteName: 'Harbourstone'")
  })

  test('leaves the config alone for a template that wires none', () => {
    const config = scaffoldFiles({ template: byId('basic') }).find(
      (file) => file.path === 'bunbraco.config.ts',
    )?.text as string
    expect(config).not.toContain('bundles:')
    expect(config).toContain("import { defineConfig } from 'bunbraco'")
  })

  test('ignores a malformed entry rather than scaffolding a broken import', () => {
    expect(byId('basic').serverBundles).toEqual([])
    expect(byId('demo/harbourstone').serverBundles).toEqual([
      { package: '@bunbraco/simple-redirects', import: 'redirects' },
    ])
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

    expect(paths).toContain('components/pages/homePage.tsx')
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

describe('the demo’s element types, reused across page types', () => {
  const template = byId('demo/harbourstone')
  const set = loadSchemaDirectory(join(template.dir, 'files', 'schema')).set

  test('one highlight type answers for the figures and the decisions alike', () => {
    // The home page's figures and the About page's four decisions are the same
    // shape, so they are the same element type picked twice. If this ever
    // becomes two types, it is a decision somebody should have to make
    // deliberately rather than by adding a file.
    const highlight = set.documentTypes.find((type) => type.alias === 'highlight')
    expect(highlight?.isElement).toBe(true)

    const picker = (set.dataTypes ?? []).find((type) => type.alias === 'highlightPicker')
    expect(picker?.config?.allowedContentTypes).toBe(highlight?.key)

    const pickedBy = set.documentTypes
      .filter((type) => allProperties(type).some((property) => property.type === 'highlightPicker'))
      .map((type) => type.alias)
      .sort()
    expect(pickedBy).toEqual(['contentPage', 'homePage'])
  })

  test('every picker names a type that is in this template', () => {
    // A picker narrowed to a key that no longer exists offers nothing at all,
    // silently, and only in the dialog nobody opened.
    const keys = new Set(set.documentTypes.map((type) => type.key))
    for (const dataType of set.dataTypes ?? []) {
      const allowed = dataType.config?.allowedContentTypes
      if (typeof allowed !== 'string') continue
      for (const key of allowed.split(',').filter(Boolean))
        expect([dataType.alias, keys.has(key)]).toEqual([dataType.alias, true])
    }
  })
})

describe('the demo’s photographs', () => {
  const template = byId('demo/harbourstone')
  const sources = join(ROOT, 'assets/templates/harbourstone')

  test('are the files in assets/, byte for byte', () => {
    // `build:template` copies the bytes through rather than re-encoding them:
    // re-encoding an already-compressed JPEG would churn the committed bundle
    // on every build and lose a little more of the image each time.
    const blobs = join(template.dir, 'bundle', 'blobs')
    const shipped = readdirSync(blobs, { recursive: true, encoding: 'utf8' }).filter((file) =>
      file.endsWith('.jpg'),
    )
    expect(shipped.length).toBeGreaterThan(0)
    for (const file of shipped) {
      const source = join(sources, basename(file))
      expect([file, existsSync(source)]).toEqual([file, true])
      expect(readFileSync(join(blobs, file))).toEqual(readFileSync(source))
    }
  })

  test('are not published a second time as sources', () => {
    // `assets/` is outside the `files` list, so the originals stay in the
    // repository and only the bundle ships.
    const manifest = JSON.parse(readFileSync(join(ROOT, 'packages/cli/package.json'), 'utf8')) as {
      files: string[]
    }
    expect(manifest.files.some((entry) => entry.startsWith('assets'))).toBe(false)
  })
})

describe('the demo’s typography', () => {
  const template = byId('demo/harbourstone')
  const css = readFileSync(join(template.dir, 'files', 'css', 'site.css'), 'utf8')
  const layout = readFileSync(
    join(template.dir, 'files', 'components', 'shared', 'layout.tsx'),
    'utf8',
  )

  test('links every family the stylesheet asks for first', () => {
    // The two are a pair: a family renamed in the stylesheet and not in the
    // link falls back silently, and looks merely a bit wrong rather than
    // broken. Reading the first-named family out of each custom property is
    // enough to catch that.
    const families = [...css.matchAll(/--(?:display|sans):\s*"([^"]+)"/g)].map((m) => m[1] ?? '')
    expect(families.length).toBe(2)
    for (const family of families) expect([family, layout.includes(family)]).toEqual([family, true])
  })

  test('names a fallback for each, so a blocked request still reads', () => {
    // The fonts come off a third party. A site behind a filter that cannot
    // reach it should land on a system serif and sans, not on a default.
    for (const property of ['--display', '--sans']) {
      const declaration = new RegExp(`${property}:([^;]+);`).exec(css)?.[1] ?? ''
      expect([property, declaration.split(',').length > 2]).toEqual([property, true])
      expect([property, /serif/.test(declaration)]).toEqual([property, true])
    }
  })
})
