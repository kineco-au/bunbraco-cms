/**
 * The form model, and the closed set of field types it may use.
 *
 * Here rather than in `@crombolo/schema` because both the schema parser and the
 * renderer need it, and `render` depends on `core` alone. What a form *is* is
 * domain knowledge; how it is written to a file is not.
 *
 * The built-in field and workflow types are fixed here. A server bundle adds
 * its own through `FormTypes`, which is passed to whatever parses, validates or
 * renders a form rather than held globally (`docs/forms.md`, "Types from a
 * bundle").
 */

/** A field type's name: a built-in one, or one a wired bundle provides. */
export type FormFieldType = string

export type BuiltInFormFieldType =
  | 'shortAnswer'
  | 'longAnswer'
  | 'email'
  | 'number'
  | 'date'
  | 'checkbox'
  | 'dropdown'
  | 'singleChoice'
  | 'multipleChoice'
  | 'fileUpload'
  | 'dataConsent'
  | 'titleAndDescription'
  | 'richText'
  | 'hidden'

/** How a submitted value is stored, which decides how an entry reads it back. */
export type FormValueKind = 'string' | 'strings' | 'number' | 'boolean' | 'files' | 'none'

/** What a declared setting holds, which is also the editor the designer draws for it. */
export type FormSettingKind = 'text' | 'number' | 'boolean' | 'list'

export type FormSettingValue = string | number | boolean | string[]

/**
 * One setting a type accepts. For a built-in type `key` is the field's own
 * property; for a bundle's type the value lives in the field's `settings`.
 */
export interface FormSettingDeclaration {
  key: string
  label: string
  kind: FormSettingKind
  required?: boolean
  description?: string
}

export interface FormFieldTypeInfo {
  type: FormFieldType
  label: string
  stores: FormValueKind
  /** Whether a choice list (`values`) applies, and is required. */
  choices: boolean
  /**
   * Collects nothing: a caption and some text on the page. Never mandatory,
   * never in an export, and never a condition's subject.
   */
  presentational: boolean
  /** The settings this type accepts beyond the ones every field has. */
  settings: readonly FormFieldSetting[]
  /** The same, as the designer edits them; a bundle's type declares only these. */
  declared: readonly FormSettingDeclaration[]
  /** The wired bundle that provides it; absent for a built-in type. */
  bundle?: string
  /** A check of a submitted value beyond its kind's: a message when it is wrong. */
  validate?(
    values: readonly string[],
    settings: Readonly<Record<string, FormSettingValue>>,
  ): string | undefined
}

export type FormFieldSetting =
  | 'placeholder'
  | 'maxlength'
  | 'rows'
  | 'min'
  | 'max'
  | 'step'
  | 'accept'
  | 'max-size-kb'
  | 'content'
  | 'default-value'
  | 'multiple'

const TEXTUAL = ['placeholder', 'maxlength', 'default-value'] as const

/** How the designer edits each built-in setting, by its file key. */
const SETTING_DECLARATIONS: Record<FormFieldSetting, FormSettingDeclaration> = {
  placeholder: { key: 'placeholder', label: 'Placeholder', kind: 'text' },
  maxlength: { key: 'maxlength', label: 'Maximum length', kind: 'number' },
  rows: { key: 'rows', label: 'Rows', kind: 'number' },
  min: { key: 'min', label: 'Minimum', kind: 'number' },
  max: { key: 'max', label: 'Maximum', kind: 'number' },
  step: { key: 'step', label: 'Step', kind: 'number' },
  accept: { key: 'accept', label: 'Accepted file types', kind: 'list' },
  'max-size-kb': { key: 'maxSizeKb', label: 'Largest file (KB)', kind: 'number' },
  content: { key: 'content', label: 'Content', kind: 'text' },
  'default-value': { key: 'defaultValue', label: 'Default value', kind: 'text' },
  multiple: { key: 'multiple', label: 'Allow several files', kind: 'boolean' },
}

type BuiltInInfo = Omit<FormFieldTypeInfo, 'declared' | 'type'> & { type: BuiltInFormFieldType }

