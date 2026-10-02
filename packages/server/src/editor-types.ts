/**
 * The declarations the backoffice's view editor loads into monaco, so a view is
 * checked in the editor against the same types `tsc` checks it against on disk.
 *
 * Nothing here is generated from the types: `@bunbraco/render` ships its own
 * sources, and those sources are what `bunbraco` re-exports to a view, so they
 * are served as they are and cannot drift. The one generated file is the
 * schema's `content-types.d.ts`, read fresh on every request so a document type
 * added a minute ago is already in the editor.
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { intendedTypes } from './models-builder.ts'

/** A file in the editor's virtual file system. `path` is a URL, not a disk path. */
export interface EditorTypeLib {
  path: string
  content: string
}

/**
 * Where `import … from 'bunbraco'` lands, by TypeScript's own directory-index
 * lookup: no import map and no `paths` entry, because the editor's compiler
 * options have neither a base URL nor a working directory to resolve against.
 */
const MODULE_DIR = 'file:///node_modules/bunbraco'

/**
 * The generated types, at the depth they sit on disk. A view is opened under
 * `Views/`, so `../schema/content-types.d.ts` resolves in the editor exactly as
 * it does in the site.
 */
export const EDITOR_CONTENT_TYPES = 'file:///schema/content-types.d.ts'

let cached: Promise<EditorTypeLib[]> | undefined

/** `@bunbraco/render`'s sources, read from the installed package. */
function moduleLibs(): Promise<EditorTypeLib[]> {
  cached ??= (async () => {
    const dir = dirname(fileURLToPath(import.meta.resolve('@bunbraco/render')))
    const names = (await readdir(dir)).filter((name) => name.endsWith('.ts')).sort()
    return await Promise.all(
      names.map(async (name) => ({
        path: `${MODULE_DIR}/${name}`,
        content: await readFile(join(dir, name), 'utf8'),
      })),
    )
  })()
  return cached
}

export async function editorTypeLibs(options: { schemaDir: string }): Promise<EditorTypeLib[]> {
  const libs = [...(await moduleLibs())]
  const intended = intendedTypes(options.schemaDir)
  // Left out rather than stubbed when the schema does not generate: a view that
  // imports it then says the file is missing, which is true, instead of being
  // checked against types that silently have nothing in them.
  if ('types' in intended) libs.push({ path: EDITOR_CONTENT_TYPES, content: intended.types })
  return libs
}
