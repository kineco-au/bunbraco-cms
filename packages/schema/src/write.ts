/**
 * Model → canonical TOML.
 *
 * Our own writer, for a fixed vocabulary: deterministic key order, one layout,
 * comments stripped by construction (`description` and `notes` are the fields
 * that survive), and none of the quote or blank-line churn of general-purpose
 * TOML serialisers. `parse(write(x))` must equal `x` — the tests hold it to that.
 */
import {
  type SchemaDataType,
  type SchemaDocumentType,
  type SchemaLanguage,
  type SchemaProperty,
  type SchemaTypeKind,
  TYPE_KIND_FILES,
} from './model.ts'

function str(value: string): string {
  return JSON.stringify(value)
}

function scalar(value: unknown): string {
  if (typeof value === 'string') return str(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(scalar).join(', ')}]`
  if (value === null || value === undefined) return '""'
  return str(JSON.stringify(value))
}

/**
 * A key as TOML will read it back: bare when the grammar allows, quoted and
 * escaped when it does not.
 *
 * Every key in this file is a literal of ours but one — a data type's `config`
 * keys are property-editor value aliases, which arrive from the API and from
 * proposed TOML. An alias holding a newline, written bare, turns one line into
 * several and the file stops parsing: the site then fails to boot on the next
 * read, and with a schema store configured the broken file is published to the
 * other nodes too.
 */
function keyOf(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : str(key)
}

function line(out: string[], key: string, value: unknown, when = true): void {
  if (!when || value === undefined) return
  out.push(`${keyOf(key)} = ${scalar(value)}`)
}

function writeProperty(out: string[], header: string, p: SchemaProperty): void {
  out.push('', `[[${header}]]`)
  line(out, 'key', p.key)
  line(out, 'alias', p.alias)
  line(out, 'name', p.name)
  line(out, 'description', p.description)
  line(out, 'notes', p.notes)
  line(out, 'type', p.type)
  line(out, 'mandatory', true, p.mandatory)
  line(out, 'mandatory-message', p.mandatoryMessage)
  line(out, 'regex', p.regex)
  line(out, 'regex-message', p.regexMessage)
  line(out, 'varies-by-culture', true, p.variesByCulture)
  line(out, 'varies-by-segment', true, p.variesBySegment)
  line(out, 'label-on-top', true, p.labelOnTop)
  line(out, 'member-can-view', true, p.memberCanView === true)
  line(out, 'member-can-edit', true, p.memberCanEdit === true)
  line(out, 'sensitive', true, p.sensitive === true)
  line(out, 'default', p.default)
  line(out, 'since', p.since)
}

export function writeDocumentType(
  t: SchemaDocumentType,
  kind: SchemaTypeKind = 'document',
): string {
  const out: string[] = [`[${TYPE_KIND_FILES[kind].header}]`]
  line(out, 'key', t.key)
  line(out, 'alias', t.alias)
  line(out, 'name', t.name)
  line(out, 'description', t.description)
  line(out, 'notes', t.notes)
  line(out, 'icon', t.icon, t.icon !== 'icon-document')
  line(out, 'allow-at-root', true, t.allowAtRoot)
  line(out, 'is-element', true, t.isElement)
  line(out, 'allow-in-library', true, t.allowInLibrary)
  line(out, 'varies-by-culture', true, t.variesByCulture)
  line(out, 'varies-by-segment', true, t.variesBySegment)
  line(out, 'compositions', t.compositions, t.compositions.length > 0)
  line(out, 'allow-children', t.allowChildren, t.allowChildren.length > 0)
  line(out, 'templates', t.templates, t.templates.length > 0)
  line(out, 'default-template', t.defaultTemplate)
  line(out, 'collection', t.collection)
  line(out, 'folder', t.folder)
  line(out, 'since', t.since)
  if (
    t.cleanup.prevent ||
    t.cleanup.keepAllNewerThanDays !== undefined ||
    t.cleanup.keepLatestPerDayForDays !== undefined
  ) {
    out.push('', '[document-type.cleanup]')
    line(out, 'prevent', true, t.cleanup.prevent)
    line(out, 'keep-all-newer-than-days', t.cleanup.keepAllNewerThanDays)
    line(out, 'keep-latest-per-day-for-days', t.cleanup.keepLatestPerDayForDays)
  }
  for (const p of t.properties) writeProperty(out, 'property', p)
  for (const g of t.groups ?? []) {
    out.push('', '[[group]]')
    line(out, 'name', g.name)
    line(out, 'alias', g.alias)
    for (const p of g.properties) writeProperty(out, 'group.property', p)
  }
  for (const tab of t.tabs) {
    out.push('', '[[tab]]')
    line(out, 'name', tab.name)
    line(out, 'alias', tab.alias)
    for (const p of tab.properties) writeProperty(out, 'tab.property', p)
    for (const g of tab.groups) {
      out.push('', '[[tab.group]]')
      line(out, 'name', g.name)
      line(out, 'alias', g.alias)
      for (const p of g.properties) writeProperty(out, 'tab.group.property', p)
    }
  }
  return `${out.join('\n')}\n`
}

export function writeMediaType(t: SchemaDocumentType): string {
  return writeDocumentType(t, 'media')
}

export function writeMemberType(t: SchemaDocumentType): string {
  return writeDocumentType(t, 'member')
}

export function writeDataType(d: SchemaDataType): string {
  const out: string[] = ['[data-type]']
  line(out, 'key', d.key)
  line(out, 'alias', d.alias)
  line(out, 'name', d.name)
  line(out, 'notes', d.notes)
  line(out, 'editor', d.editor)
  line(out, 'editor-ui', d.editorUi)
  line(out, 'folder', d.folder)
  line(out, 'since', d.since)
  const keys = Object.keys(d.config).sort()
  if (keys.length > 0) {
    out.push('', '[data-type.config]')
    for (const key of keys) line(out, key, d.config[key])
  }
  return `${out.join('\n')}\n`
}

export function writeLanguages(languages: readonly SchemaLanguage[]): string {
  const out: string[] = []
  for (const l of languages) {
    if (out.length > 0) out.push('')
    out.push('[[language]]')
    line(out, 'iso', l.iso)
    line(out, 'name', l.name)
    line(out, 'default', true, l.default)
    line(out, 'mandatory', true, l.mandatory)
    line(out, 'fallback', l.fallback)
  }
  return `${out.join('\n')}\n`
}

export function writeSchemaVersion(version: string): string {
  return `[schema]\nversion = ${str(version)}\n`
}

/** The canonical filename for an alias: kebab-case. */
export function fileNameFor(alias: string): string {
  const kebab = alias
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .toLowerCase()
  return `${kebab}.toml`
}
