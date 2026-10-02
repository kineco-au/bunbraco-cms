/**
 * TOML → model. Strict: an unknown key is an error, because a misspelt key is
 * the most common mistake a non-developer makes and silently ignoring it would
 * hide the thing they were trying to do.
 */
import {
  type SchemaDataType,
  type SchemaDocumentType,
  type SchemaGroup,
  type SchemaLanguage,
  type SchemaProblem,
  type SchemaProperty,
  type SchemaTab,
  type SchemaTypeKind,
  TYPE_KIND_FILES,
} from './model.ts'

type Toml = Record<string, unknown>

class Reader {
  readonly problems: SchemaProblem[] = []
  constructor(readonly file: string) {}

  problem(path: string, message: string): void {
    this.problems.push({ file: this.file, path, message })
  }

  table(value: unknown, path: string): Toml | undefined {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Toml
    this.problem(path, 'expected a table')
    return undefined
  }

  tables(value: unknown, path: string): Toml[] {
    if (value === undefined) return []
    if (!Array.isArray(value)) {
      this.problem(path, 'expected an array of tables ([[...]])')
      return []
    }
    return value.filter((v, i) => this.table(v, `${path}[${i}]`) !== undefined) as Toml[]
  }

  str(t: Toml, key: string, path: string, required = false): string | undefined {
    const v = t[key]
    if (v === undefined) {
      if (required) this.problem(`${path}.${key}`, 'is required')
      return undefined
    }
    if (typeof v !== 'string') {
      this.problem(`${path}.${key}`, 'expected a string')
      return undefined
    }
    return v
  }

  bool(t: Toml, key: string, path: string, fallback: boolean): boolean {
    const v = t[key]
    if (v === undefined) return fallback
    if (typeof v !== 'boolean') {
      this.problem(`${path}.${key}`, 'expected true or false')
      return fallback
    }
    return v
  }

  num(t: Toml, key: string, path: string): number | undefined {
    const v = t[key]
    if (v === undefined) return undefined
    if (typeof v !== 'number') {
      this.problem(`${path}.${key}`, 'expected a number')
      return undefined
    }
    return v
  }

  strs(t: Toml, key: string, path: string): string[] {
    const v = t[key]
    if (v === undefined) return []
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      this.problem(`${path}.${key}`, 'expected an array of strings')
      return []
    }
    return v as string[]
  }

  unknown(t: Toml, allowed: readonly string[], path: string): void {
    for (const key of Object.keys(t)) {
      if (!allowed.includes(key))
        this.problem(`${path}.${key}`, `unknown key; expected one of ${allowed.join(', ')}`)
    }
  }
}

const PROPERTY_KEYS = [
  'member-can-view',
  'member-can-edit',
  'sensitive',
  'key',
  'alias',
  'name',
  'description',
  'notes',
  'type',
  'mandatory',
  'mandatory-message',
  'regex',
  'regex-message',
  'varies-by-culture',
  'varies-by-segment',
  'label-on-top',
  'default',
  'since',
] as const
const GROUP_KEYS = ['name', 'alias', 'property'] as const
const TAB_KEYS = ['name', 'alias', 'property', 'group'] as const
const TYPE_KEYS = [
  'key',
  'alias',
  'name',
  'description',
  'notes',
  'icon',
  'allow-at-root',
  'is-element',
  'allow-in-library',
  'varies-by-culture',
  'varies-by-segment',
  'compositions',
  'allow-children',
  'templates',
  'default-template',
  'collection',
  'folder',
  'cleanup',
  'since',
] as const
const CLEANUP_KEYS = [
  'prevent',
  'keep-all-newer-than-days',
  'keep-latest-per-day-for-days',
] as const
const DATA_TYPE_KEYS = [
  'key',
  'alias',
  'name',
  'notes',
  'editor',
  'editor-ui',
  'folder',
  'config',
  'since',
] as const
const LANGUAGE_KEYS = ['iso', 'name', 'default', 'mandatory', 'fallback'] as const

