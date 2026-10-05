/**
 * What a submission means, and whether it is acceptable.
 *
 * In core because the server is the only authority on it: the browser gets the
 * same rules for immediate feedback, but every submission is re-validated from
 * the definition before anything is stored — and so is every condition, because
 * "this field was hidden" is a client-side claim. A value for a field the
 * conditions hide is discarded rather than trusted (`docs/18-forms.md`).
 *
 * This is a deliberate divergence from Umbraco Forms, whose conditional logic
 * is a client-side concern tied to CSS classes.
 */
import {
  type FormCondition,
  type FormConditionRule,
  formFieldType,
  type SchemaForm,
  type SchemaFormField,
} from './forms.ts'
import { isValidEmail } from './users.ts'

/** Field alias to the values posted for it, as a form body arrives. */
export type SubmittedValues = Record<string, string[]>

export interface FormFieldError {
  field: string
  message: string
}

export interface FormValueToStore {
  fieldAlias: string
  values: string[]
}

export interface SubmissionResult {
  ok: boolean
  errors: FormFieldError[]
  /** Visible, storing fields only — in definition order, normalised. */
  values: FormValueToStore[]
}

/**
 * The hidden inputs every rendered form carries.
 *
 * Named in core so the renderer and the endpoint cannot disagree about them,
 * which would make a form that always fails or a guard that never fires.
 */
export const FORM_FIELD_PREFIX = '_bunbraco'
export const FORM_TOKEN_FIELD = `${FORM_FIELD_PREFIX}_token`
/** A field real visitors never see, let alone fill. */
export const FORM_HONEYPOT_FIELD = `${FORM_FIELD_PREFIX}_hp`
/** When the form was rendered, so an instant submission can be spotted. */
export const FORM_RENDERED_FIELD = `${FORM_FIELD_PREFIX}_at`
export const FORM_PAGE_FIELD = `${FORM_FIELD_PREFIX}_page`

export const FORM_RESERVED_FIELDS: readonly string[] = [
  FORM_TOKEN_FIELD,
  FORM_HONEYPOT_FIELD,
  FORM_RENDERED_FIELD,
  FORM_PAGE_FIELD,
]

/**
 * What a page knows about a submission that just happened.
 *
 * Carried on `PageProps` and handed to `<Form>`, so a refused submission comes
 * back inside the page's own layout rather than on a bare error page. A form
 * only uses it when the key matches, so two forms on one page stay apart.
 */
export interface FormSubmissionState {
  formKey: string
  formAlias: string
  values: SubmittedValues
  errors: FormFieldError[]
  /** Present after a submission the server accepted; shown in place of the form. */
  message?: string
}

// ------------------------------------------------------------------ conditions

const first = (values: readonly string[]): string => values[0] ?? ''

const numeric = (left: string, right: string): number | undefined => {
  const a = Number(left)
  const b = Number(right)
  return Number.isFinite(a) && Number.isFinite(b) ? a - b : undefined
}

export function evaluateRule(rule: FormConditionRule, submitted: SubmittedValues): boolean {
  const values = (submitted[rule.field] ?? []).map((value) => value.trim())
  const present = values.filter((value) => value !== '')
  const target = rule.value ?? ''
  switch (rule.operator) {
    case 'is':
      return present.includes(target)
    case 'isNot':
      return !present.includes(target)
    case 'contains':
      return present.some((value) => value.includes(target))
    case 'doesNotContain':
      return !present.some((value) => value.includes(target))
    case 'startsWith':
      return first(present).startsWith(target)
    case 'endsWith':
      return first(present).endsWith(target)
    case 'greaterThan': {
      // Numbers when both sides are numbers, text otherwise: a date field
      // compares as its ISO string, which sorts correctly anyway.
      const difference = numeric(first(present), target)
      return difference === undefined ? first(present) > target : difference > 0
    }
    case 'lessThan': {
      const difference = numeric(first(present), target)
      return difference === undefined ? first(present) < target : difference < 0
    }
    case 'isEmpty':
      return present.length === 0
    case 'isNotEmpty':
      return present.length > 0
  }
}

/** Whether a condition's rules are satisfied, before the action is applied. */
export function conditionMatches(condition: FormCondition, submitted: SubmittedValues): boolean {
  if (condition.rules.length === 0) return true
  return condition.match === 'any'
    ? condition.rules.some((rule) => evaluateRule(rule, submitted))
    : condition.rules.every((rule) => evaluateRule(rule, submitted))
}

/** Whether something carrying this condition is shown. No condition means shown. */
export function isShown(condition: FormCondition | undefined, submitted: SubmittedValues): boolean {
  if (!condition) return true
  const matched = conditionMatches(condition, submitted)
  return condition.action === 'hide' ? !matched : matched
}

export interface VisibleField {
  field: SchemaFormField
  /** Which page it is on, zero-based, for a multi-page form. */
  page: number
}

/**
 * The fields a visitor can actually see, given what they have answered.
 *
 * A field is shown only when its group and its page are shown too: hiding a
 * group hides what is in it, which is the whole point of putting it there.
 */
export function visibleFields(form: SchemaForm, submitted: SubmittedValues): VisibleField[] {
  const out: VisibleField[] = []
  for (const [index, page] of form.pages.entries()) {
    if (!isShown(page.condition, submitted)) continue
    for (const group of page.groups) {
      if (!isShown(group.condition, submitted)) continue
      for (const field of group.fields)
        if (isShown(field.condition, submitted)) out.push({ field, page: index })
    }
  }
  return out
}

