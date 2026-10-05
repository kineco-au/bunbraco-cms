/**
 * Writing a form definition back to `schema/forms/`. `docs/18-forms.md`.
 *
 * The designer saves a form the way the type editors save a document type: the
 * file is the truth, so the write goes to the file and `onChanged` publishes it
 * to a shared schema store when one is configured. A site whose schema is a
 * read-only directory refuses the save rather than appearing to take it.
 *
 * Validated before it is written, and against the whole set: a form that would
 * fail the boot must not be the thing that is on disk.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SchemaForm } from '@bunbraco/core'
import {
  fileNameFor,
  loadSchemaDirectory,
  parseForm,
  type SchemaProblem,
  validateForms,
  writeForm,
} from '@bunbraco/schema'

export interface FormFileOptions {
  schemaDir: string
  /** False on a deployed node with no schema store: the write would not last. */
  writable: boolean
  /** Publishes the directory to a shared store, when there is one. */
  onChanged?: () => Promise<void>
}

export type FormWriteResult =
  | { ok: true; file: string }
  | { ok: false; status: 'readOnly' | 'invalid' | 'notFound'; problems: SchemaProblem[] }

const readOnly = (): FormWriteResult => ({
  ok: false,
  status: 'readOnly',
  problems: [
    {
      file: 'schema/forms',
      path: '',
      message:
        'The schema directory is read-only on this node, so a form cannot be saved. Configure a schema store, or change the file in the repository.',
    },
  ],
})

/** Where a form's file goes: kebab-case of its alias, as the other types are. */
export const formFileName = (alias: string): string => fileNameFor(alias)

/**
 * The designer's JSON as a definition.
 *
 * Coerced loosely and then held to the real gate: the candidate is written to
 * TOML and read back with `parseForm`, which is strict about every key. So the
 * one parser decides what a form may contain, and this only has to get the
 * shape close enough to serialise.
 */
export function coerceForm(value: unknown): SchemaForm {
  const body = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const text = (key: string): string | undefined => {
    const found = body[key]
    return typeof found === 'string' && found.trim() !== '' ? found : undefined
  }
  const flag = (key: string, fallback: boolean): boolean =>
    typeof body[key] === 'boolean' ? (body[key] as boolean) : fallback
  const count = (key: string): number | undefined =>
    typeof body[key] === 'number' && Number.isFinite(body[key]) ? (body[key] as number) : undefined

  const pages = Array.isArray(body.pages) ? body.pages : []
  return {
    key: text('key'),
    alias: text('alias') ?? '',
    name: text('name') ?? '',
    notes: text('notes'),
    storeEntries: flag('storeEntries', true),
    requiresApproval: flag('requiresApproval', false),
    submitLabel: text('submitLabel'),
    nextLabel: text('nextLabel'),
    previousLabel: text('previousLabel'),
    messageOnSubmit: text('messageOnSubmit'),
    redirectTo: text('redirectTo'),
    theme: text('theme'),
    honeypot: flag('honeypot', true),
    minimumSubmitSeconds: count('minimumSubmitSeconds'),
    maxEntries: count('maxEntries'),
    since: text('since'),
    pages: pages.map((page) => coercePage(page)),
    workflows: (Array.isArray(body.workflows) ? body.workflows : []).map((workflow) =>
      coerceWorkflow(workflow),
    ),
  }
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

function coercePage(value: unknown): SchemaForm['pages'][number] {
  const body = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    caption: typeof body.caption === 'string' && body.caption ? body.caption : undefined,
    condition: coerceCondition(body.condition),
    groups: (Array.isArray(body.groups) ? body.groups : []).map((group) => coerceGroup(group)),
  }
}

function coerceGroup(value: unknown): SchemaForm['pages'][number]['groups'][number] {
  const body = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    caption: typeof body.caption === 'string' && body.caption ? body.caption : undefined,
    columns: typeof body.columns === 'number' ? body.columns : 1,
    condition: coerceCondition(body.condition),
    fields: (Array.isArray(body.fields) ? body.fields : []).map((field) => coerceField(field)),
  }
}

type Field = SchemaForm['pages'][number]['groups'][number]['fields'][number]

