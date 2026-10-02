/**
 * The TSX dialect in the backoffice's view editor: the declarations the server
 * hands monaco, and the editor configuration that makes a view type-check
 * against them.
 *
 * The configuration itself is browser code, so what is held to here is the
 * server's half in full and the editor's half at the source level — the same way
 * `security.test.ts` guards the login page. What it actually looks like in a
 * browser is `tests/browser/settings.browser.ts`.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_BACKOFFICE_PATH } from '@bunbraco/core'
import { EDITOR_CONTENT_TYPES, editorTypeLibs } from '@bunbraco/server'
import { type Harness, signedInServer } from './support/harness.ts'

const EDITOR_TYPES = `${DEFAULT_BACKOFFICE_PATH}/bunbraco/api/editor-types`

interface Lib {
  path: string
  content: string
}

const dirs: string[] = []
const open: Harness[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const HOME = `[document-type]
alias = "homePage"
name = "Home Page"
allow-at-root = true

[[property]]
alias = "title"
name = "Title"
type = "textstring"
`

/** A schema that generates, so the generated types are part of the answer. */
function schemaFiles(): string {
  const schemaDir = mkdtempSync(join(process.cwd(), 'output', 'editor-types-'))
  dirs.push(schemaDir)
  mkdirSync(join(schemaDir, 'document-types'), { recursive: true })
  writeFileSync(join(schemaDir, 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(schemaDir, 'document-types', 'home-page.toml'), HOME)
  return schemaDir
}

async function site() {
  const schemaDir = schemaFiles()
  const h = await signedInServer({ config: { schemaDir } })
  open.push(h)
  return { h, schemaDir }
}

const source = (file: string) => Bun.file(`packages/backoffice-host/${file}`).text()

/**
 * Lays the served declarations out as the editor's virtual file system does, and
 * type-checks `view` in it with the repo's own compiler.
 *
 * Run through bun rather than the `tsc` shim, which wants a node on the PATH
 * that the test image does not have.
 */
async function typecheck(view: string): Promise<string[]> {
  const root = mkdtempSync(join(process.cwd(), 'output', 'editor-tsc-'))
  dirs.push(root)
  const libs = await editorTypeLibs({ schemaDir: schemaFiles() })
  for (const lib of libs) await Bun.write(join(root, lib.path.replace('file:///', '')), lib.content)
  await Bun.write(join(root, 'Views', 'view.tsx'), view)
  await Bun.write(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        jsxImportSource: 'bunbraco',
        allowImportingTsExtensions: true,
        noEmit: true,
        strict: true,
        lib: ['ESNext', 'DOM'],
      },
      include: ['Views/**/*'],
    }),
  )
  const tsc = Bun.spawn(['bun', 'node_modules/typescript/bin/tsc', '-p', root], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = `${await new Response(tsc.stdout).text()}${await new Response(tsc.stderr).text()}`
  await tsc.exited
  // Only what is wrong with the view. `node:fs` and friends are unresolved
  // inside the served sources, which in the editor are libraries whose
  // diagnostics are never shown against the file being edited.
  return out
    .split('\n')
    .filter((line) => line.includes('Views/view.tsx'))
    .map((line) => line.slice(line.indexOf('Views/view.tsx')))
}

