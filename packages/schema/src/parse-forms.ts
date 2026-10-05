/**
 * TOML → a form definition. Strict in the same way as the type parser: an
 * unknown key is an error, because a misspelt one hides what someone meant.
 *
 * Separate from `parse.ts` only because a form has a deeper tree than a content
 * type and the two share nothing but the reader.
 */
import {
  FORM_CONDITION_OPERATORS,
  FORM_FIELD_TYPE_NAMES,
  FORM_WORKFLOW_TYPES,
  type FormCondition,
  type FormConditionOperator,
  type FormConditionRule,
  type FormFieldType,
  type FormWorkflowTrigger,
  type FormWorkflowType,
  formFieldType,
  type SchemaForm,
  type SchemaFormField,
  type SchemaFormGroup,
  type SchemaFormPage,
  type SchemaFormWorkflow,
} from '@bunbraco/core'
import { type ParseResult, Reader, type Toml, toml } from './reader.ts'

const FORM_KEYS = [
  'key',
  'alias',
  'name',
  'notes',
  'store-entries',
  'requires-approval',
  'submit-label',
  'next-label',
  'previous-label',
  'message-on-submit',
  'redirect-to',
  'theme',
  'honeypot',
  'minimum-submit-seconds',
  'max-entries',
  'since',
] as const

const PAGE_KEYS = ['caption', 'group', 'condition'] as const
const GROUP_KEYS = ['caption', 'columns', 'field', 'condition'] as const
const FIELD_KEYS = [
  'key',
  'alias',
  'type',
  'caption',
  'help-text',
  'mandatory',
  'mandatory-message',
  'pattern',
  'pattern-message',
  'sensitive',
  'css-class',
  'autocomplete',
  'values',
  'placeholder',
  'default-value',
  'content',
  'maxlength',
  'rows',
  'min',
  'max',
  'step',
  'accept',
  'max-size-kb',
  'multiple',
  'condition',
] as const
const CONDITION_KEYS = ['action', 'match', 'rule'] as const
const RULE_KEYS = ['field', 'operator', 'value'] as const
const WORKFLOW_KEYS = ['key', 'type', 'name', 'on', 'settings'] as const

function condition(r: Reader, value: unknown, path: string): FormCondition | undefined {
  if (value === undefined) return undefined
  const t = r.table(value, path)
  if (!t) return undefined
  r.unknown(t, CONDITION_KEYS, path)

  const action = r.str(t, 'action', path) ?? 'show'
  if (action !== 'show' && action !== 'hide')
    r.problem(`${path}.action`, "expected 'show' or 'hide'")
  const match = r.str(t, 'match', path) ?? 'all'
  if (match !== 'all' && match !== 'any') r.problem(`${path}.match`, "expected 'all' or 'any'")

  const rules: FormConditionRule[] = r.tables(t.rule, `${path}.rule`).map((rule, index) => {
    const rulePath = `${path}.rule[${index}]`
    r.unknown(rule, RULE_KEYS, rulePath)
    const operator = r.str(rule, 'operator', rulePath, true) ?? 'is'
    if (!FORM_CONDITION_OPERATORS.includes(operator as FormConditionOperator))
      r.problem(
        `${rulePath}.operator`,
        `unknown operator; expected one of ${FORM_CONDITION_OPERATORS.join(', ')}`,
      )
    return {
      field: r.str(rule, 'field', rulePath, true) ?? '',
      operator: operator as FormConditionOperator,
      value: r.str(rule, 'value', rulePath),
    }
  })
  if (rules.length === 0) r.problem(`${path}.rule`, 'a condition needs at least one rule')

  return {
    action: action === 'hide' ? 'hide' : 'show',
    match: match === 'any' ? 'any' : 'all',
    rules,
  }
}