function property(r: Reader, t: Toml, path: string): SchemaProperty {
  r.unknown(t, PROPERTY_KEYS, path)
  return {
    key: r.str(t, 'key', path),
    alias: r.str(t, 'alias', path, true) ?? '',
    name: r.str(t, 'name', path, true) ?? '',
    description: r.str(t, 'description', path),
    notes: r.str(t, 'notes', path),
    type: r.str(t, 'type', path, true) ?? '',
    mandatory: r.bool(t, 'mandatory', path, false),
    mandatoryMessage: r.str(t, 'mandatory-message', path),
    regex: r.str(t, 'regex', path),
    regexMessage: r.str(t, 'regex-message', path),
    variesByCulture: r.bool(t, 'varies-by-culture', path, false),
    variesBySegment: r.bool(t, 'varies-by-segment', path, false),
    labelOnTop: r.bool(t, 'label-on-top', path, false),
    ...(t['member-can-view'] !== undefined
      ? { memberCanView: r.bool(t, 'member-can-view', path, false) }
      : {}),
    ...(t['member-can-edit'] !== undefined
      ? { memberCanEdit: r.bool(t, 'member-can-edit', path, false) }
      : {}),
    ...(t.sensitive !== undefined ? { sensitive: r.bool(t, 'sensitive', path, false) } : {}),
    default: t.default,
    since: r.str(t, 'since', path),
  }
}

function group(r: Reader, t: Toml, path: string): SchemaGroup {
  r.unknown(t, GROUP_KEYS, path)
  return {
    name: r.str(t, 'name', path, true) ?? '',
    alias: r.str(t, 'alias', path),
    properties: r
      .tables(t.property, `${path}.property`)
      .map((p, i) => property(r, p, `${path}.property[${i}]`)),
  }
}

function tab(r: Reader, t: Toml, path: string): SchemaTab {
  r.unknown(t, TAB_KEYS, path)
  return {
    name: r.str(t, 'name', path, true) ?? '',
    alias: r.str(t, 'alias', path),
    properties: r
      .tables(t.property, `${path}.property`)
      .map((p, i) => property(r, p, `${path}.property[${i}]`)),
    groups: r.tables(t.group, `${path}.group`).map((g, i) => group(r, g, `${path}.group[${i}]`)),
  }
}

export interface ParseResult<T> {
  value: T | undefined
  problems: SchemaProblem[]
}

function toml(source: string, r: Reader): Toml | undefined {
  try {
    return Bun.TOML.parse(source) as Toml
  } catch (error) {
    r.problem('', `invalid TOML: ${(error as Error).message}`)
    return undefined
  }
}

/** Media types have no templates and no version cleanup policy. */
const MEDIA_TYPE_KEYS = TYPE_KEYS.filter(
  (k) => k !== 'templates' && k !== 'default-template' && k !== 'cleanup',
)
/** Member types, besides, allow no children: members are not a tree. */
const MEMBER_TYPE_KEYS = MEDIA_TYPE_KEYS.filter((k) => k !== 'allow-children')

export function parseDocumentType(
  file: string,
  source: string,
  kind: SchemaTypeKind = 'document',
): ParseResult<SchemaDocumentType> {
  const r = new Reader(file)
  const root = toml(source, r)
  if (!root) return { value: undefined, problems: r.problems }
  const header = TYPE_KIND_FILES[kind].header
  r.unknown(root, [header, 'tab', 'group', 'property'], '')
  const t = r.table(root[header], header)
  if (!t) {
    r.problem(header, `a [${header}] table is required`)
    return { value: undefined, problems: r.problems }
  }
  const path = header
  r.unknown(
    t,
    kind === 'media' ? MEDIA_TYPE_KEYS : kind === 'member' ? MEMBER_TYPE_KEYS : TYPE_KEYS,
    path,
  )
  const cleanupTable = t.cleanup === undefined ? undefined : r.table(t.cleanup, `${path}.cleanup`)
  if (cleanupTable) r.unknown(cleanupTable, CLEANUP_KEYS, `${path}.cleanup`)
  const value: SchemaDocumentType = {
    key: r.str(t, 'key', path),
    alias: r.str(t, 'alias', path, true) ?? '',
    name: r.str(t, 'name', path, true) ?? '',
    description: r.str(t, 'description', path),
    notes: r.str(t, 'notes', path),
    icon: r.str(t, 'icon', path) ?? 'icon-document',
    allowAtRoot: r.bool(t, 'allow-at-root', path, false),
    isElement: r.bool(t, 'is-element', path, false),
    allowInLibrary: r.bool(t, 'allow-in-library', path, false),
    variesByCulture: r.bool(t, 'varies-by-culture', path, false),
    variesBySegment: r.bool(t, 'varies-by-segment', path, false),
    compositions: r.strs(t, 'compositions', path),
    allowChildren: r.strs(t, 'allow-children', path),
    templates: r.strs(t, 'templates', path),
    defaultTemplate: r.str(t, 'default-template', path),
    collection: r.str(t, 'collection', path),
    folder: r.str(t, 'folder', path),
    cleanup: {
      prevent: cleanupTable ? r.bool(cleanupTable, 'prevent', `${path}.cleanup`, false) : false,
      keepAllNewerThanDays: cleanupTable
        ? r.num(cleanupTable, 'keep-all-newer-than-days', `${path}.cleanup`)
        : undefined,
      keepLatestPerDayForDays: cleanupTable
        ? r.num(cleanupTable, 'keep-latest-per-day-for-days', `${path}.cleanup`)
        : undefined,
    },
    since: r.str(t, 'since', path),
    properties: r.tables(root.property, 'property').map((p, i) => property(r, p, `property[${i}]`)),
    tabs: r.tables(root.tab, 'tab').map((x, i) => tab(r, x, `tab[${i}]`)),
    groups: r.tables(root.group, 'group').map((g, i) => group(r, g, `group[${i}]`)),
  }
  return { value: r.problems.length === 0 ? value : undefined, problems: r.problems }
}