const BUILT_IN_INFO: readonly BuiltInInfo[] = [
  {
    type: 'shortAnswer',
    label: 'Short answer',
    stores: 'string',
    choices: false,
    presentational: false,
    settings: TEXTUAL,
  },
  {
    type: 'longAnswer',
    label: 'Long answer',
    stores: 'string',
    choices: false,
    presentational: false,
    settings: [...TEXTUAL, 'rows'],
  },
  {
    type: 'email',
    label: 'Email address',
    stores: 'string',
    choices: false,
    presentational: false,
    settings: TEXTUAL,
  },
  {
    type: 'number',
    label: 'Number',
    stores: 'number',
    choices: false,
    presentational: false,
    settings: ['placeholder', 'min', 'max', 'step', 'default-value'],
  },
  {
    type: 'date',
    label: 'Date',
    stores: 'string',
    choices: false,
    presentational: false,
    settings: ['min', 'max', 'default-value'],
  },
  {
    type: 'checkbox',
    label: 'Checkbox',
    stores: 'boolean',
    choices: false,
    presentational: false,
    settings: ['default-value'],
  },
  {
    type: 'dropdown',
    label: 'Dropdown',
    stores: 'string',
    choices: true,
    presentational: false,
    settings: ['default-value'],
  },
  {
    type: 'singleChoice',
    label: 'Single choice',
    stores: 'string',
    choices: true,
    presentational: false,
    settings: ['default-value'],
  },
  {
    type: 'multipleChoice',
    label: 'Multiple choice',
    stores: 'strings',
    choices: true,
    presentational: false,
    settings: [],
  },
  {
    type: 'fileUpload',
    label: 'File upload',
    stores: 'files',
    choices: false,
    presentational: false,
    settings: ['accept', 'max-size-kb', 'multiple'],
  },
  {
    // Mandatory by default: a consent field that can be skipped is not consent.
    type: 'dataConsent',
    label: 'Data consent',
    stores: 'boolean',
    choices: false,
    presentational: false,
    settings: [],
  },
  {
    type: 'titleAndDescription',
    label: 'Title and description',
    stores: 'none',
    choices: false,
    presentational: true,
    settings: ['content'],
  },
  {
    type: 'richText',
    label: 'Rich text',
    stores: 'none',
    choices: false,
    presentational: true,
    settings: ['content'],
  },
  {
    type: 'hidden',
    label: 'Hidden',
    stores: 'string',
    choices: false,
    presentational: false,
    settings: ['default-value'],
  },
]

export const FORM_FIELD_TYPES: readonly FormFieldTypeInfo[] = BUILT_IN_INFO.map((info) => ({
  ...info,
  declared: info.settings.map((setting) => SETTING_DECLARATIONS[setting]),
}))

export const FORM_FIELD_TYPE_NAMES: readonly string[] = FORM_FIELD_TYPES.map((info) => info.type)

/** Password is absent on purpose: a form that collects one should not exist. */
export type FormConditionOperator =
  | 'is'
  | 'isNot'
  | 'contains'
  | 'doesNotContain'
  | 'startsWith'
  | 'endsWith'
  | 'greaterThan'
  | 'lessThan'
  | 'isEmpty'
  | 'isNotEmpty'

export const FORM_CONDITION_OPERATORS: readonly FormConditionOperator[] = [
  'is',
  'isNot',
  'contains',
  'doesNotContain',
  'startsWith',
  'endsWith',
  'greaterThan',
  'lessThan',
  'isEmpty',
  'isNotEmpty',
]

/** The two operators that take no value, because the value is the emptiness. */
export const VALUELESS_OPERATORS: readonly FormConditionOperator[] = ['isEmpty', 'isNotEmpty']

export interface FormConditionRule {
  /** Another field's alias, which must appear before this one. */
  field: string
  operator: FormConditionOperator
  value?: string
}

export interface FormCondition {
  action: 'show' | 'hide'
  match: 'all' | 'any'
  rules: FormConditionRule[]
}

export interface SchemaFormField {
  key?: string
  alias: string
  type: FormFieldType
  /** A bundle type's own settings, as it declares them; never set on a built-in type. */
  settings?: Record<string, FormSettingValue>
  caption: string
  helpText?: string
  mandatory: boolean
  mandatoryMessage?: string
  /** A regular expression the value must match, and what to say when it does not. */
  pattern?: string
  patternMessage?: string
  /** Hidden from anyone without the sensitive-data permission, in the API and in exports. */
  sensitive: boolean
  cssClass?: string
  autocomplete?: string
  /** A choice list, for the types that take one. */
  values: string[]
  /** Where the choice list comes from instead, kept once rather than in every form. */
  source?: ChoiceSource
  /**
   * The options a source resolved to, filled in at render and at submit; never
   * read from or written to the file.
   */
  options?: ChoiceOption[]
  placeholder?: string
  defaultValue?: string
  content?: string
  maxlength?: number
  rows?: number
  min?: number
  max?: number
  step?: number
  accept: string[]
  maxSizeKb?: number
  multiple?: boolean
  condition?: FormCondition
}

/** The kinds of list a choice field can draw its options from. */
export const CHOICE_SOURCE_KINDS = ['content', 'dictionary'] as const

export type ChoiceSourceKind = (typeof CHOICE_SOURCE_KINDS)[number]

