/**
 * Whole-set validation for forms: everything that cannot be checked while
 * parsing one file, plus the per-type settings rules.
 *
 * Every problem is reported rather than the first, because someone fixing a
 * form wants the whole list. Separate from `validate.ts` so the form rules can
 * be read on their own.
 */
import {
  allFormFields,
  type FormCondition,
  formFieldType,
  type SchemaForm,
  type SchemaFormField,
  VALUELESS_OPERATORS,
} from '@bunbraco/core'
import type { SchemaProblem } from './model.ts'

const VERSION = /^\d+(\.\d+)*$/
const ALIAS = /^[a-zA-Z][a-zA-Z0-9]*$/

/** Which model field a per-type setting lives on, for the "does not apply" check. */
const SETTING_OF: Record<string, keyof SchemaFormField> = {
  placeholder: 'placeholder',
  maxlength: 'maxlength',
  rows: 'rows',
  min: 'min',
  max: 'max',
  step: 'step',
  accept: 'accept',
  'max-size-kb': 'maxSizeKb',
  content: 'content',
  'default-value': 'defaultValue',
  multiple: 'multiple',
}

const set = (field: SchemaFormField, model: keyof SchemaFormField): boolean => {
  const value = field[model]
  if (value === undefined) return false
  return !(Array.isArray(value) && value.length === 0)
}

export interface ValidateFormsOptions {
  /** Theme directories that exist under `components/Forms/`; omit to skip the check. */
  formThemes?: ReadonlySet<string>
  /** Document type aliases, so `saveAsContent` can be held to a real one. */
  documentTypeAliases?: ReadonlySet<string>
}

export function validateForms(
  forms: readonly SchemaForm[],
  options: ValidateFormsOptions = {},
): SchemaProblem[] {
  const problems: SchemaProblem[] = []
  const add = (file: string, path: string, message: string) =>
    problems.push({ file, path, message })

  const aliases = new Set<string>()
  const keys = new Map<string, string>()

  for (const form of forms) {
    const file = `schema/forms/${form.alias}`

    if (!ALIAS.test(form.alias))
      add(file, 'form.alias', `"${form.alias}" must start with a letter and be alphanumeric`)
    if (aliases.has(form.alias.toLowerCase()))
      add(file, 'form.alias', `duplicate form alias "${form.alias}"`)
    aliases.add(form.alias.toLowerCase())

    if (form.key) {
      const seen = keys.get(form.key.toLowerCase())
      if (seen) add(file, 'form.key', `key "${form.key}" is already used by "${seen}"`)
      keys.set(form.key.toLowerCase(), form.alias)
    }
    if (form.since && !VERSION.test(form.since))
      add(file, 'form.since', `"${form.since}" is not a dotted number`)

    if (form.pages.length === 0) add(file, 'page', 'a form needs at least one page')
    if (options.formThemes && form.theme && !options.formThemes.has(form.theme))
      add(file, 'form.theme', `no theme directory "components/Forms/${form.theme}"`)
    if (form.maxEntries !== undefined && form.maxEntries < 1)
      add(file, 'form.max-entries', 'must be at least 1')
    if (form.minimumSubmitSeconds !== undefined && form.minimumSubmitSeconds < 0)
      add(file, 'form.minimum-submit-seconds', 'cannot be negative')
    // A form that stores nothing and does nothing has no effect at all, and is
    // much more likely to be a mistake than an intention.
    if (!form.storeEntries && form.workflows.length === 0)
      add(
        file,
        'form.store-entries',
        'a form that stores no entries needs at least one workflow, or a submission does nothing',
      )
    // Approval gates the entry, so there is nothing to approve without one.
    if (form.requiresApproval && !form.storeEntries)
      add(
        file,
        'form.requires-approval',
        'requires store-entries, since there is no entry to approve',
      )

    validateFields(form, file, add)
    validateWorkflows(form, file, options, add)
  }
  return problems
}

type Add = (file: string, path: string, message: string) => void

