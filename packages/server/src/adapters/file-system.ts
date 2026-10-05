/**
 * A file-system area on disk — components, stylesheets or scripts — as the
 * Management API sees it: paths relative to the area's root, which never
 * escape it, and only files of the area's extension.
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileEntry, FileResult, FileSystemPort } from '@bunbraco/api-management'

export interface FileAreaOptions {
  /** The extension files are stored with, e.g. `.css`. */
  extension: string
  /** Extensions a name may arrive with that are stored as `extension` instead. */
  rewrites?: readonly string[]
}

const INVALID_CHARACTERS = /[<>:"|?*\\/]/

/** A name no file system objects to: no path characters and no control characters. */
const invalidName = (name: string) =>
  INVALID_CHARACTERS.test(name) || [...name].some((c) => (c.codePointAt(0) ?? 0) < 0x20)

/** A path's segments, or undefined when it is not a plain path below the root. */
function segmentsOf(path: string | null): string[] | undefined {
  if (path === null) return []
  const trimmed = path.replace(/^\/+|\/+$/g, '')
  if (trimmed === '') return []
  const segments = trimmed.split('/')
  return segments.every((s) => s !== '' && s !== '.' && s !== '..' && !s.includes('\\'))
    ? segments
    : undefined
}

const toPath = (segments: readonly string[]) => `/${segments.join('/')}`

export function createFileSystemPort(root: string, options: FileAreaOptions): FileSystemPort {
  const extension = options.extension.toLowerCase()
  const locate = (path: string | null) => {
    const segments = segmentsOf(path)
    return segments ? { segments, file: join(root, ...segments) } : undefined
  }
  const kindOf = async (file: string): Promise<'file' | 'folder' | undefined> => {
    try {
      const info = await stat(file)
      return info.isDirectory() ? 'folder' : info.isFile() ? 'file' : undefined
    } catch {
      return undefined
    }
  }
  const visible = (name: string, isFolder: boolean) =>
    !name.startsWith('.') && (isFolder || name.toLowerCase().endsWith(extension))

  /** The name as stored: with the area's extension, whichever accepted one it came with. */
  const fileName = (name: string): string | 'InvalidName' | 'InvalidFileExtension' => {
    const trimmed = name.trim()
    if (!trimmed || trimmed.startsWith('.') || invalidName(trimmed)) return 'InvalidName'
    const lower = trimmed.toLowerCase()
    if (lower.endsWith(extension)) return trimmed
    const rewrite = options.rewrites?.find((r) => lower.endsWith(r.toLowerCase()))
    if (rewrite) return `${trimmed.slice(0, -rewrite.length)}${options.extension}`
    return 'InvalidFileExtension'
  }

  const entryAt = async (segments: string[]): Promise<FileEntry | undefined> => {
    const file = join(root, ...segments)
    const kind = await kindOf(file)
    const name = segments[segments.length - 1]
    if (!kind || !name || !visible(name, kind === 'folder')) return undefined
    const parent = segments.slice(0, -1)
    return {
      path: toPath(segments),
      name,
      parentPath: parent.length > 0 ? toPath(parent) : null,
      isFolder: kind === 'folder',
      hasChildren:
        kind === 'folder' &&
        (await readdir(file, { withFileTypes: true })).some((d) =>
          visible(d.name, d.isDirectory()),
        ),
    }
  }

  const parentFolder = async (parentPath: string | null) => {
    const parent = locate(parentPath)
    if (!parent) return undefined
    if (parent.segments.length === 0) {
      await mkdir(root, { recursive: true })
      return parent
    }
    return (await kindOf(parent.file)) === 'folder' ? parent : undefined
  }

  return {
    async children(parentPath) {
      const parent = locate(parentPath)
      if (!parent) return undefined
      if (parent.segments.length === 0 && !existsSync(root)) return []
      if ((await kindOf(parent.file)) !== 'folder') return undefined
      const entries: FileEntry[] = []
      for (const dirent of await readdir(parent.file, { withFileTypes: true })) {
        const entry = await entryAt([...parent.segments, dirent.name])
        if (entry) entries.push(entry)
      }
      return entries.sort(
        (a, b) =>
          Number(b.isFolder) - Number(a.isFolder) ||
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      )
    },

    async entry(path) {
      const found = locate(path)
      return found && found.segments.length > 0 ? entryAt(found.segments) : undefined
    },

    async read(path) {
      const found = locate(path)
      if (!found || found.segments.length === 0) return undefined
      const entry = await entryAt(found.segments)
      if (!entry || entry.isFolder) return undefined
      return {
        path: entry.path,
        name: entry.name,
        parentPath: entry.parentPath,
        content: await readFile(found.file, 'utf8'),
      }
    },

    async create(parentPath, name, content): Promise<FileResult> {
      const stored = fileName(name)
      if (stored === 'InvalidName' || stored === 'InvalidFileExtension')
        return { ok: false, status: stored }
      const parent = await parentFolder(parentPath)
      if (!parent) return { ok: false, status: 'ParentNotFound' }
      const segments = [...parent.segments, stored]
      const file = join(root, ...segments)
      if (existsSync(file)) return { ok: false, status: 'AlreadyExists' }
      await writeFile(file, content, 'utf8')
      return { ok: true, path: toPath(segments) }
    },

    async update(path, content): Promise<FileResult> {
      const found = locate(path)
      const entry = found && found.segments.length > 0 ? await entryAt(found.segments) : undefined
      if (!found || !entry || entry.isFolder) return { ok: false, status: 'NotFound' }
      await writeFile(found.file, content, 'utf8')
      return { ok: true, path: entry.path }
    },

    async rename(path, name): Promise<FileResult> {
      const found = locate(path)
      const entry = found && found.segments.length > 0 ? await entryAt(found.segments) : undefined
      if (!found || !entry || entry.isFolder) return { ok: false, status: 'NotFound' }
      const stored = fileName(name)
      if (stored === 'InvalidName' || stored === 'InvalidFileExtension')
        return { ok: false, status: stored }
      const segments = [...found.segments.slice(0, -1), stored]
      const target = join(root, ...segments)
      if (target !== found.file && existsSync(target)) return { ok: false, status: 'AlreadyExists' }
      await rename(found.file, target)
      return { ok: true, path: toPath(segments) }
    },

    async delete(path): Promise<FileResult> {
      const found = locate(path)
      const entry = found && found.segments.length > 0 ? await entryAt(found.segments) : undefined
      if (!found || !entry || entry.isFolder) return { ok: false, status: 'NotFound' }
      await rm(found.file)
      return { ok: true, path: entry.path }
    },

    async createFolder(parentPath, name): Promise<FileResult> {
      const trimmed = name.trim()
      if (!trimmed || trimmed.startsWith('.') || invalidName(trimmed))
        return { ok: false, status: 'InvalidName' }
      const parent = await parentFolder(parentPath)
      if (!parent) return { ok: false, status: 'ParentNotFound' }
      const segments = [...parent.segments, trimmed]
      const folder = join(root, ...segments)
      if (existsSync(folder)) return { ok: false, status: 'AlreadyExists' }
      await mkdir(folder)
      return { ok: true, path: toPath(segments) }
    },

    async deleteFolder(path): Promise<FileResult> {
      const found = locate(path)
      const entry = found && found.segments.length > 0 ? await entryAt(found.segments) : undefined
      if (!found || !entry?.isFolder) return { ok: false, status: 'NotFound' }
      if ((await readdir(found.file)).length > 0) return { ok: false, status: 'NotEmpty' }
      await rmdir(found.file)
      return { ok: true, path: entry.path }
    },
  }
}
