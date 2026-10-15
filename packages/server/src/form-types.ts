/**
 * The public contract for a form field type or workflow type a server bundle
 * adds (story 095, `docs/forms.md`, "Types from a bundle"). A bundle exports
 * definitions; `collectFormTypes` turns the wired bundles' into the registry
 * the parser, validator, renderer and runner are handed.
 */
import {
  BUILT_IN_FORM_TYPES,
  type FormSettingDeclaration,
  type FormSettingValue,
  type FormTypes,
  formTypesWith,
} from '@crombolo/core'
import type { FormFieldRenderer } from '@crombolo/render'
import type { EmailMessage, EmailResult } from './email.ts'

export type { FormFieldRenderer, FormFieldRenderProps } from '@crombolo/render'
export type { FormSettingDeclaration, FormSettingValue }

/** A field type: what its settings are, how its value is checked, and how it draws. */
export interface FormFieldTypeDefinition {
  /** camelCase, unique across the built-ins and every wired bundle. */
  type: string
  /** What the designer's type list calls it. */
  label: string
  /**
   * Which built-in kind it stores as, which decides coercion and the entry: a
   * value is always a list of strings, so entries, exports and workflows read it
   * as they read any other field. `none` collects nothing, as a heading does.
   */
  stores: 'string' | 'strings' | 'number' | 'boolean' | 'none'
  /** Whether it takes a choice list (`values` or a `source`). */
  choices?: boolean
  /** Edited in the designer from these, and held to them in the file. */
  settings?: readonly FormSettingDeclaration[]
  /** After the kind's own checks: a message when the value is wrong. */
  validate?(
    values: readonly string[],
    settings: Readonly<Record<string, FormSettingValue>>,
  ): string | undefined
  /** The control, in the form's markup. The label, help and error are drawn around it. */
  render: FormFieldRenderer
}

/** What a bundle's workflow handler is given: the submission and narrow capabilities, no database. */
export interface FormWorkflowRunContext {
  form: { key: string; alias: string; name: string }
  /** Each stored field's values, by alias; with labels where a field's choices have them. */
  values: Readonly<Record<string, readonly string[]>>
  labels: Readonly<Record<string, readonly string[]>>
  entryId: string | null
  settings: Readonly<Record<string, unknown>>
  /** Which attempt this is, from 1; the queue makes up to five. */
  attempt: number
  /** Aborted with `signal` unless the call passes its own. */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
  /** Answers `ok: false` when the site has no e-mail configured. */
  sendEmail(message: EmailMessage): Promise<EmailResult>
  log: {
    info(message: string, properties?: Record<string, unknown>): void
    warn(message: string, properties?: Record<string, unknown>): void
    error(message: string, properties?: Record<string, unknown>): void
  }
  /** Aborted when the run has taken too long. */
  signal: AbortSignal
}

/**
 * Done, or failed: `retry` true tries again on the built-ins' backoff (1, 5, 15
 * and 60 minutes, five attempts in all), false gives up at once. A throw counts
 * as a failure worth retrying.
 */
export type FormWorkflowRunResult =
  | { ok: true; detail?: string }
  | { ok: false; error: string; retry: boolean }

export interface FormWorkflowTypeDefinition {
  type: string
  label: string
  settings?: readonly FormSettingDeclaration[]
  /** Across its settings, after the declarations pass: a message when they are wrong. */
  validate?(settings: Readonly<Record<string, unknown>>): string | undefined
  run(context: FormWorkflowRunContext): FormWorkflowRunResult | Promise<FormWorkflowRunResult>
}

/** What a server bundle's `forms` adds. */
export interface BundleForms {
  fields?: readonly FormFieldTypeDefinition[]
  workflows?: readonly FormWorkflowTypeDefinition[]
}

export interface CollectedFormTypes {
  types: FormTypes
  renderers: ReadonlyMap<string, FormFieldRenderer>
  workflows: ReadonlyMap<string, FormWorkflowTypeDefinition>
  problems: string[]
}

const STORES = new Set(['string', 'strings', 'number', 'boolean', 'none'])

/** Every wired bundle's form types, merged over the built-ins, or why they cannot be. Pure. */
export function collectFormTypes(
  bundles: readonly { id: string; forms?: BundleForms }[],
): CollectedFormTypes {
  let types = BUILT_IN_FORM_TYPES
  const renderers = new Map<string, FormFieldRenderer>()
  const workflows = new Map<string, FormWorkflowTypeDefinition>()
  const problems: string[] = []
  for (const bundle of bundles) {
    const forms = bundle.forms
    if (!forms) continue
    const fields = (forms.fields ?? []).filter((field) => {
      if (STORES.has(field.stores) && typeof field.render === 'function') return true
      problems.push(
        `The bundle "${bundle.id}"'s field type "${field.type}" needs a render function and stores of string, strings, number, boolean or none.`,
      )
      return false
    })
    const added = formTypesWith(types, bundle.id, {
      fields: fields.map((field) => ({
        type: field.type,
        label: field.label,
        stores: field.stores,
        choices: field.choices ?? false,
        presentational: field.stores === 'none',
        declared: field.settings ?? [],
        validate: field.validate,
      })),
      workflows: (forms.workflows ?? []).map((workflow) => ({
        type: workflow.type,
        label: workflow.label,
        declared: workflow.settings ?? [],
        validate: workflow.validate,
      })),
    })
    problems.push(...added.problems)
    types = added.types
    for (const field of fields)
      if (types.fields.get(field.type)?.bundle === bundle.id)
        renderers.set(field.type, field.render)
    for (const workflow of forms.workflows ?? [])
      if (types.workflows.get(workflow.type)?.bundle === bundle.id)
        workflows.set(workflow.type, workflow)
  }
  return { types, renderers, workflows, problems }
}

const collected = new WeakMap<readonly unknown[], CollectedFormTypes>()
const NONE: readonly { id: string; forms?: BundleForms }[] = []

/** The form types a site's wired bundles add, worked out once per bundle list. */
export function formTypesOf(config: {
  bundles?: readonly { id: string; forms?: BundleForms }[]
}): CollectedFormTypes {
  const bundles = config.bundles ?? NONE
  const known = collected.get(bundles)
  if (known) return known
  const result = collectFormTypes(bundles)
  collected.set(bundles, result)
  return result
}

/** As `formTypesOf`, the registry alone: what schema loading and validation take. */
export const formTypesFor = (config: {
  bundles?: readonly { id: string; forms?: BundleForms }[]
}): FormTypes => formTypesOf(config).types

/** The types as the designer reads them: what each is called, stores, and which settings it edits. */
export function describeFormTypes(types: FormTypes) {
  return {
    fields: [...types.fields.values()].map((info) => ({
      type: info.type,
      label: info.label,
      stores: info.stores,
      choices: info.choices,
      presentational: info.presentational,
      settings: info.declared,
      builtIn: info.bundle === undefined,
    })),
    workflows: [...types.workflows.values()].map((info) => ({
      type: info.type,
      label: info.label,
      settings: info.declared,
      builtIn: info.bundle === undefined,
    })),
  }
}
