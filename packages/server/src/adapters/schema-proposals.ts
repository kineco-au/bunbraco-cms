/**
 * Schema proposals as the TOML files they become.
 *
 * A type is a file in `schema/`, and that file is what gets committed, so a
 * proposal holds the file rather than a request body full of keys. Applying one
 * writes it and imports it — the same path a commit or another node's publish
 * takes — instead of writing the database and deriving the file from it
 * afterwards, which is the wrong way round and is why an editor's change could
 * never be classified.
 *
 * Validation happens twice on purpose: when the proposal is made, so a reviewer
 * is never shown something that cannot be applied, and again at approval, because
 * the rest of the schema may have moved in between.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SchemaProposalPort } from '@bunbraco/assistant'
import type { Db } from '@bunbraco/data'
import {
  fileNameFor,
  loadSchemaDirectory,
  nextSchemaVersion,
  parseDataType,
  parseDocumentType,
  type SchemaProblem,
  TYPE_KIND_FILES,
  validateSchemaSet,
  writeDataType,
  writeDocumentType,
  writeSchemaVersion,
} from '@bunbraco/schema'
import type { BunbracoConfig } from '../config.ts'
import { logger } from '../logging.ts'
import { importSchema, templateAliasesIn } from '../schema.ts'

const log = logger('schema')

const isDataType = (kind: string) => kind.startsWith('data-type')

/** Where a kind's files live, relative to the schema directory. */
const directoryFor = (kind: string) =>
  isDataType(kind) ? 'data-types' : TYPE_KIND_FILES.document.dir

export interface SchemaProposalOptions {
  db: Db
  config: BunbracoConfig
  /** The node's identity and state, refreshed in place by an import. */
  boot: { nodeId: string; nodeState: { version: string; revision: string } }
}

export function createSchemaProposals(options: SchemaProposalOptions): SchemaProposalPort {
  const { config } = options
  const pathFor = (kind: string, alias: string) =>
    join(config.schemaDir, directoryFor(kind), fileNameFor(alias))

  /**
   * The proposal's file substituted into the schema as it stands, so a property
   * pointing at a data type that does not exist, or a composition that would
   * cycle, is a problem now rather than a surprise at approval.
   */
  const validate = async (kind: string, alias: string, toml: string): Promise<SchemaProblem[]> => {
    const file = `schema/${directoryFor(kind)}/${fileNameFor(alias)}`
    if (isDataType(kind)) {
      const parsed = parseDataType(file, toml)
      const dataType = parsed.value
      if (parsed.problems.length > 0 || !dataType) {
        return parsed.problems.length > 0
          ? parsed.problems
          : [{ file, path: '', message: 'the file defines no data type' }]
      }
      const set = loadSchemaDirectory(config.schemaDir).set
      const dataTypes = [
        ...set.dataTypes.filter((existing) => existing.alias !== dataType.alias),
        dataType,
      ]
      return validateSchemaSet({ ...set, dataTypes })
    }

    const parsed = parseDocumentType(file, toml)
    const documentType = parsed.value
    if (parsed.problems.length > 0 || !documentType) {
      return parsed.problems.length > 0
        ? parsed.problems
        : [{ file, path: '', message: 'the file defines no document type' }]
    }
    const set = loadSchemaDirectory(config.schemaDir).set
    const documentTypes = [
      ...set.documentTypes.filter((existing) => existing.alias !== documentType.alias),
      documentType,
    ]
    return validateSchemaSet(
      { ...set, documentTypes },
      { templateAliases: templateAliasesIn(config.viewsDir) },
    )
  }

  return {
    fileFor: (kind, alias) => `schema/${directoryFor(kind)}/${fileNameFor(alias)}`,

    async read(kind, alias) {
      const path = pathFor(kind, alias)
      if (!existsSync(path)) return undefined
      return await readFile(path, 'utf8')
    },

    validate,

    async apply(kind, alias, toml) {
      if (!config.schemaWritable) {
        return {
          ok: false,
          error:
            'Types are defined in schema/ and this environment is read-only; change the file in source control, or configure a schema store.',
        }
      }
      const problems = await validate(kind, alias, toml)
      if (problems.length > 0) {
        return { ok: false, error: problems.map((problem) => problem.message).join('; ') }
      }

      const path = pathFor(kind, alias)
      const versionFile = join(config.schemaDir, 'schema.toml')
      const previous = existsSync(path) ? await readFile(path, 'utf8') : undefined
      const previousVersion = existsSync(versionFile)
        ? await readFile(versionFile, 'utf8')
        : undefined
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, canonical(kind, alias, toml), 'utf8')

      const restore = async () => {
        if (previous === undefined) await rm(path, { force: true })
        else await writeFile(path, previous, 'utf8')
        if (previousVersion !== undefined) await writeFile(versionFile, previousVersion, 'utf8')
      }

      // Classified while the files and the database still differ: afterwards there
      // is nothing left to compare. The version moves in the same breath, or the
      // import lands at a version the other nodes already have and they never
      // learn they are behind.
      const ahead = await importSchema(options.db, config, options.boot, { dryRun: true })
      const version = loadSchemaDirectory(config.schemaDir).set.version
      const next = nextSchemaVersion(version, ahead.classification)
      if (next !== version) await writeFile(versionFile, writeSchemaVersion(next), 'utf8')

      const result = await importSchema(options.db, config, options.boot)
      if (result.report && result.report.action !== 'applied') {
        // Put the files back: a refused import leaves the site with a file it will
        // not accept, which is worse than the change not having happened.
        await restore()
        return {
          ok: false,
          error: result.report.reason ?? `the import was ${result.report.action}`,
        }
      }
      log.info('{alias} applied from a proposal: {classification}, schema at {version}', {
        alias,
        classification: ahead.classification,
        version: options.boot.nodeState.version,
      })
      return { ok: true, version: options.boot.nodeState.version }
    },
  }

  /**
   * Written back through the canonical writer, so what lands on disk is what the
   * backoffice itself would write — one layout, one key order — rather than
   * whatever the model's formatting happened to be.
   */
  function canonical(kind: string, alias: string, toml: string): string {
    const file = `schema/${directoryFor(kind)}/${fileNameFor(alias)}`
    if (isDataType(kind)) {
      const parsed = parseDataType(file, toml)
      return parsed.value ? writeDataType(parsed.value) : toml
    }
    const parsed = parseDocumentType(file, toml)
    return parsed.value ? writeDocumentType(parsed.value) : toml
  }
}