function validateFields(form: SchemaForm, file: string, add: Add): void {
  const fields = allFormFields(form)
  const seen = new Set<string>()
  /** Aliases usable by a condition: a field may only look at earlier ones. */
  const earlier = new Set<string>()

  let index = 0
  for (const page of form.pages) {
    if (page.groups.length === 0)
      add(file, `page[${form.pages.indexOf(page)}].group`, 'a page needs at least one group')
    for (const group of page.groups) {
      if (group.columns < 1 || group.columns > 4 || !Number.isInteger(group.columns))
        add(file, 'page.group.columns', `${group.columns} is not a column count between 1 and 4`)
      for (const field of group.fields) {
        const path = `page.group.field[${index}]`
        const info = formFieldType(field.type)

        if (!ALIAS.test(field.alias))
          add(
            file,
            `${path}.alias`,
            `"${field.alias}" must start with a letter and be alphanumeric`,
          )
        if (seen.has(field.alias.toLowerCase()))
          add(file, `${path}.alias`, `duplicate field alias "${field.alias}"`)
        seen.add(field.alias.toLowerCase())

        if (info) {
          if (info.presentational) {
            if (field.mandatory)
              add(
                file,
                `${path}.mandatory`,
                `a ${field.type} field collects nothing, so it cannot be mandatory`,
              )
            if (field.sensitive)
              add(
                file,
                `${path}.sensitive`,
                `a ${field.type} field collects nothing, so it cannot be sensitive`,
              )
          }
          if (info.choices && field.values.length === 0)
            add(file, `${path}.values`, `a ${field.type} field needs values to choose from`)
          if (!info.choices && field.values.length > 0)
            add(file, `${path}.values`, `a ${field.type} field has nothing to choose from`)
          // A default has to be one of the choices, or the form opens invalid.
          if (
            info.choices &&
            field.defaultValue !== undefined &&
            !field.values.includes(field.defaultValue)
          )
            add(file, `${path}.default-value`, `"${field.defaultValue}" is not one of the values`)

          for (const [setting, model] of Object.entries(SETTING_OF)) {
            if (!set(field, model)) continue
            if (!info.settings.includes(setting as never))
              add(file, `${path}.${setting}`, `does not apply to a ${field.type} field`)
          }
        }

        if (field.pattern !== undefined) {
          try {
            new RegExp(field.pattern)
          } catch (error) {
            add(
              file,
              `${path}.pattern`,
              `is not a valid regular expression: ${(error as Error).message}`,
            )
          }
        }
        if (field.min !== undefined && field.max !== undefined && field.min > field.max)
          add(file, `${path}.min`, `${field.min} is greater than max ${field.max}`)
        if (field.maxSizeKb !== undefined && field.maxSizeKb < 1)
          add(file, `${path}.max-size-kb`, 'must be at least 1')

        if (field.condition)
          validateCondition(field.condition, fields, earlier, file, `${path}.condition`, add)
        earlier.add(field.alias.toLowerCase())
        index++
      }
      if (group.condition)
        validateCondition(group.condition, fields, earlier, file, 'page.group.condition', add)
    }
    if (page.condition)
      validateCondition(page.condition, fields, earlier, file, 'page.condition', add)
  }

  if (fields.length === 0) add(file, 'page.group.field', 'a form needs at least one field')
  else if (fields.every((field) => formFieldType(field.type)?.presentational))
    add(file, 'page.group.field', 'every field is presentational, so the form collects nothing')
}

function validateCondition(
  condition: FormCondition,
  fields: readonly SchemaFormField[],
  earlier: ReadonlySet<string>,
  file: string,
  path: string,
  add: Add,
): void {
  for (const [index, rule] of condition.rules.entries()) {
    const rulePath = `${path}.rule[${index}]`
    const target = fields.find((field) => field.alias.toLowerCase() === rule.field.toLowerCase())
    if (!target) {
      add(file, `${rulePath}.field`, `unknown field "${rule.field}"`)
      continue
    }
    // A condition on a later field cannot be evaluated: the visitor has not
    // reached it, so the answer would depend on which way the form is read.
    if (!earlier.has(rule.field.toLowerCase()))
      add(
        file,
        `${rulePath}.field`,
        `"${rule.field}" comes later in the form, so it has no value to compare yet`,
      )
    if (formFieldType(target.type)?.presentational)
      add(file, `${rulePath}.field`, `"${rule.field}" collects nothing, so it cannot be compared`)
    const valueless = VALUELESS_OPERATORS.includes(rule.operator)
    if (valueless && rule.value !== undefined)
      add(file, `${rulePath}.value`, `${rule.operator} takes no value`)
    if (!valueless && rule.value === undefined)
      add(file, `${rulePath}.value`, `${rule.operator} needs a value`)
    if (
      rule.value !== undefined &&
      target.values.length > 0 &&
      (rule.operator === 'is' || rule.operator === 'isNot') &&
      !target.values.includes(rule.value)
    )
      add(file, `${rulePath}.value`, `"${rule.value}" is not one of the values of "${rule.field}"`)
  }
}

