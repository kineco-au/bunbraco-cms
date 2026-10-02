/**
 * File-system areas of the Settings section — partial views, stylesheets and
 * scripts — where the files on disk are the entities and their paths
 * (`/folder/site.css`, relative to the area's root) are their ids.
 */

export interface FileEntry {
  path: string
  name: string
  parentPath: string | null
  isFolder: boolean
  hasChildren: boolean
}

export interface FileContent {
  path: string
  name: string
  parentPath: string | null
  content: string
}

/** Umbraco's file-system operation statuses. */
export type FileStatus =
  | 'AlreadyExists'
  | 'NotFound'
  | 'ParentNotFound'
  | 'InvalidName'
  | 'InvalidFileExtension'
  | 'NotEmpty'

export type FileResult = { ok: true; path: string } | { ok: false; status: FileStatus }

export interface FileSystemPort {
  /** Folders then files, each by name; the root when `parentPath` is null. */
  children(parentPath: string | null): Promise<FileEntry[] | undefined>
  entry(path: string): Promise<FileEntry | undefined>
  read(path: string): Promise<FileContent | undefined>
  create(parentPath: string | null, name: string, content: string): Promise<FileResult>
  update(path: string, content: string): Promise<FileResult>
  rename(path: string, name: string): Promise<FileResult>
  delete(path: string): Promise<FileResult>
  createFolder(parentPath: string | null, name: string): Promise<FileResult>
  deleteFolder(path: string): Promise<FileResult>
}

/** A partial view snippet the "create from snippet" dialog offers. */
export interface Snippet {
  id: string
  name: string
  content: string
}