/**
 * A choice list kept somewhere else: the children of a content node (by key), or
 * the children of a dictionary item (by name). docs/forms.md, "Choices from a source".
 */
export interface ChoiceSource {
  kind: ChoiceSourceKind
  parent: string
}

/** One option: what is stored when it is chosen, and what a visitor sees. */
export interface ChoiceOption {
  value: string
  label: string
}

/** The options a choice field offers: its source's, once resolved, or its own values. */
export function choiceOptions(field: SchemaFormField): ChoiceOption[] {
  if (field.options) return field.options
  if (field.source) return []
  return field.values.map((value) => ({ value, label: value }))
}

/** The form with every source-backed field's options filled in by `resolve`. */
export function withResolvedChoices(
  form: SchemaForm,
  resolve: (source: ChoiceSource) => ChoiceOption[],
): SchemaForm {
  if (!allFormFields(form).some((field) => field.source)) return form
  return {
    ...form,
    pages: form.pages.map((page) => ({
      ...page,
      groups: page.groups.map((group) => ({
        ...group,
        fields: group.fields.map((field) =>
          field.source ? { ...field, options: resolve(field.source) } : field,
        ),
      })),
    })),
  }
}

export interface SchemaFormGroup {
  caption?: string
  /** A simple column count; the renderer lays the fields out across it. */
  columns: number
  fields: SchemaFormField[]
  condition?: FormCondition
}

export interface SchemaFormPage {
  caption?: string
  groups: SchemaFormGroup[]
  condition?: FormCondition
}

/** A workflow type's name: a built-in one, or one a wired bundle provides. */
export type FormWorkflowType = string

export type BuiltInFormWorkflowType = 'sendEmail' | 'saveAsContent' | 'sendToUrl'

export const FORM_WORKFLOW_TYPES: readonly BuiltInFormWorkflowType[] = [
  'sendEmail',
  'saveAsContent',
  'sendToUrl',
]

export interface FormWorkflowTypeInfo {
  type: FormWorkflowType
  label: string
  /** A bundle type's settings; the built-in three are checked by the validator's own table. */
  declared: readonly FormSettingDeclaration[]
  bundle?: string
  /** A check across its settings beyond their declarations: a message when they are wrong. */
  validate?(settings: Readonly<Record<string, unknown>>): string | undefined
}

/** The field and workflow types a site can use: the built-ins and its wired bundles'. */
export interface FormTypes {
  fields: ReadonlyMap<string, FormFieldTypeInfo>
  workflows: ReadonlyMap<string, FormWorkflowTypeInfo>
}

const BUILT_IN_WORKFLOW_LABELS: Record<BuiltInFormWorkflowType, string> = {
  sendEmail: 'Send an e-mail',
  saveAsContent: 'Save as content',
  sendToUrl: 'Send to a URL',
}

export const BUILT_IN_FORM_TYPES: FormTypes = {
  fields: new Map(FORM_FIELD_TYPES.map((info) => [info.type, info])),
  workflows: new Map(
    FORM_WORKFLOW_TYPES.map((type) => [
      type,
      { type, label: BUILT_IN_WORKFLOW_LABELS[type], declared: [] },
    ]),
  ),
}

export function isBuiltInFieldType(type: string): type is BuiltInFormFieldType {
  return FORM_FIELD_TYPE_NAMES.includes(type)
}

export function isBuiltInWorkflowType(type: string): type is BuiltInFormWorkflowType {
  return (FORM_WORKFLOW_TYPES as readonly string[]).includes(type)
}

export function formFieldType(
  type: string,
  types: FormTypes = BUILT_IN_FORM_TYPES,
): FormFieldTypeInfo | undefined {
  return types.fields.get(type)
}

const TYPE_NAME = /^[a-z][A-Za-z0-9]{1,31}$/

/**
 * The built-ins plus a bundle's types, or why they cannot be added: a name that
 * is not camelCase, one already taken, or a setting declared twice. Pure.
 */
