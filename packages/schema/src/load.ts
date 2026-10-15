/**
 * Reads a `schema/` directory into a SchemaSet, and hashes it.
 *
 * The hash is over canonical serialisations, sorted — so it does not change
 * with file order, whitespace or comments, only with meaning.
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FormTypes } from '@crombolo/core'
import type { SchemaForm } from './forms.ts'
import type {
  SchemaContentType,
  SchemaDataType,
  SchemaLanguage,
  SchemaProblem,
  SchemaSet,
  SchemaUrls,
} from './model.ts'
import { TYPE_KIND_FILES, typeFileKey } from './model.ts'
import {
  parseContentType,
  parseDataType,
  parseLanguages,
  parseMediaType,
  parseMemberType,
  parseSchemaSettings,
} from './parse.ts'
import { parseForm } from './parse-forms.ts'
import {
  writeContentType,
  writeDataType,
  writeLanguages,
  writeMediaType,
  writeMemberType,
} from './write.ts'
import { writeForm } from './write-forms.ts'

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

export interface LoadSchemaOptions {
  /** The field and workflow types forms may use: the built-ins, and the wired bundles'. */
  formTypes?: FormTypes
}

export function loadSchemaDirectory(
  schemaDir: string,
  options: LoadSchemaOptions = {},
): LoadedSchema {
  const problems: SchemaProblem[] = []
  const files = new Map<string, string>()
  const contentTypes: SchemaContentType[] = []
  const dataTypes: SchemaDataType[] = []
  let languages: SchemaLanguage[] = []
  let version = '0'
  let urls: SchemaUrls | undefined

  const rel = (file: string) =>
    file.startsWith(schemaDir) ? `schema${file.slice(schemaDir.length)}` : file

  const versionFile = join(schemaDir, 'schema.toml')
  if (existsSync(versionFile)) {
    const parsed = parseSchemaSettings(rel(versionFile), readFileSync(versionFile, 'utf8'))
    problems.push(...parsed.problems)
    if (parsed.value) {
      version = parsed.value.version
      urls = parsed.value.urls
    }
  }
  for (const file of tomlFiles(join(schemaDir, TYPE_KIND_FILES.document.dir))) {
    const parsed = parseContentType(rel(file), readFileSync(file, 'utf8'))
    problems.push(...parsed.problems)
    if (parsed.value) {
      contentTypes.push(parsed.value)
      files.set(parsed.value.alias, file)
    }
  }
  const mediaTypes: SchemaContentType[] = []
  for (const file of tomlFiles(join(schemaDir, 'media-types'))) {
    const parsed = parseMediaType(rel(file), readFileSync(file, 'utf8'))
    problems.push(...parsed.problems)
    if (parsed.value) {
      mediaTypes.push(parsed.value)
      files.set(typeFileKey('media', parsed.value.alias), file)
    }
  }
  const memberTypes: SchemaContentType[] = []
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
  const forms: SchemaForm[] = []
  for (const file of tomlFiles(join(schemaDir, 'forms'))) {
    const parsed = parseForm(rel(file), readFileSync(file, 'utf8'), options.formTypes)
    problems.push(...parsed.problems)
    if (parsed.value) {
      forms.push(parsed.value)
      files.set(`form:${parsed.value.alias}`, file)
    }
  }
  const languagesFile = join(schemaDir, 'languages.toml')
  if (existsSync(languagesFile)) {
    const parsed = parseLanguages(rel(languagesFile), readFileSync(languagesFile, 'utf8'))
    problems.push(...parsed.problems)
    if (parsed.value) languages = parsed.value
  }
  return {
    set: {
      version,
      contentTypes,
      mediaTypes,
      memberTypes,
      dataTypes,
      languages,
      forms,
      ...(urls ? { urls } : {}),
    },
    problems,
    files,
  }
}

/** Order-independent content hash of a schema set. */
export function hashSchemaSet(set: SchemaSet): string {
  const parts = [
    `version:${set.version}`,
    // Only when not the default, so every site hashed before this kept its hash.
    ...(set.urls?.hideTopLevel === false ? ['urls:top-level-shown'] : []),
    ...set.contentTypes.map((t) => writeContentType(t)).sort(),
    ...(set.mediaTypes ?? []).map((t) => writeMediaType(t)).sort(),
    ...(set.memberTypes ?? []).map((t) => writeMemberType(t)).sort(),
    ...set.dataTypes.map((d) => writeDataType(d)).sort(),
    writeLanguages([...set.languages].sort((a, b) => a.iso.localeCompare(b.iso))),
    ...(set.forms ?? []).map((f) => writeForm(f)).sort(),
  ]
  return createHash('sha256').update(parts.join('\n---\n')).digest('hex')
}
