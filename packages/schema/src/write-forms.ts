/**
 * A form definition → canonical TOML.
 *
 * Same contract as `write.ts`: deterministic key order, one layout, and
 * `parseForm(writeForm(x))` equal to `x`. Held to that by the suite, which is
 * what lets the backoffice write a file a person will read in a diff.
 */
import type {
  FormCondition,
  SchemaForm,
  SchemaFormField,
  SchemaFormGroup,
  SchemaFormPage,
  SchemaFormWorkflow,
} from '@bunbraco/core'

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

/** Workflow settings arrive from the API, so a key may need quoting. */
function keyOf(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : str(key)
}

function line(out: string[], key: string, value: unknown, when = true): void {
  if (!when || value === undefined) return
  out.push(`${keyOf(key)} = ${scalar(value)}`)
}

/**
 * The rules on one line, as an array of inline tables.
 *
 * A condition is short and reads better as one line than as five tables, and
 * `[[…rule]]` would otherwise have to be ordered against the sub-tables around
 * it — which is the kind of TOML that is easy to write and hard to read.
 */
function writeCondition(out: string[], header: string, condition: FormCondition): void {
  out.push('', `[${header}]`)
  line(out, 'action', condition.action)
  line(out, 'match', condition.match)
  const rules = condition.rules.map((rule) => {
    const parts = [`field = ${str(rule.field)}`, `operator = ${str(rule.operator)}`]
    if (rule.value !== undefined) parts.push(`value = ${str(rule.value)}`)
    return `{ ${parts.join(', ')} }`
  })
  out.push(`rule = [${rules.join(', ')}]`)
}

function writeField(out: string[], header: string, field: SchemaFormField): void {
  out.push('', `[[${header}]]`)
  line(out, 'key', field.key)
  line(out, 'alias', field.alias)
  line(out, 'type', field.type)
  line(out, 'caption', field.caption)
  line(out, 'help-text', field.helpText)
  // Consent defaults to mandatory, so the key is written only when it differs
  // from what the parser would infer — otherwise a round trip would add it.
  const mandatoryByDefault = field.type === 'dataConsent'
  line(out, 'mandatory', field.mandatory, field.mandatory !== mandatoryByDefault)
  line(out, 'mandatory-message', field.mandatoryMessage)
  line(out, 'pattern', field.pattern)
  line(out, 'pattern-message', field.patternMessage)
  line(out, 'sensitive', true, field.sensitive)
  line(out, 'css-class', field.cssClass)
  line(out, 'autocomplete', field.autocomplete)
  line(out, 'values', field.values, field.values.length > 0)
  line(out, 'placeholder', field.placeholder)
  line(out, 'default-value', field.defaultValue)
  line(out, 'content', field.content)
  line(out, 'maxlength', field.maxlength)
  line(out, 'rows', field.rows)
  line(out, 'min', field.min)
  line(out, 'max', field.max)
  line(out, 'step', field.step)
  line(out, 'accept', field.accept, field.accept.length > 0)
  line(out, 'max-size-kb', field.maxSizeKb)
  line(out, 'multiple', field.multiple)
  if (field.condition) writeCondition(out, `${header}.condition`, field.condition)
}

function writeGroup(out: string[], header: string, group: SchemaFormGroup): void {
  out.push('', `[[${header}]]`)
  line(out, 'caption', group.caption)
  line(out, 'columns', group.columns, group.columns !== 1)
  if (group.condition) writeCondition(out, `${header}.condition`, group.condition)
  for (const field of group.fields) writeField(out, `${header}.field`, field)
}

function writePage(out: string[], page: SchemaFormPage): void {
  out.push('', '[[page]]')
  line(out, 'caption', page.caption)
  if (page.condition) writeCondition(out, 'page.condition', page.condition)
  for (const group of page.groups) writeGroup(out, 'page.group', group)
}

function writeWorkflow(out: string[], workflow: SchemaFormWorkflow): void {
  out.push('', '[[workflow]]')
  line(out, 'key', workflow.key)
  line(out, 'type', workflow.type)
  line(out, 'name', workflow.name)
  line(out, 'on', workflow.on, workflow.on !== 'submit')
  const keys = Object.keys(workflow.settings).sort()
  if (keys.length > 0) {
    out.push('', '[workflow.settings]')
    for (const key of keys) line(out, key, workflow.settings[key])
  }
}

export function writeForm(form: SchemaForm): string {
  const out: string[] = ['[form]']
  line(out, 'key', form.key)
  line(out, 'alias', form.alias)
  line(out, 'name', form.name)
  line(out, 'notes', form.notes)
  line(out, 'store-entries', false, !form.storeEntries)
  line(out, 'requires-approval', true, form.requiresApproval)
  line(out, 'submit-label', form.submitLabel)
  line(out, 'next-label', form.nextLabel)
  line(out, 'previous-label', form.previousLabel)
  line(out, 'message-on-submit', form.messageOnSubmit)
  line(out, 'redirect-to', form.redirectTo)
  line(out, 'theme', form.theme)
  line(out, 'honeypot', false, !form.honeypot)
  line(out, 'minimum-submit-seconds', form.minimumSubmitSeconds)
  line(out, 'max-entries', form.maxEntries)
  line(out, 'since', form.since)
  for (const page of form.pages) writePage(out, page)
  for (const workflow of form.workflows) writeWorkflow(out, workflow)
  return `${out.join('\n')}\n`
}