/** The settings each workflow type needs, and the ones it merely allows. */
const WORKFLOW_SETTINGS: Record<string, { required: string[]; optional: string[] }> = {
  sendEmail: {
    required: ['to', 'subject'],
    // No `template`: a TSX e-mail template is not built yet, and a setting that
    // silently does nothing is worse than one that is refused by name.
    optional: ['cc', 'bcc', 'reply-to', 'from', 'body', 'attach-uploads'],
  },
  saveAsContent: {
    required: ['document-type', 'parent'],
    optional: ['publish', 'name-field', 'map'],
  },
  sendToUrl: { required: ['url'], optional: ['method', 'headers', 'include-standard-fields'] },
}

function validateWorkflows(
  form: SchemaForm,
  file: string,
  options: ValidateFormsOptions,
  add: Add,
): void {
  const names = new Set<string>()
  for (const [index, workflow] of form.workflows.entries()) {
    const path = `workflow[${index}]`
    if (names.has(workflow.name.toLowerCase()))
      add(file, `${path}.name`, `duplicate workflow name "${workflow.name}"`)
    names.add(workflow.name.toLowerCase())

    if (workflow.on === 'approve' && !form.requiresApproval)
      add(
        file,
        `${path}.on`,
        'runs on approval, but the form does not require approval so nothing ever approves it',
      )

    const rules = WORKFLOW_SETTINGS[workflow.type]
    if (!rules) continue
    const allowed = new Set([...rules.required, ...rules.optional])
    for (const key of rules.required)
      if (workflow.settings[key] === undefined)
        add(file, `${path}.settings.${key}`, `is required by a ${workflow.type} workflow`)
    for (const key of Object.keys(workflow.settings))
      if (!allowed.has(key))
        add(
          file,
          `${path}.settings.${key}`,
          `unknown setting for a ${workflow.type} workflow; expected one of ${[...allowed].sort().join(', ')}`,
        )

    if (workflow.type === 'sendToUrl') {
      const url = workflow.settings.url
      if (typeof url === 'string' && !/^https?:\/\//.test(url))
        add(file, `${path}.settings.url`, 'must be an http or https URL')
      const method = workflow.settings.method
      if (method !== undefined && method !== 'POST' && method !== 'PUT')
        add(file, `${path}.settings.method`, "expected 'POST' or 'PUT'")
    }
    if (workflow.type === 'saveAsContent') {
      const alias = workflow.settings['document-type']
      if (
        options.documentTypeAliases &&
        typeof alias === 'string' &&
        !options.documentTypeAliases.has(alias)
      )
        add(file, `${path}.settings.document-type`, `unknown document type "${alias}"`)
      validateFieldMap(form, workflow.settings.map, file, `${path}.settings.map`, add)
      const nameField = workflow.settings['name-field']
      if (typeof nameField === 'string' && !hasField(form, nameField))
        add(file, `${path}.settings.name-field`, `unknown field "${nameField}"`)
    }
    if (workflow.type === 'sendEmail') {
      const attach = workflow.settings['attach-uploads']
      if (attach === true && !allFormFields(form).some((field) => field.type === 'fileUpload'))
        add(
          file,
          `${path}.settings.attach-uploads`,
          'the form has no file upload field, so there is nothing to attach',
        )
    }
  }
}

const hasField = (form: SchemaForm, alias: string): boolean =>
  allFormFields(form).some((field) => field.alias.toLowerCase() === alias.toLowerCase())

/** `map` is field alias → property alias; the field half has to exist. */
function validateFieldMap(
  form: SchemaForm,
  map: unknown,
  file: string,
  path: string,
  add: Add,
): void {
  if (map === undefined) return
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    add(file, path, 'expected a table of field alias to property alias')
    return
  }
  for (const [field, property] of Object.entries(map as Record<string, unknown>)) {
    if (!hasField(form, field)) add(file, `${path}.${field}`, `unknown field "${field}"`)
    if (typeof property !== 'string')
      add(file, `${path}.${field}`, 'expected a property alias as a string')
  }
}