export function parseMediaType(file: string, source: string): ParseResult<SchemaDocumentType> {
  return parseDocumentType(file, source, 'media')
}

export function parseMemberType(file: string, source: string): ParseResult<SchemaDocumentType> {
  return parseDocumentType(file, source, 'member')
}

export function parseDataType(file: string, source: string): ParseResult<SchemaDataType> {
  const r = new Reader(file)
  const root = toml(source, r)
  if (!root) return { value: undefined, problems: r.problems }
  r.unknown(root, ['data-type'], '')
  const t = r.table(root['data-type'], 'data-type')
  if (!t) {
    r.problem('data-type', 'a [data-type] table is required')
    return { value: undefined, problems: r.problems }
  }
  const path = 'data-type'
  r.unknown(t, DATA_TYPE_KEYS, path)
  const config = t.config === undefined ? {} : r.table(t.config, `${path}.config`)
  const value: SchemaDataType = {
    key: r.str(t, 'key', path),
    alias: r.str(t, 'alias', path, true) ?? '',
    name: r.str(t, 'name', path, true) ?? '',
    notes: r.str(t, 'notes', path),
    editor: r.str(t, 'editor', path, true) ?? '',
    editorUi: r.str(t, 'editor-ui', path),
    folder: r.str(t, 'folder', path),
    config: (config ?? {}) as Record<string, unknown>,
    since: r.str(t, 'since', path),
  }
  return { value: r.problems.length === 0 ? value : undefined, problems: r.problems }
}

export function parseLanguages(file: string, source: string): ParseResult<SchemaLanguage[]> {
  const r = new Reader(file)
  const root = toml(source, r)
  if (!root) return { value: undefined, problems: r.problems }
  r.unknown(root, ['language'], '')
  const value = r.tables(root.language, 'language').map((t, i) => {
    const path = `language[${i}]`
    r.unknown(t, LANGUAGE_KEYS, path)
    return {
      iso: r.str(t, 'iso', path, true) ?? '',
      name: r.str(t, 'name', path, true) ?? '',
      default: r.bool(t, 'default', path, false),
      mandatory: r.bool(t, 'mandatory', path, false),
      fallback: r.str(t, 'fallback', path),
    } satisfies SchemaLanguage
  })
  return { value: r.problems.length === 0 ? value : undefined, problems: r.problems }
}

export function parseSchemaVersion(file: string, source: string): ParseResult<string> {
  const r = new Reader(file)
  const root = toml(source, r)
  if (!root) return { value: undefined, problems: r.problems }
  r.unknown(root, ['schema'], '')
  const t = r.table(root.schema, 'schema')
  const version = t ? r.str(t, 'version', 'schema', true) : undefined
  if (t) r.unknown(t, ['version'], 'schema')
  return { value: r.problems.length === 0 ? version : undefined, problems: r.problems }
}
