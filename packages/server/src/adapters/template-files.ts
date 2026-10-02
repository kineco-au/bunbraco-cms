/**
 * Template views on disk.
 *
 * Umbraco keeps templates at ~/Views/{alias}.cshtml and treats the file as the
 * source of truth for its content; we do the same with .tsx.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TemplateFileStore } from '@bunbraco/data'

/** Aliases become filenames, so they must not be able to escape the directory. */
function safeAlias(alias: string): string | undefined {
  return /^[A-Za-z0-9_-]+$/.test(alias) ? alias : undefined
}

/**
 * `onChange` fires after a template is written or removed, with the alias.
 *
 * A view is code: the node that wrote it has to take a new snapshot before it
 * renders again, and the others have to be told to look. This is the only place
 * that knows a view changed.
 */
export function createTemplateFileStore(
  dir: string,
  onChange?: (alias: string) => void | Promise<void>,
): TemplateFileStore {
  const fileFor = (alias: string): string | undefined => {
    const safe = safeAlias(alias)
    return safe ? join(dir, `${safe}.tsx`) : undefined
  }

  return {
    async read(alias) {
      const file = fileFor(alias)
      if (!file) return undefined
      try {
        return await readFile(file, 'utf8')
      } catch {
        return undefined
      }
    },
    async write(alias, content) {
      const file = fileFor(alias)
      if (!file) throw new Error(`Unsafe template alias '${alias}'.`)
      await mkdir(dir, { recursive: true })
      await writeFile(file, content, 'utf8')
      // Awaited, so a saved template is already the one this node renders by the
      // time the editor's request comes back.
      await onChange?.(alias)
    },
    async remove(alias) {
      const file = fileFor(alias)
      if (!file) return
      await rm(file, { force: true })
      await onChange?.(alias)
    },
  }
}
