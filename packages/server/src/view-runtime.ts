/**
 * Proving a directory can import a view, before one has to.
 *
 * JSX compiles to an import of `bunbraco/jsx-runtime`, which resolves by walking
 * up from the file that needs it. So a views directory — or a snapshot of one —
 * outside the site's own tree cannot load at all:
 *
 *   Cannot find package 'bunbraco' imported from /mnt/views/homePage.tsx
 *
 * Checked at boot because the alternative is every render failing with a message
 * that names the runtime rather than the configuration that moved it.
 */
import { mkdirSync } from 'node:fs'

export const JSX_RUNTIME = 'bunbraco/jsx-runtime'

export class ViewRuntimeUnreachableError extends Error {
  constructor(
    readonly dir: string,
    readonly reason: string,
  ) {
    super(
      `Views cannot be imported from ${dir}: '${JSX_RUNTIME}' does not resolve from there (${reason}).\n` +
        '  JSX compiles to an import of it, resolved by walking up from the file, so the directory\n' +
        '  has to sit inside a tree whose node_modules carries bunbraco. Move it under the site, or\n' +
        '  set BUNBRACO_COMPONENTS_CACHE_DIR to somewhere that is.',
    )
  }
}

/** Throws unless a `.tsx` placed in `dir` could resolve the JSX runtime. */
export function assertViewRuntime(dir: string): void {
  mkdirSync(dir, { recursive: true })
  try {
    Bun.resolveSync(JSX_RUNTIME, dir)
  } catch (error) {
    throw new ViewRuntimeUnreachableError(
      dir,
      error instanceof Error ? error.message : String(error),
    )
  }
}
