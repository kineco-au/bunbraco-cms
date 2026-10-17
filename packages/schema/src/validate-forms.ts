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
  BUILT_IN_FORM_TYPES,
  CHOICE_SOURCE_KINDS,
  type FormCondition,
  type FormTypes,
  formFieldType,
  type SchemaForm,
  type SchemaFormField,
  settingsProblems,
  VALUELESS_OPERATORS,
} from '@crombolo/core'
import type { SchemaProblem } from './model.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  /** Content type aliases, so `saveAsContent` can be held to a real one. */
  contentTypeAliases?: ReadonlySet<string>
  /** The field and workflow types in play: the built-ins, and the wired bundles'. */
  types?: FormTypes
  /**
   * The components that exist, by alias: a content type's templates and a Send
   * email workflow's `template` are held to them. Omit to skip those checks.
   */
  componentAliases?: ReadonlySet<string>
}

/** A component alias is a path under `components/`: folders and names, nothing that climbs. */
const COMPONENT_ALIAS = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/

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

    validateFields(form, file, options.types ?? BUILT_IN_FORM_TYPES, add)
    validateWorkflows(form, file, options, add)
  }
  return problems
}

type Add = (file: string, path: string, message: string) => void

function validateFields(form: SchemaForm, file: string, types: FormTypes, add: Add): void {
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
        const info = formFieldType(field.type, types)

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
          const { source } = field
          if (source && field.values.length > 0)
            add(
              file,
              `${path}.source`,
              'a field takes its choices from values or from a source, not both',
            )
          if (source && !info.choices)
            add(file, `${path}.source`, `a ${field.type} field has nothing to choose from`)
          if (source && info.choices) {
            if (!CHOICE_SOURCE_KINDS.includes(source.kind))
              add(
                file,
                `${path}.source.kind`,
                `"${source.kind}" is not a kind of source; expected one of ${CHOICE_SOURCE_KINDS.join(', ')}`,
              )
            if (source.kind === 'content' && !UUID.test(source.parent))
              add(file, `${path}.source.parent`, 'a content source names its parent page by key')
            if (source.kind === 'dictionary' && source.parent.trim() === '')
              add(
                file,
                `${path}.source.parent`,
                'a dictionary source names its parent dictionary item',
              )
          }
          if (info.choices && !source && field.values.length === 0)
            add(file, `${path}.values`, `a ${field.type} field needs values to choose from`)
          if (!info.choices && field.values.length > 0)
            add(file, `${path}.values`, `a ${field.type} field has nothing to choose from`)
          // A default has to be one of the choices, or the form opens invalid. A
          // source's choices are only known once it is resolved, so not checked here.
          if (
            info.choices &&
            !source &&
            field.defaultValue !== undefined &&
            !field.values.includes(field.defaultValue)
          )
            add(file, `${path}.default-value`, `"${field.defaultValue}" is not one of the values`)

          for (const [setting, model] of Object.entries(SETTING_OF)) {
            if (!set(field, model)) continue
            if (!info.settings.includes(setting as never))
              add(file, `${path}.${setting}`, `does not apply to a ${field.type} field`)
          }
          // A built-in type's settings are keys of the field; only a bundle's
          // type has a settings table, held to what it declares.
          if (!info.bundle && field.settings !== undefined)
            add(
              file,
              `${path}.settings`,
              `a ${field.type} field is built in and takes no settings table; its settings are keys of the field`,
            )
          if (info.bundle)
            for (const message of settingsProblems(
              info.declared,
              field.settings ?? {},
              `a ${field.type} field`,
            ))
              add(file, `${path}.settings`, message)
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
          validateCondition(field.condition, fields, earlier, file, `${path}.condition`, types, add)
        earlier.add(field.alias.toLowerCase())
        index++
      }
      if (group.condition)
        validateCondition(
          group.condition,
          fields,
          earlier,
          file,
          'page.group.condition',
          types,
          add,
        )
    }
    if (page.condition)
      validateCondition(page.condition, fields, earlier, file, 'page.condition', types, add)
  }

  if (fields.length === 0) add(file, 'page.group.field', 'a form needs at least one field')
  else if (fields.every((field) => formFieldType(field.type, types)?.presentational))
    add(file, 'page.group.field', 'every field is presentational, so the form collects nothing')
}

function validateCondition(
  condition: FormCondition,
  fields: readonly SchemaFormField[],
  earlier: ReadonlySet<string>,
  file: string,
  path: string,
  types: FormTypes,
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
    if (formFieldType(target.type, types)?.presentational)
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
    optional: [
      'cc',
      'bcc',
      'reply-to',
      'from',
      'body',
      'template',
      'attach-uploads',
      'include-sensitive',
    ],
  },
  saveAsContent: {
    required: ['content-type', 'parent'],
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

    const bundled = (options.types ?? BUILT_IN_FORM_TYPES).workflows.get(workflow.type)
    if (bundled?.bundle) {
      const where = `a ${workflow.type} workflow`
      const declared = settingsProblems(bundled.declared, workflow.settings, where)
      for (const message of declared) add(file, `${path}.settings`, message)
      const own = declared.length === 0 ? bundled.validate?.(workflow.settings) : undefined
      if (own) add(file, `${path}.settings`, own)
      continue
    }
    const rules = WORKFLOW_SETTINGS[workflow.type]
    if (!rules) continue
    const allowed = new Set([...rules.required, ...rules.optional])
    for (const key of rules.required)
      if (workflow.settings[key] === undefined) add(file, `${path}.settings.${key}`, 'is required')
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
      const alias = workflow.settings['content-type']
      if (
        options.contentTypeAliases &&
        typeof alias === 'string' &&
        !options.contentTypeAliases.has(alias)
      )
        add(file, `${path}.settings.content-type`, `unknown content type "${alias}"`)
      validateFieldMap(form, workflow.settings.map, file, `${path}.settings.map`, add)
      const nameField = workflow.settings['name-field']
      if (typeof nameField === 'string' && !hasField(form, nameField))
        add(file, `${path}.settings.name-field`, `unknown field "${nameField}"`)
    }
    if (workflow.type === 'sendEmail') {
      const template = workflow.settings.template
      if (template !== undefined) {
        if (typeof template !== 'string' || !COMPONENT_ALIAS.test(template))
          add(
            file,
            `${path}.settings.template`,
            'expected the alias of a component: its path under components/, without .tsx',
          )
        else if (options.componentAliases && !options.componentAliases.has(template))
          add(file, `${path}.settings.template`, `there is no components/${template}.tsx`)
        if (workflow.settings.body !== undefined)
          add(
            file,
            `${path}.settings.body`,
            'the e-mail template writes the body, so a workflow with a template takes no body',
          )
      }
      for (const key of ['attach-uploads', 'include-sensitive'])
        if (workflow.settings[key] !== undefined && typeof workflow.settings[key] !== 'boolean')
          add(file, `${path}.settings.${key}`, 'expected true or false')
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
