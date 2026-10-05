/**
 * The form model, and the closed set of field types it may use.
 *
 * A form definition is structure, so it is a file like every other type
 * (`docs/18-forms.md`). Field types are an internal registry rather than an
 * extension point: the TOML vocabulary, the validator, the renderer and the
 * entry value shape all have to agree, and freezing that contract before
 * anything has stressed it would be a promise made too early.
 */

export type FormFieldType =
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

export const FORM_FIELD_TYPES: readonly FormFieldTypeInfo[] = [
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

const BY_TYPE = new Map(FORM_FIELD_TYPES.map((info) => [info.type, info]))

export function formFieldType(type: string): FormFieldTypeInfo | undefined {
  return BY_TYPE.get(type as FormFieldType)
}

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

export type FormWorkflowType = 'sendEmail' | 'saveAsContent' | 'sendToUrl'

export const FORM_WORKFLOW_TYPES: readonly FormWorkflowType[] = [
  'sendEmail',
  'saveAsContent',
  'sendToUrl',
]

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
export function storingFormFields(form: SchemaForm): SchemaFormField[] {
  return allFormFields(form).filter((field) => formFieldType(field.type)?.stores !== 'none')
}