describe('the declarations the view editor checks a view against', () => {
  test('are the module a view imports, and the schema it was written for', async () => {
    const { h } = await site()
    const { libs } = await h.json<{ libs: Lib[] }>(EDITOR_TYPES)
    const at = (path: string) => libs.find((lib) => lib.path === path)

    // Where `import type { PageProps } from 'bunbraco'` lands, by TypeScript's
    // own directory-index lookup.
    expect(at('file:///node_modules/bunbraco/index.ts')?.content).toContain(
      "export * from './model.ts'",
    )
    expect(at('file:///node_modules/bunbraco/model.ts')?.content).toContain(
      'export interface PageProps',
    )
    expect(at('file:///node_modules/bunbraco/jsx-runtime.ts')?.content).toContain('namespace JSX')

    // The generated types, at the depth a view reaches them by `../schema/`.
    expect(EDITOR_CONTENT_TYPES).toBe('file:///schema/content-types.d.ts')
    expect(at(EDITOR_CONTENT_TYPES)?.content).toContain('export interface HomePage')
    expect(at(EDITOR_CONTENT_TYPES)?.content).toContain('"title"')

    // Virtual paths throughout: a disk path would name this machine's checkout
    // and resolve to nothing in the editor.
    for (const lib of libs) expect(lib.path.startsWith('file:///')).toBe(true)
  })

  test('cover every module of the package, so a new one cannot go missing', async () => {
    const { h } = await site()
    const { libs } = await h.json<{ libs: Lib[] }>(EDITOR_TYPES)
    const served = libs
      .filter((lib) => lib.path.startsWith('file:///node_modules/bunbraco/'))
      .map((lib) => lib.path.split('/').pop())
      .sort()

    const dir = dirname(fileURLToPath(import.meta.resolve('@bunbraco/render')))
    const onDisk = (await readdir(dir)).filter((name) => name.endsWith('.ts')).sort()

    expect(served).toEqual(onDisk)
    expect(onDisk).toContain('model.ts')
  })

  test('leave the generated types out when the schema does not generate', async () => {
    // Left out rather than empty: a view that imports them then says the file is
    // missing, instead of being checked against types with nothing in them.
    const libs = await editorTypeLibs({
      schemaDir: join(process.cwd(), 'output', 'no-schema-here'),
    })
    expect(libs.some((lib) => lib.path === EDITOR_CONTENT_TYPES)).toBe(false)
    expect(libs.some((lib) => lib.path.endsWith('/model.ts'))).toBe(true)
  })

  test('need a session, and only answer a GET', async () => {
    const { h } = await site()
    const anonymous = await h.server.fetch(new Request(`http://localhost${EDITOR_TYPES}`))
    expect(anonymous.status).toBe(401)

    const posted = await h.call(EDITOR_TYPES, { method: 'POST' })
    expect(posted.status).toBe(405)
  })
})

