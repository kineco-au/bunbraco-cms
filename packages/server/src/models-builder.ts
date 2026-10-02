/**
 * Umbraco's ModelsBuilder over `bunbraco generate`: the models are the
 * TypeScript in `schema/content-types.d.ts`, written from the TOML schema.
 *
 * Umbraco reports staleness from a flag file written when a content type
 * changes. There is nothing to flag here — the schema files are the truth — so
 * "out of date" is answered by generating the types and comparing them with
 * what is on disk, which cannot drift from the question being asked.
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type {
  ModelsBuilderInfo,
  ModelsBuilderPort,
  OutOfDateStatus,
} from '@bunbraco/api-management'
import { generateTypes, loadSchemaDirectory, validateSchemaSet } from '@bunbraco/schema'
import type { BunbracoConfig } from './config.ts'
import { VERSION } from './config.ts'
import { logger } from './logging.ts'

/** The file `bunbraco generate` writes, inside the schema directory. */
export const GENERATED_FILE = 'content-types.d.ts'

export type Intended = { types: string } | { problems: string[] }

/** What `bunbraco generate` would write now, or the problems stopping it. */
export function intendedTypes(schemaDir: string): Intended {
  if (!existsSync(schemaDir)) return { problems: [`No schema directory at ${schemaDir}`] }
  const loaded = loadSchemaDirectory(schemaDir)
  const problems = [...loaded.problems, ...validateSchemaSet(loaded.set)]
  if (problems.length > 0)
    return {
      problems: problems.map((p) => `${p.file}${p.path ? ` (${p.path})` : ''}: ${p.message}`),
    }
  return { types: generateTypes(loaded.set) }
}

/** Undefined when the schema does not generate, so staleness is unknowable. */
export async function compareModels(
  schemaDir: string,
): Promise<{ outOfDate: boolean } | undefined> {
  const intended = intendedTypes(schemaDir)
  if ('problems' in intended) return undefined
  const target = join(schemaDir, GENERATED_FILE)
  if (!existsSync(target)) return { outOfDate: true }
  const current = await readFile(target, 'utf8').catch(() => undefined)
  return { outOfDate: current !== intended.types }
}

export function createModelsBuilderPort(
  config: Pick<BunbracoConfig, 'schemaDir'>,
): ModelsBuilderPort {
  // Umbraco keeps the last generation error in memory and shows it on the
  // dashboard; a build that succeeds clears it.
  let lastError: string | null = null
  const log = logger('models-builder')

  const describe = async (): Promise<ModelsBuilderInfo> => {
    const compared = await compareModels(config.schemaDir)
    return {
      // The models are TypeScript source, written on request: Umbraco's mode for
      // exactly that. The client only explains its own four mode strings.
      mode: 'SourceCodeManual',
      canGenerate: true,
      outOfDateModels: compared?.outOfDate ?? false,
      trackingOutOfDateModels: true,
      lastError,
      version: VERSION,
      // Shown to a person, so the path the CLI would print rather than an
      // absolute one from inside a container.
      modelsNamespace: relative(process.cwd(), join(config.schemaDir, GENERATED_FILE)),
    }
  }

  return {
    info: describe,

    async status(): Promise<OutOfDateStatus> {
      const compared = await compareModels(config.schemaDir)
      if (!compared) return 'Unknown'
      return compared.outOfDate ? 'OutOfDate' : 'Current'
    },

    async build() {
      const intended = intendedTypes(config.schemaDir)
      if ('problems' in intended) {
        lastError = intended.problems.join('\n')
        log.warn('Models were not generated: {problems}', { problems: intended.problems.length })
        return { ok: false, error: lastError }
      }
      const target = join(config.schemaDir, GENERATED_FILE)
      try {
        await writeFile(target, intended.types)
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        log.error('Models could not be written to {target}', { target })
        return { ok: false, error: lastError }
      }
      lastError = null
      log.info('Models written to {target}', { target })
      return { ok: true }
    },
  }
}