function field(r: Reader, t: Toml, path: string): SchemaFormField {
  r.unknown(t, FIELD_KEYS, path)
  const type = r.str(t, 'type', path, true) ?? ''
  if (type && !formFieldType(type))
    r.problem(
      `${path}.type`,
      `unknown field type; expected one of ${FORM_FIELD_TYPE_NAMES.join(', ')}`,
    )
  // Consent is mandatory unless the form says otherwise: a consent box that can
  // be skipped records agreement nobody gave.
  const mandatoryByDefault = type === 'dataConsent'
  return {
    key: r.str(t, 'key', path),
    alias: r.str(t, 'alias', path, true) ?? '',
    type: type as FormFieldType,
    caption: r.str(t, 'caption', path, true) ?? '',
    helpText: r.str(t, 'help-text', path),
    mandatory: r.bool(t, 'mandatory', path, mandatoryByDefault),
    mandatoryMessage: r.str(t, 'mandatory-message', path),
    pattern: r.str(t, 'pattern', path),
    patternMessage: r.str(t, 'pattern-message', path),
    sensitive: r.bool(t, 'sensitive', path, false),
    cssClass: r.str(t, 'css-class', path),
    autocomplete: r.str(t, 'autocomplete', path),
    values: r.strs(t, 'values', path),
    placeholder: r.str(t, 'placeholder', path),
    defaultValue: r.str(t, 'default-value', path),
    content: r.str(t, 'content', path),
    maxlength: r.num(t, 'maxlength', path),
    rows: r.num(t, 'rows', path),
    min: r.num(t, 'min', path),
    max: r.num(t, 'max', path),
    step: r.num(t, 'step', path),
    accept: r.strs(t, 'accept', path),
    maxSizeKb: r.num(t, 'max-size-kb', path),
    ...(t.multiple !== undefined ? { multiple: r.bool(t, 'multiple', path, false) } : {}),
    condition: condition(r, t.condition, `${path}.condition`),
  }
}

function group(r: Reader, t: Toml, path: string): SchemaFormGroup {
  r.unknown(t, GROUP_KEYS, path)
  return {
    caption: r.str(t, 'caption', path),
    columns: r.num(t, 'columns', path) ?? 1,
    fields: r.tables(t.field, `${path}.field`).map((f, i) => field(r, f, `${path}.field[${i}]`)),
    condition: condition(r, t.condition, `${path}.condition`),
  }
}

function page(r: Reader, t: Toml, path: string): SchemaFormPage {
  r.unknown(t, PAGE_KEYS, path)
  return {
    caption: r.str(t, 'caption', path),
    groups: r.tables(t.group, `${path}.group`).map((g, i) => group(r, g, `${path}.group[${i}]`)),
    condition: condition(r, t.condition, `${path}.condition`),
  }
}

function workflow(r: Reader, t: Toml, path: string): SchemaFormWorkflow {
  r.unknown(t, WORKFLOW_KEYS, path)
  const type = r.str(t, 'type', path, true) ?? ''
  if (type && !FORM_WORKFLOW_TYPES.includes(type as FormWorkflowType))
    r.problem(
      `${path}.type`,
      `unknown workflow type; expected one of ${FORM_WORKFLOW_TYPES.join(', ')}`,
    )
  const on = r.str(t, 'on', path) ?? 'submit'
  if (on !== 'submit' && on !== 'approve') r.problem(`${path}.on`, "expected 'submit' or 'approve'")
  const settings = t.settings === undefined ? {} : r.table(t.settings, `${path}.settings`)
  return {
    key: r.str(t, 'key', path),
    type: type as FormWorkflowType,
    name: r.str(t, 'name', path, true) ?? '',
    on: on as FormWorkflowTrigger,
    settings: (settings ?? {}) as Record<string, unknown>,
  }
}

export function parseForm(file: string, source: string): ParseResult<SchemaForm> {
  const r = new Reader(file)
  const root = toml(source, r)
  if (!root) return { value: undefined, problems: r.problems }
  r.unknown(root, ['form', 'page', 'workflow'], '')
  const t = r.table(root.form, 'form')
  if (!t) {
    r.problem('form', 'a [form] table is required')
    return { value: undefined, problems: r.problems }
  }
  const path = 'form'
  r.unknown(t, FORM_KEYS, path)
  const value: SchemaForm = {
    key: r.str(t, 'key', path),
    alias: r.str(t, 'alias', path, true) ?? '',
    name: r.str(t, 'name', path, true) ?? '',
    notes: r.str(t, 'notes', path),
    // Entries are kept unless a form opts out: a form that quietly discarded
    // what people typed would be the worst possible default.
    storeEntries: r.bool(t, 'store-entries', path, true),
    requiresApproval: r.bool(t, 'requires-approval', path, false),
    submitLabel: r.str(t, 'submit-label', path),
    nextLabel: r.str(t, 'next-label', path),
    previousLabel: r.str(t, 'previous-label', path),
    messageOnSubmit: r.str(t, 'message-on-submit', path),
    redirectTo: r.str(t, 'redirect-to', path),
    theme: r.str(t, 'theme', path),
    honeypot: r.bool(t, 'honeypot', path, true),
    minimumSubmitSeconds: r.num(t, 'minimum-submit-seconds', path),
    maxEntries: r.num(t, 'max-entries', path),
    since: r.str(t, 'since', path),
    pages: r.tables(root.page, 'page').map((p, i) => page(r, p, `page[${i}]`)),
    workflows: r.tables(root.workflow, 'workflow').map((w, i) => workflow(r, w, `workflow[${i}]`)),
  }
  return { value: r.problems.length === 0 ? value : undefined, problems: r.problems }
}