// ------------------------------------------------------------------ validation

export interface ValidateSubmissionOptions {
  /**
   * Only validate the fields on this page, for a multi-page form moving
   * forward. Values for other pages are still carried through.
   */
  page?: number
}

const DATE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/

const label = (field: SchemaFormField) => field.caption || field.alias

/** `true` and `false` only: a checkbox posts its name when ticked and nothing when not. */
const asBoolean = (values: readonly string[]): boolean =>
  values.some((value) => value === 'true' || value === 'on' || value === '1')

export function validateSubmission(
  form: SchemaForm,
  submitted: SubmittedValues,
  options: ValidateSubmissionOptions = {},
): SubmissionResult {
  const errors: FormFieldError[] = []
  const values: FormValueToStore[] = []
  const fail = (field: SchemaFormField, message: string) =>
    errors.push({ field: field.alias, message })

  for (const { field, page } of visibleFields(form, submitted)) {
    const info = formFieldType(field.type)
    // A presentational field collects nothing, so there is nothing to check and
    // nothing to store — and a value posted for one is ignored, not kept.
    if (!info || info.presentational) continue

    const raw = (submitted[field.alias] ?? []).map((value) => value.trim())
    const present = raw.filter((value) => value !== '')
    const onThisPage = options.page === undefined || options.page === page

    if (info.stores === 'boolean') {
      const ticked = asBoolean(raw)
      // Consent is the reason this matters: an unticked mandatory box is the
      // one case where "false" is a validation failure rather than a value.
      if (field.mandatory && !ticked && onThisPage)
        fail(field, field.mandatoryMessage ?? `${label(field)} is required`)
      values.push({ fieldAlias: field.alias, values: [String(ticked)] })
      continue
    }

    if (present.length === 0) {
      if (field.mandatory && onThisPage)
        fail(field, field.mandatoryMessage ?? `${label(field)} is required`)
      // Recorded as answered-with-nothing, which is not the same as absent.
      values.push({ fieldAlias: field.alias, values: [] })
      continue
    }

    if (!onThisPage) {
      values.push({ fieldAlias: field.alias, values: present })
      continue
    }

    let accepted = present
    switch (info.stores) {
      case 'string': {
        const value = first(present)
        if (field.maxlength !== undefined && value.length > field.maxlength)
          fail(field, `${label(field)} cannot be longer than ${field.maxlength} characters`)
        if (field.type === 'email' && !isValidEmail(value))
          fail(field, `${label(field)} must be an email address`)
        if (field.type === 'date') {
          if (!DATE.test(value) || Number.isNaN(new Date(value).getTime()))
            fail(field, `${label(field)} must be a date`)
          else {
            if (field.min !== undefined && value < String(field.min))
              fail(field, `${label(field)} cannot be before ${field.min}`)
            if (field.max !== undefined && value > String(field.max))
              fail(field, `${label(field)} cannot be after ${field.max}`)
          }
        }
        if (info.choices && !field.values.includes(value))
          fail(field, `${label(field)} is not one of the choices`)
        if (field.pattern) {
          let matches = true
          try {
            matches = new RegExp(field.pattern).test(value)
          } catch {
            // A pattern that does not compile is a schema problem the validator
            // already reports; here it must not reject what a visitor typed.
            matches = true
          }
          if (!matches) fail(field, field.patternMessage ?? `${label(field)} is not valid`)
        }
        accepted = [value]
        break
      }
      case 'strings': {
        const unknown = present.filter((value) => !field.values.includes(value))
        if (unknown.length > 0) fail(field, `${label(field)} is not one of the choices`)
        accepted = present.filter((value) => field.values.includes(value))
        break
      }
      case 'number': {
        const value = Number(first(present))
        if (!Number.isFinite(value)) fail(field, `${label(field)} must be a number`)
        else {
          if (field.min !== undefined && value < field.min)
            fail(field, `${label(field)} cannot be less than ${field.min}`)
          if (field.max !== undefined && value > field.max)
            fail(field, `${label(field)} cannot be more than ${field.max}`)
        }
        accepted = [first(present)]
        break
      }
      case 'files': {
        if (!field.multiple && present.length > 1) fail(field, `${label(field)} takes one file`)
        if (field.accept.length > 0) {
          for (const value of present) {
            const extension = `.${value.split('.').pop()?.toLowerCase() ?? ''}`
            if (!field.accept.some((allowed) => allowed.toLowerCase() === extension))
              fail(field, `${label(field)} must be ${field.accept.join(' or ')}`)
          }
        }
        break
      }
    }
    values.push({ fieldAlias: field.alias, values: accepted })
  }

  return { ok: errors.length === 0, errors, values }
}

/**
 * The value a field starts with on a freshly rendered form.
 *
 * A default is a string in the file whatever the field stores, so this is where
 * it becomes the shape the renderer needs.
 */
export function defaultValuesFor(form: SchemaForm): SubmittedValues {
  const out: SubmittedValues = {}
  for (const field of form.pages.flatMap((page) => page.groups.flatMap((group) => group.fields))) {
    if (field.defaultValue === undefined) continue
    out[field.alias] = [field.defaultValue]
  }
  return out
}