export function formTypesWith(
  base: FormTypes,
  bundle: string,
  added: {
    fields?: readonly Omit<FormFieldTypeInfo, 'bundle' | 'settings'>[]
    workflows?: readonly Omit<FormWorkflowTypeInfo, 'bundle'>[]
  },
): { types: FormTypes; problems: string[] } {
  const problems: string[] = []
  const fields = new Map(base.fields)
  const workflows = new Map(base.workflows)
  const check = (
    kind: 'field' | 'workflow',
    type: string,
    taken: ReadonlyMap<string, { bundle?: string }>,
    declared: readonly FormSettingDeclaration[],
  ): boolean => {
    const owner = taken.get(type)
    if (!TYPE_NAME.test(type)) {
      problems.push(
        `The bundle "${bundle}" names a ${kind} type "${type}", which is not a camelCase name of 2–32 letters and digits.`,
      )
      return false
    }
    if (owner) {
      problems.push(
        `The bundle "${bundle}" adds the ${kind} type "${type}", which ${owner.bundle ? `the bundle "${owner.bundle}" already provides` : 'is built in'}.`,
      )
      return false
    }
    const keys = new Set<string>()
    for (const setting of declared) {
      if (keys.has(setting.key))
        problems.push(
          `The bundle "${bundle}"'s ${kind} type "${type}" declares the setting "${setting.key}" twice.`,
        )
      keys.add(setting.key)
    }
    return true
  }
  for (const field of added.fields ?? [])
    if (check('field', field.type, fields, field.declared))
      fields.set(field.type, { ...field, settings: [], bundle })
  for (const workflow of added.workflows ?? [])
    if (check('workflow', workflow.type, workflows, workflow.declared))
      workflows.set(workflow.type, { ...workflow, bundle })
  return { types: { fields, workflows }, problems }
}

/**
 * Why `settings` does not satisfy `declared`: a setting it does not declare, a
 * required one missing, or a value of the wrong kind. Pure; `where` prefixes
 * each message.
 */
export function settingsProblems(
  declared: readonly FormSettingDeclaration[],
  settings: Readonly<Record<string, unknown>>,
  where: string,
): string[] {
  const problems: string[] = []
  const known = new Map(declared.map((setting) => [setting.key, setting]))
  for (const key of Object.keys(settings))
    if (!known.has(key))
      problems.push(
        `${where} has the setting "${key}", which it does not take${known.size > 0 ? `; it takes ${[...known.keys()].join(', ')}` : ''}.`,
      )
  for (const setting of declared) {
    const value = settings[setting.key]
    if (value === undefined || value === '') {
      if (setting.required) problems.push(`${where} needs the setting "${setting.key}".`)
      continue
    }
    const fits =
      setting.kind === 'text'
        ? typeof value === 'string'
        : setting.kind === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : setting.kind === 'boolean'
            ? typeof value === 'boolean'
            : Array.isArray(value) && value.every((item) => typeof item === 'string')
    if (!fits)
      problems.push(
        `${where} has the setting "${setting.key}" as ${JSON.stringify(value)}, which is not ${KIND_WORDS[setting.kind]}.`,
      )
  }
  return problems
}

const KIND_WORDS: Record<FormSettingKind, string> = {
  text: 'text',
  number: 'a number',
  boolean: 'true or false',
  list: 'a list of text',
}

/** The state transition a workflow runs on. */
export type FormWorkflowTrigger = 'submit' | 'approve'

export interface SchemaFormWorkflow {
  key?: string
  type: FormWorkflowType
  name: string
  on: FormWorkflowTrigger
  /** Per-type, so it is checked by the validator rather than by the shape. */
  settings: Record<string, unknown>
}

export interface SchemaForm {
  key?: string
  alias: string
  name: string
  notes?: string
  /** Whether a submission is kept. Off makes the form fire workflows and store nothing. */
  storeEntries: boolean
  /** Entries wait as `submitted` until someone approves them. */
  requiresApproval: boolean
  /**
   * Shows one page at a time in the browser, checking each on the server before
   * the next. Without JavaScript every page shows at once, as when it is off.
   */
  stepPages?: boolean
  submitLabel?: string
  nextLabel?: string
  previousLabel?: string
  /** Shown in place of the form after a submission, when there is no redirect. */
  messageOnSubmit?: string
  /** A document key to send the visitor to instead of showing a message. */
  redirectTo?: string
  /** A theme directory under `components/Forms/`. */
  theme?: string
  /** A field real visitors never fill; a filled one is marked as spam. */
  honeypot: boolean
  /** A submission faster than this is marked as spam. */
  minimumSubmitSeconds?: number
  /** Refused once this many entries exist, for a form with a hard cap. */
  maxEntries?: number
  since?: string
  pages: SchemaFormPage[]
  workflows: SchemaFormWorkflow[]
}

/** Every field in a form, in the order a visitor meets them. */
export function allFormFields(form: SchemaForm): SchemaFormField[] {
  return form.pages.flatMap((page) => page.groups.flatMap((group) => group.fields))
}

/** Every field that stores something, which is what an entry and an export carry. */
export function storingFormFields(
  form: SchemaForm,
  types: FormTypes = BUILT_IN_FORM_TYPES,
): SchemaFormField[] {
  return allFormFields(form).filter((field) => formFieldType(field.type, types)?.stores !== 'none')
}