function coerceField(value: unknown): Field {
  const body = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const text = (key: string): string | undefined => {
    const found = body[key]
    return typeof found === 'string' && found.trim() !== '' ? found : undefined
  }
  const count = (key: string): number | undefined =>
    typeof body[key] === 'number' && Number.isFinite(body[key]) ? (body[key] as number) : undefined
  return {
    key: text('key'),
    alias: text('alias') ?? '',
    type: (text('type') ?? '') as Field['type'],
    caption: text('caption') ?? '',
    helpText: text('helpText'),
    mandatory: body.mandatory === true,
    mandatoryMessage: text('mandatoryMessage'),
    pattern: text('pattern'),
    patternMessage: text('patternMessage'),
    sensitive: body.sensitive === true,
    cssClass: text('cssClass'),
    autocomplete: text('autocomplete'),
    values: strings(body.values),
    placeholder: text('placeholder'),
    defaultValue: text('defaultValue'),
    content: text('content'),
    maxlength: count('maxlength'),
    rows: count('rows'),
    min: count('min'),
    max: count('max'),
    step: count('step'),
    accept: strings(body.accept),
    maxSizeKb: count('maxSizeKb'),
    ...(typeof body.multiple === 'boolean' ? { multiple: body.multiple } : {}),
    condition: coerceCondition(body.condition),
  }
}

function coerceCondition(value: unknown): Field['condition'] {
  if (!value || typeof value !== 'object') return undefined
  const body = value as Record<string, unknown>
  const rules = (Array.isArray(body.rule) ? body.rule : Array.isArray(body.rules) ? body.rules : [])
    .filter((rule): rule is Record<string, unknown> => Boolean(rule) && typeof rule === 'object')
    .map((rule) => ({
      field: typeof rule.field === 'string' ? rule.field : '',
      operator: (typeof rule.operator === 'string' ? rule.operator : 'is') as never,
      value: typeof rule.value === 'string' ? rule.value : undefined,
    }))
  if (rules.length === 0) return undefined
  return {
    action: body.action === 'hide' ? 'hide' : 'show',
    match: body.match === 'any' ? 'any' : 'all',
    rules,
  }
}

function coerceWorkflow(value: unknown): SchemaForm['workflows'][number] {
  const body = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    key: typeof body.key === 'string' && body.key ? body.key : undefined,
    type: (typeof body.type === 'string' ? body.type : '') as never,
    name: typeof body.name === 'string' ? body.name : '',
    on: body.on === 'approve' ? 'approve' : 'submit',
    settings:
      body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)
        ? (body.settings as Record<string, unknown>)
        : {},
  }
}

export async function saveForm(
  candidate: SchemaForm,
  options: FormFileOptions,
): Promise<FormWriteResult> {
  if (!options.writable) return readOnly()

  // Written then read back with the strict parser, so the file the designer
  // would produce is held to exactly what a hand-written one is.
  const name = formFileName(candidate.alias || 'form')
  const reparsed = parseForm(`schema/forms/${name}`, writeForm(candidate))
  if (!reparsed.value) return { ok: false, status: 'invalid', problems: reparsed.problems }
  const form = reparsed.value

  // Against the whole set, because an alias has to be unique across forms and a
  // workflow is held to a document type that exists.
  const loaded = loadSchemaDirectory(options.schemaDir)
  const others = (loaded.set.forms ?? []).filter(
    (candidate) => candidate.alias.toLowerCase() !== form.alias.toLowerCase(),
  )
  const problems = validateForms([...others, form], {
    documentTypeAliases: new Set(loaded.set.documentTypes.map((type) => type.alias)),
  })
  if (problems.length > 0) return { ok: false, status: 'invalid', problems }

  const dir = join(options.schemaDir, 'forms')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, writeForm(form), 'utf8')
  await options.onChanged?.()
  return { ok: true, file }
}

export async function deleteForm(
  alias: string,
  options: FormFileOptions,
): Promise<FormWriteResult> {
  if (!options.writable) return readOnly()
  const file = join(options.schemaDir, 'forms', formFileName(alias))
  if (!existsSync(file))
    return {
      ok: false,
      status: 'notFound',
      problems: [
        { file: `schema/forms/${formFileName(alias)}`, path: '', message: 'is not there' },
      ],
    }
  // The entries stay: they are the business record, and deleting a definition
  // must not take what people sent it (`docs/18-forms.md`).
  rmSync(file)
  await options.onChanged?.()
  return { ok: true, file }
}
