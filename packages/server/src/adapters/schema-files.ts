/**
 * The backoffice writes schema files. A document-type save lands in the
 * database as before and, when the directory is writable, in
 * `schema/document-types/<alias>.toml` — the file the next boot will sync.
 * docs/09-schema-as-code.md, "The backoffice writes files".
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { PortFailure } from '@bunbraco/api-management'
import type { ContentTypeAggregate, DataTypeModel } from '@bunbraco/core'
import { currentSchemaState, type Db, updateSchemaStateHash } from '@bunbraco/data'
import {
  type ChangeClass,
  exportSchemaSet,
  fileNameFor,
  hashSchemaSet,
  loadSchemaDirectory,
  nextSchemaVersion,
  type SchemaTypeKind,
  TYPE_KIND_FILES,
  validateSchemaSet,
  writeDataType,
  writeDocumentType,
  writeLanguages,
  writeSchemaFiles,
  writeSchemaVersion,
} from '@bunbraco/schema'
import { logger } from '../logging.ts'

export interface SchemaFiles {
  schemaDir: string
  writable: boolean
  templateAliases(): ReadonlySet<string>
  /**
   * Called after any write, so a shared schema store outlives this container.
   * Absent when the schema is a directory on disk, which needs no publishing.
   */
  onChanged?(): Promise<void>
}

export interface SchemaFileWriter {
  /** A read-only directory refuses the save before the database changes. */
  refuse(aggregate: { alias: string }): PortFailure | undefined
  /**
   * Moves the site's schema version on by what the change costs the content,
   * before the database is written and while the two can still be compared.
   * `breaking` is a major: getting there converted data.
   */
  bumpVersion(classification: ChangeClass): Promise<void>
  /** Writes the saved type canonically; an alias change removes the old file. */
  write(aggregate: ContentTypeAggregate, previousAlias?: string): Promise<void>
  remove(alias: string): Promise<void>
  writeDataType(model: DataTypeModel): Promise<void>
  removeDataType(alias: string): Promise<void>
  writeLanguages(): Promise<void>
  /** After a move or a folder change: every file, from the database, canonically. */
  rewriteAll(): Promise<void>
}

/**
 * A writer for one kind of content type: document types (the default) write
 * `schema/document-types/`, media types `schema/media-types/`. Data types,
 * languages and the rewrite are the same whichever kind asks.
 */
export function createSchemaFileWriter(
  db: Db,
  files: SchemaFiles,
  kind: SchemaTypeKind = 'document',
): SchemaFileWriter {
  const dir = join(files.schemaDir, TYPE_KIND_FILES[kind].dir)
  const fileFor = (alias: string) => join(dir, fileNameFor(alias))
  const plural = { document: 'Document types', media: 'Media types', member: 'Member types' }[kind]
  const managed = () => existsSync(files.schemaDir)

  /**
   * The database already matches the files; record their hash so the next sync is
   * a no-op, then hand the files to wherever they durably live.
   */
  const settle = async () => {
    const state = await currentSchemaState(db)
    await updateSchemaStateHash(
      db,
      state.id,
      hashSchemaSet(loadSchemaDirectory(files.schemaDir).set),
    )
    await files.onChanged?.()
  }

  return {
    refuse(aggregate) {
      if (!managed() || files.writable) return undefined
      const shown = relative(process.cwd(), fileFor(aggregate.alias))
      return {
        ok: false,
        status: 409,
        reason: `${plural} are defined in schema/ and this environment is read-only; change ${shown} in source control.`,
      }
    },

    async bumpVersion(classification) {
      if (!managed() || !files.writable || classification === 'none') return
      const loaded = loadSchemaDirectory(files.schemaDir)
      const next = nextSchemaVersion(loaded.set.version, classification)
      if (next === loaded.set.version) return
      writeFileSync(join(files.schemaDir, 'schema.toml'), writeSchemaVersion(next))
      logger('schema').info('Schema version {from} → {to} ({classification})', {
        from: loaded.set.version,
        to: next,
        classification,
      })
    },

    async write(aggregate, previousAlias) {
      if (!managed() || !files.writable) return
      const set = await exportSchemaSet(db, loadSchemaDirectory(files.schemaDir).set.version)
      const list =
        kind === 'document'
          ? set.documentTypes
          : kind === 'media'
            ? (set.mediaTypes ?? [])
            : (set.memberTypes ?? [])
      const type = list.find((t) => t.key === aggregate.key)
      if (!type) return
      const problems = validateSchemaSet(set, { templateAliases: files.templateAliases() })
      if (problems.length > 0) {
        const detail = problems.map((p) => `${p.file}: ${p.message}`).join('; ')
        logger('schema').error('Not writing {file}: {detail}', {
          file: fileNameFor(aggregate.alias),
          detail,
        })
        return
      }
      mkdirSync(dir, { recursive: true })
      if (previousAlias && previousAlias !== aggregate.alias)
        rmSync(fileFor(previousAlias), { force: true })
      writeFileSync(fileFor(aggregate.alias), writeDocumentType(type, kind))
      await settle()
    },

    async remove(alias) {
      if (!managed() || !files.writable) return
      rmSync(fileFor(alias), { force: true })
      await settle()
    },

    async writeDataType(model) {
      if (!managed() || !files.writable || !model.alias) return
      const set = await exportSchemaSet(db, loadSchemaDirectory(files.schemaDir).set.version)
      const dataType = set.dataTypes.find((d) => d.key === model.key)
      // An unchanged built-in has no file; a changed one does.
      if (!dataType) {
        rmSync(join(files.schemaDir, 'data-types', fileNameFor(model.alias)), { force: true })
        await settle()
        return
      }
      // The same guard `write` applies to a document type: a set that does not
      // validate never reaches the disk, because the file is what every other
      // node reads and what a deploy boots from.
      const problems = validateSchemaSet(set, { templateAliases: files.templateAliases() })
      if (problems.length > 0) {
        const detail = problems.map((p) => `${p.file}: ${p.message}`).join('; ')
        logger('schema').error('Not writing {file}: {detail}', {
          file: fileNameFor(model.alias),
          detail,
        })
        return
      }
      mkdirSync(join(files.schemaDir, 'data-types'), { recursive: true })
      writeFileSync(
        join(files.schemaDir, 'data-types', fileNameFor(model.alias)),
        writeDataType(dataType),
      )
      await settle()
    },

    async removeDataType(alias) {
      if (!managed() || !files.writable) return
      rmSync(join(files.schemaDir, 'data-types', fileNameFor(alias)), { force: true })
      await settle()
    },

    async writeLanguages() {
      if (!managed() || !files.writable) return
      const set = await exportSchemaSet(db, loadSchemaDirectory(files.schemaDir).set.version)
      writeFileSync(join(files.schemaDir, 'languages.toml'), writeLanguages(set.languages))
      await settle()
    },

    async rewriteAll() {
      if (!managed() || !files.writable) return
      const loaded = loadSchemaDirectory(files.schemaDir)
      const set = await exportSchemaSet(db, loaded.set.version)
      const problems = validateSchemaSet(set, { templateAliases: files.templateAliases() })
      if (problems.length > 0) {
        const detail = problems.map((p) => `${p.file}: ${p.message}`).join('; ')
        logger('schema').error('Not rewriting the schema files: {detail}', { detail })
        return
      }
      writeSchemaFiles(files.schemaDir, set)
      await settle()
    },
  }
}
