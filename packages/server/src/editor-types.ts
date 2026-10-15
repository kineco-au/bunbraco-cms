/**
 * The declarations the backoffice's view editor loads into monaco, so a view is
 * checked in the editor against the same types `tsc` checks it against on disk.
 *
 * Nothing here is generated from the types: `@crombolo/render` ships its own
 * sources, and those sources are what `@crombolo/crombolo` re-exports to a view, so they
 * are served as they are and cannot drift — with React's DOM types and the CSS
 * types under them, which the sources import for each tag's attributes. The one
 * generated file is the schema's `content-types.d.ts`, read fresh on every
 * request so a content type added a minute ago is already in the editor.
 */

import { existsSync, readFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FormTypes } from '@crombolo/core'
import { intendedTypes } from './models-builder.ts'

/** A file in the editor's virtual file system. `path` is a URL, not a disk path. */
export interface EditorTypeLib {
  path: string
  content: string
}

/**
 * Where `import … from '@crombolo/crombolo'` lands, by TypeScript's own directory-index
 * lookup: no import map and no `paths` entry, because the editor's compiler
 * options have neither a base URL nor a working directory to resolve against.
 */
const MODULE_DIR = 'file:///node_modules/@crombolo/crombolo'

/**
 * The generated types, at the depth they sit on disk. A view is opened under
 * `components/`, so `../schema/content-types.d.ts` resolves in the editor exactly as
 * it does in the site.
 */
export const EDITOR_CONTENT_TYPES = 'file:///schema/content-types.d.ts'

/** Where the render sources' `import type … from 'react'` lands, by TypeScript's `@types` lookup. */
const REACT_TYPES_DIR = 'file:///node_modules/@types/react'
/** Where React's own `import … from 'csstype'` lands. */
const CSSTYPE_DIR = 'file:///node_modules/csstype'

/** The JSX modes a site may choose, by the `jsxImportSource` that selects each. */
export const JSX_IMPORT_SOURCES = ['@crombolo/crombolo', '@crombolo/crombolo/loose'] as const
export type JsxImportSource = (typeof JSX_IMPORT_SOURCES)[number]

let cached: Promise<EditorTypeLib[]> | undefined

/** `@crombolo/render`'s sources, read from the installed package, and the type packages they import. */
function moduleLibs(): Promise<EditorTypeLib[]> {
  cached ??= (async () => {
    const dir = dirname(fileURLToPath(import.meta.resolve('@crombolo/render')))
    const sources = async (folder: string) =>
      Promise.all(
        (await readdir(join(dir, folder)))
          .filter((name) => name.endsWith('.ts'))
          .sort()
          .map(async (name) => ({
            path: `${MODULE_DIR}/${folder ? `${folder}/` : ''}${name}`,
            content: await readFile(join(dir, folder, name), 'utf8'),
          })),
      )
    // Resolved from the render package, as its own `import type` resolves them.
    const reactDir = dirname(
      createRequire(join(dir, 'index.ts')).resolve('@types/react/package.json'),
    )
    const cssDir = dirname(
      createRequire(join(reactDir, 'index.d.ts')).resolve('csstype/package.json'),
    )
    const declaration = async (from: string, name: string, to: string) => ({
      path: `${to}/${name}`,
      content: await readFile(join(from, name), 'utf8'),
    })
    return [
      ...(await sources('')),
      ...(await sources('loose')),
      await declaration(reactDir, 'index.d.ts', REACT_TYPES_DIR),
      await declaration(reactDir, 'global.d.ts', REACT_TYPES_DIR),
      await declaration(cssDir, 'index.d.ts', CSSTYPE_DIR),
    ]
  })()
  return cached
}

/**
 * The JSX mode the site's `tsconfig.json` chooses, so the editor checks a view
 * as `tsc` would. Read leniently, since a tsconfig may carry comments; anything
 * other than a mode this package serves is the default.
 */
export function siteJsxImportSource(siteDir: string): JsxImportSource {
  const file = join(siteDir, 'tsconfig.json')
  if (!existsSync(file)) return '@crombolo/crombolo'
  const found = /"jsxImportSource"\s*:\s*"([^"]+)"/.exec(readFileSync(file, 'utf8'))?.[1]
  return (JSX_IMPORT_SOURCES as readonly string[]).includes(found ?? '')
    ? (found as JsxImportSource)
    : '@crombolo/crombolo'
}

export async function editorTypeLibs(options: {
  schemaDir: string
  formTypes?: FormTypes
}): Promise<EditorTypeLib[]> {
  const libs = [...(await moduleLibs())]
  const intended = intendedTypes(options.schemaDir, options.formTypes)
  // Left out rather than stubbed when the schema does not generate: a view that
  // imports it then says the file is missing, which is true, instead of being
  // checked against types that silently have nothing in them.
  if ('types' in intended) libs.push({ path: EDITOR_CONTENT_TYPES, content: intended.types })
  return libs
}
