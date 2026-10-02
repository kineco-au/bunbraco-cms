/**
 * Reads a `schema/` directory into a SchemaSet, and hashes it.
 *
 * The hash is over canonical serialisations, sorted — so it does not change
 * with file order, whitespace or comments, only with meaning.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  SchemaDataType,
  SchemaDocumentType,
  SchemaLanguage,
  SchemaProblem,
  SchemaSet,
} from './model.ts'
import { typeFileKey } from './model.ts'
import {
  parseDataType,
  parseDocumentType,
  parseLanguages,
  parseMediaType,
  parseMemberType,
  parseSchemaVersion,
} from './parse.ts'
import {
  writeDataType,
  writeDocumentType,
  writeLanguages,
  writeMediaType,
  writeMemberType,
} from './write.ts'

export interface LoadedSchema {
  set: SchemaSet
  problems: SchemaProblem[]
  /** Which file each type or data type came from, by alias. */
  files: Map<string, string>
}

function tomlFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.toml'))
    .sort()
    .map((name) => join(dir, name))
}

export function loadSchemaDirectory(schemaDir: string): LoadedSchema {
  const problems: SchemaProblem[] = []
  const files = new Map<string, string>()
  const documentTypes: SchemaDocumentType[] = []
  const dataTypes: SchemaDataType[] = []
  let languages: SchemaLanguage[] = []
  let version = '0'

  const rel = (file: string) =>
    file.startsWith(schemaDir) ? `schema${file.slice(schemaDir.length)}` : file

  const versionFile = join(schemaDir, 'schema.toml')
  if (existsSync(versionFile)) {
    const parsed = parseSchemaVersion(rel(versionFile), readFileSync(versionFile, 'utf8'))
    problems.push(...parsed.problems)
    if (parsed.value) version = parsed.value
  }
  for (const file of tomlFiles(join(schemaDir, 'document-types'))) {
    const parsed = parseDocumentType(rel(file), readFileSync(file, 'utf8'))
    problems.push(...parsed.problems)
    if (parsed.value) {
      documentTypes.push(parsed.value)
      files.set(parsed.value.alias, file)
    }
  }
  const mediaTypes: SchemaDocumentType[] = []
  for (const file of tomlFiles(join(schemaDir, 'media-types'))) {
    const parsed = parseMediaType(rel(file), readFileSync(file, 'utf8'))
    problems.push(...parsed.problems)
    if (parsed.value) {
      mediaTypes.push(parsed.value)
      files.set(typeFileKey('media', parsed.value.alias), file)
    }
  }
  const memberTypes: SchemaDocumentType[] = []
  for (const file of tomlFiles(join(schemaDir, 'member-types'))) {
    const parsed = parseMemberType(rel(file), readFileSync(file, 'utf8'))
    problems.push(...parsed.problems)
    if (parsed.value) {
      memberTypes.push(parsed.value)
      files.set(typeFileKey('member', parsed.value.alias), file)
    }
  }
  for (const file of tomlFiles(join(schemaDir, 'data-types'))) {
    const parsed = parseDataType(rel(file), readFileSync(file, 'utf8'))
    problems.push(...parsed.problems)
    if (parsed.value) {
      dataTypes.push(parsed.value)
      files.set(`data-type:${parsed.value.alias}`, file)
    }
  }
  const languagesFile = join(schemaDir, 'languages.toml')
  if (existsSync(languagesFile)) {
    const parsed = parseLanguages(rel(languagesFile), readFileSync(languagesFile, 'utf8'))
    problems.push(...parsed.problems)
    if (parsed.value) languages = parsed.value
  }
  return {
    set: { version, documentTypes, mediaTypes, memberTypes, dataTypes, languages },
    problems,
    files,
  }
}

/** Order-independent content hash of a schema set. */
export function hashSchemaSet(set: SchemaSet): string {
  const parts = [
    `version:${set.version}`,
    ...set.documentTypes.map((t) => writeDocumentType(t)).sort(),
    ...(set.mediaTypes ?? []).map((t) => writeMediaType(t)).sort(),
    ...(set.memberTypes ?? []).map((t) => writeMemberType(t)).sort(),
    ...set.dataTypes.map((d) => writeDataType(d)).sort(),
    writeLanguages([...set.languages].sort((a, b) => a.iso.localeCompare(b.iso))),
  ]
  return createHash('sha256').update(parts.join('\n---\n')).digest('hex')
}