describe('the editor configuration', () => {
  test('is the typescript service on a .tsx file, not a language of its own', async () => {
    const editors = await source('plugin/tsx-editors.js')

    // The file name is what decides whether TypeScript will read JSX at all.
    expect(editors).toMatch(/monaco\.Uri\.parse\(`\$\{VIEWS}\/view-\$\{\+\+opened}\.tsx`\)/)
    expect(editors).toContain("const VIEWS = 'file:///Views'")
    // A `tsx` language would tokenise and then be ignored by the worker every
    // completion comes from, so the mode stays monaco's own.
    expect(editors).not.toMatch(/setMonarchTokensProvider|languages\.register\(/)
    expect(editors).toMatch(/createModel\(\s*created\.getValue\(\),\s*'typescript',/)
  })

  test('mirrors the site tsconfig, so the editor and the typechecker agree', async () => {
    const editors = await source('plugin/tsx-editors.js')
    const tsconfig = (await Bun.file('apps/site/tsconfig.json').json()).compilerOptions

    expect(tsconfig.jsx).toBe('react-jsx')
    expect(editors).toContain('jsx: JsxEmit.ReactJSX')
    expect(tsconfig.jsxImportSource).toBe('bunbraco')
    expect(editors).toContain("jsxImportSource: 'bunbraco'")
    expect(tsconfig.strict).toBe(true)
    expect(editors).toContain('strict: true')
    expect(tsconfig.allowImportingTsExtensions).toBe(true)
    expect(editors).toContain('allowImportingTsExtensions: true')
    // `bundler`, by its number: monaco's editor-side enum predates the option.
    expect(tsconfig.moduleResolution).toBe('bundler')
    expect(editors).toContain('moduleResolution: BUNDLER')
    expect(editors).toContain('const BUNDLER = 100')
  })

  test('is enough to check a view, according to the compiler the repo uses', async () => {
    // The endpoint and the options are only worth having if a view built from
    // them type-checks, so this lays the declarations out the way the editor
    // does and asks `tsc`. It covers what nothing else can: that a bare
    // `bunbraco` resolves to the served module, that `jsxImportSource` reaches
    // the JSX namespace so a tag is legal at all, and that `Views/` is the right
    // depth for the generated types.
    expect(
      await typecheck(`import type { PageProps } from 'bunbraco'
import type { HomePage } from '../schema/content-types'

export default function Template({ model }: PageProps) {
  const title: HomePage['title'] = model.text('title')
  return (
    <div>
      <h1>{title}</h1>
    </div>
  )
}
`),
    ).toEqual([])
  })

  test('and reports a real mistake, rather than passing everything', async () => {
    const errors = await typecheck(`import type { PageProps } from 'bunbraco'

export default function Template({ model }: PageProps) {
  return <h1>{model.nosuchthing()}</h1>
}
`)
    expect(errors.join('\n')).toContain("Property 'nosuchthing' does not exist")
  })

  test('reads Umbraco’s hard-coded Razor as the dialect a view is in', async () => {
    const editors = await source('plugin/tsx-editors.js')
    // Umbraco's template and partial view editors both say `language="razor"`,
    // and the attribute is not ours to change.
    expect(editors).toContain("value === TSX || value === 'razor'")
    expect(editors).toContain("export const TSX = 'tsx'")
    // And if the property it wraps ever moves, that costs the dialect rather
    // than this entry point, which also carries the TSX scaffolds.
    expect(editors).toContain('if (!language?.set) return')

    // And the assistant asks for the dialect by name.
    const drawer = await source('plugin/assistant/drawer.js')
    expect(drawer).toContain("template: 'tsx'")
    expect(drawer).toContain("'template-create': 'tsx'")
    expect(drawer).not.toContain("template: 'typescript'")
  })

  test('reaches the TypeScript service where this monaco actually keeps it', async () => {
    // The one thing a source-level guard cannot know, and the one that went
    // wrong: the vendored bundle exports each language service as a top-level
    // namespace (`monaco.typescript`), not under `languages`. Configured against
    // the wrong one, the service is never set up and a view is shown as a page
    // of syntax errors — so the bundle is asked here instead of assumed.
    const bundle = await Bun.file(
      'packages/backoffice-dist/dist/external/monaco-editor/index.js',
    ).text()
    // `typescript` sits in the export map wherever upstream's key order puts it:
    // anchoring on `{` alone broke on the release that added an `lsp` namespace
    // in front of it, which is a rename of nothing and must not fail a test.
    const namespace = /[{,]\s*typescript:\s*\(\)\s*=>\s*(\w+)/.exec(bundle)
    expect(namespace).not.toBeNull()
    // And the names the configuration destructures off it. The declaration is
    // searched for rather than sliced at a guessed offset: an anchor that is not
    // found otherwise reads the end of the file, and every name below then fails
    // for a reason that has nothing to do with the names.
    const declaration = new RegExp(`\\b${namespace?.[1]}\\s*=\\s*\\{\\s*\\}`).exec(bundle)
    expect(declaration, `${namespace?.[1]} is not declared as a namespace object`).not.toBeNull()
    const exports = bundle.slice(declaration?.index ?? 0, (declaration?.index ?? 0) + 600)
    for (const name of ['typescriptDefaults', 'ScriptTarget', 'ModuleKind', 'JsxEmit']) {
      expect(exports).toContain(`${name}:`)
    }

    const editors = await source('plugin/tsx-editors.js')
    expect(editors).toContain('monaco.typescript ?? monaco.languages?.typescript')
  })

  test('says so in the console when it cannot configure the dialect', async () => {
    const editors = await source('plugin/tsx-editors.js')
    // The first failure was silent, which is why it reached a person rather than
    // a test: the browser suite fails on a console error, so this is what makes
    // the next one fail a test instead.
    expect(editors).toContain('console.error(')
    // And a view is left as plain text rather than as TypeScript that cannot
    // read JSX, which is what underlines every tag.
    expect(editors).toContain("setModelLanguage(created, 'plaintext')")
    // Types that do not arrive are the same trap by another route: nothing
    // resolves, so there is no `JSX.IntrinsicElements` and every tag reds out.
    // Checking is turned off instead, and the dialect itself still works.
    expect(editors).toContain('noSemanticValidation: libs.length === 0')
  })

  test('does not put monaco in the boot path', async () => {
    const editors = await source('plugin/tsx-editors.js')
    // Several megabytes, for a session that may never open a view: imported when
    // the first editor mounts, which is why this is a dynamic import.
    expect(editors).toContain("import('@umbraco-cms/backoffice/external/monaco-editor')")
    expect(editors).not.toMatch(/^import .*monaco-editor/m)
  })
})
