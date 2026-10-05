/**
 * Rendering a form definition to HTML.
 *
 * Built with `jsx()` rather than JSX syntax: `jsxImportSource` is `bunbraco`,
 * which depends on this package, so a `.tsx` file here would be a cycle.
 *
 * Progressive enhancement is the baseline. The form is a real
 * `<form method="post">` that works with no JavaScript: conditional fields are
 * all present in the markup, hidden when the current answers hide them, and
 * carry their condition as data so a script can reveal them without a round
 * trip. The server re-evaluates every condition anyway (`form-submissions.ts`),
 * so what a script does to the DOM can only change what a visitor sees.
 *
 * Theming is composition, not directories. `components` overrides the renderer
 * for a field type, and a site that wants different markup altogether writes it
 * from the definition — which is three lines of TSX and needs nothing from here.
 * `docs/18-forms.md` says why this diverges from Umbraco's theme folders.
 */
import {
  FORM_HONEYPOT_FIELD,
  FORM_RENDERED_FIELD,
  FORM_TOKEN_FIELD,
  type FormFieldError,
  type FormFieldType,
  type FormSubmissionState,
  formFieldType,
  isShown,
  type SchemaForm,
  type SchemaFormField,
  type SchemaFormGroup,
  type SchemaFormPage,
  type SubmittedValues,
} from '@bunbraco/core'
import { RawHtml } from './html.ts'
import { type Child, Fragment, jsx } from './jsx-runtime.ts'

/** Where a submission is posted; the form's key is the only identifier it needs. */
export const FORM_SUBMIT_PATH = '/bunbraco/forms'

/**
 * How a rendered form gets its signed token.
 *
 * Process-wide rather than a prop or a context: the signing key is one
 * immutable value per process, so there is no per-request state to interleave,
 * and threading it through every view that draws a form would be noise. The
 * server sets this once at boot; without it a form renders with no token, which
 * is what a unit test sees and what the endpoint then refuses.
 */
let signer: ((formKey: string, renderedAt: number) => string) | undefined

export function setFormTokenSigner(
  sign: ((formKey: string, renderedAt: number) => string) | undefined,
): void {
  signer = sign
}

export const formAction = (form: SchemaForm): string =>
  `${FORM_SUBMIT_PATH}/${encodeURIComponent(form.key ?? form.alias)}`

export interface FormFieldRenderProps {
  field: SchemaFormField
  /** What this field currently holds, after a failed submission or from a default. */
  values: string[]
  /** The message for this field, when the last submission failed on it. */
  error: string | undefined
  /** The input's `id`, already unique within the form. */
  id: string
  /** The name to post under, which is the field's alias. */
  name: string
  /**
   * Whether the current answers show this field.
   *
   * A renderer must not mark a hidden field `required`: a browser with no
   * JavaScript would then refuse to submit the form over a field nobody can
   * see. `mandatory && shown` is the rule, and the server validates the real
   * one anyway.
   */
  shown: boolean
}

export type FormFieldRenderer = (props: FormFieldRenderProps) => Child

export type FormFieldComponents = Partial<Record<FormFieldType, FormFieldRenderer>>

export interface FormProps {
  /** The definition, as a `formPicker` property hands it over. */
  form: SchemaForm | null | undefined
  /** Defaults to this form's own endpoint. */
  action?: string
  /** The signed token the endpoint checks; omitted only in tests. */
  token?: string
  /** When the form was rendered, for the timing guard. Defaults to now. */
  renderedAt?: number
  /** Values to redisplay, after a submission the server refused. */
  values?: SubmittedValues
  errors?: readonly FormFieldError[]
  components?: FormFieldComponents
  /** Shown in place of the form, after a submission it accepted. */
  message?: string
  /**
   * What just happened to a submission, as the page received it. Used only when
   * its key matches this form, so two forms on one page do not show each
   * other's errors. `values`, `errors` and `message` override it when given.
   */
  submission?: FormSubmissionState
  className?: string
}

const attrs = (record: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record))
    if (value !== undefined && value !== null && value !== false) out[key] = value
  return out
}

const first = (values: readonly string[]): string => values[0] ?? ''

const checked = (values: readonly string[]): boolean =>
  values.some((value) => value === 'true' || value === 'on' || value === '1')

/** The input types that are a plain `<input>` differing only by `type`. */
const INPUT_TYPES: Partial<Record<FormFieldType, string>> = {
  shortAnswer: 'text',
  email: 'email',
  number: 'number',
  date: 'date',
  hidden: 'hidden',
}

function textInput({ field, values, id, name, error, shown }: FormFieldRenderProps): Child {
  return jsx(
    'input',
    attrs({
      type: INPUT_TYPES[field.type] ?? 'text',
      id,
      name,
      value: first(values),
      required: (field.mandatory && shown) || undefined,
      placeholder: field.placeholder,
      maxlength: field.maxlength,
      min: field.min,
      max: field.max,
      step: field.step,
      autocomplete: field.autocomplete,
      // The browser's own pattern check, with the server's as the authority.
      pattern: field.pattern,
      'aria-invalid': error ? 'true' : undefined,
      'aria-describedby': describedBy(field, id, error),
    }),
  )
}

const describedBy = (
  field: SchemaFormField,
  id: string,
  error: string | undefined,
): string | undefined => {
  const ids = [field.helpText ? `${id}-help` : '', error ? `${id}-error` : ''].filter(Boolean)
  return ids.length > 0 ? ids.join(' ') : undefined
}

const DEFAULTS: Record<FormFieldType, FormFieldRenderer> = {
  shortAnswer: textInput,
  email: textInput,
  number: textInput,
  date: textInput,
  hidden: textInput,

  longAnswer: ({ field, values, id, name, error, shown }) =>
    jsx(
      'textarea',
      attrs({
        id,
        name,
        rows: field.rows ?? 4,
        required: (field.mandatory && shown) || undefined,
        placeholder: field.placeholder,
        maxlength: field.maxlength,
        'aria-invalid': error ? 'true' : undefined,
        'aria-describedby': describedBy(field, id, error),
        children: first(values),
      }),
    ),

  checkbox: ({ field, values, id, name, error, shown }) =>
    jsx(
      'input',
      attrs({
        type: 'checkbox',
        id,
        name,
        value: 'true',
        checked: checked(values) || undefined,
        required: (field.mandatory && shown) || undefined,
        'aria-invalid': error ? 'true' : undefined,
        'aria-describedby': describedBy(field, id, error),
      }),
    ),

  // Consent reads as a checkbox whose label is the caption, because the wording
  // of the consent *is* the question.
  dataConsent: ({ field, values, id, name, error, shown }) =>
    jsx(
      'input',
      attrs({
        type: 'checkbox',
        id,
        name,
        value: 'true',
        checked: checked(values) || undefined,
        required: (field.mandatory && shown) || undefined,
        'aria-invalid': error ? 'true' : undefined,
        'aria-describedby': describedBy(field, id, error),
      }),
    ),

  dropdown: ({ field, values, id, name, error, shown }) =>
    jsx(
      'select',
      attrs({
        id,
        name,
        required: (field.mandatory && shown) || undefined,
        'aria-invalid': error ? 'true' : undefined,
        'aria-describedby': describedBy(field, id, error),
        children: [
          // An empty first option, so a mandatory dropdown starts unanswered
          // rather than silently defaulting to whatever is first.
          field.mandatory || first(values) === ''
            ? jsx('option', { value: '', children: field.placeholder ?? '' })
            : null,
          ...field.values.map((option) =>
            jsx(
              'option',
              attrs({
                value: option,
                selected: option === first(values) || undefined,
                children: option,
              }),
            ),
          ),
        ],
      }),
    ),

  singleChoice: ({ field, values, id, name, shown }) =>
    jsx('div', {
      class: 'bunbraco-form__choices',
      role: 'radiogroup',
      children: field.values.map((option, index) =>
        jsx('label', {
          class: 'bunbraco-form__choice',
          children: [
            jsx(
              'input',
              attrs({
                type: 'radio',
                id: `${id}-${index}`,
                name,
                value: option,
                checked: option === first(values) || undefined,
                required: (field.mandatory && shown) || undefined,
              }),
            ),
            jsx('span', { children: option }),
          ],
        }),
      ),
    }),

  multipleChoice: ({ field, values, id, name }) =>
    jsx('div', {
      class: 'bunbraco-form__choices',
      children: field.values.map((option, index) =>
        jsx('label', {
          class: 'bunbraco-form__choice',
          children: [
            jsx(
              'input',
              attrs({
                type: 'checkbox',
                id: `${id}-${index}`,
                name,
                value: option,
                checked: values.includes(option) || undefined,
              }),
            ),
            jsx('span', { children: option }),
          ],
        }),
      ),
    }),

  fileUpload: ({ field, id, name, error, shown }) =>
    jsx(
      'input',
      attrs({
        type: 'file',
        id,
        name,
        multiple: field.multiple || undefined,
        accept: field.accept.length > 0 ? field.accept.join(',') : undefined,
        required: (field.mandatory && shown) || undefined,
        'aria-invalid': error ? 'true' : undefined,
        'aria-describedby': describedBy(field, id, error),
      }),
    ),

  // Presentational: the content comes from the schema file, which a developer
  // wrote and a deploy reviewed, so it is emitted as the markup it is.
  titleAndDescription: ({ field }) =>
    jsx(Fragment, {
      children: [
        jsx('h3', { class: 'bunbraco-form__title', children: field.caption }),
        field.content
          ? jsx('div', {
              class: 'bunbraco-form__description',
              setInnerHTML: { __html: field.content, dangerously: true },
            })
          : null,
      ],
    }),

  richText: ({ field }) =>
    jsx('div', {
      class: 'bunbraco-form__richtext',
      setInnerHTML: { __html: field.content ?? '', dangerously: true },
    }),
}

/** Which renderer draws a field: the site's override, else the built-in one. */
export function rendererFor(
  type: FormFieldType,
  components: FormFieldComponents | undefined,
): FormFieldRenderer | undefined {
  return components?.[type] ?? DEFAULTS[type]
}

function renderField(
  field: SchemaFormField,
  options: {
    values: SubmittedValues
    errors: readonly FormFieldError[]
    components: FormFieldComponents | undefined
    idPrefix: string
  },
): Child {
  const info = formFieldType(field.type)
  if (!info) return null
  const renderer = rendererFor(field.type, options.components)
  if (!renderer) return null

  const id = `${options.idPrefix}-${field.alias}`
  const error = options.errors.find((candidate) => candidate.field === field.alias)?.message
  const values = options.values[field.alias] ?? (field.defaultValue ? [field.defaultValue] : [])
  // A conditional field is always in the markup: a script needs something to
  // reveal, and a visitor without one gets the server's answer on submit.
  const shown = isShown(field.condition, options.values)
  const control = renderer({ field, values, error, id, name: field.alias, shown })

  if (field.type === 'hidden') return control

  const classes = ['bunbraco-form__field', `bunbraco-form__field--${field.type}`]
  if (field.cssClass) classes.push(field.cssClass)
  if (error) classes.push('bunbraco-form__field--invalid')

  const labelled = info.presentational
    ? [control]
    : [
        jsx('label', {
          class: 'bunbraco-form__label',
          for: id,
          children: [
            field.caption,
            field.mandatory
              ? jsx('span', {
                  class: 'bunbraco-form__required',
                  'aria-hidden': 'true',
                  children: '*',
                })
              : null,
          ],
        }),
        field.helpText
          ? jsx('p', { class: 'bunbraco-form__help', id: `${id}-help`, children: field.helpText })
          : null,
        control,
        error
          ? jsx('p', {
              class: 'bunbraco-form__error',
              id: `${id}-error`,
              role: 'alert',
              children: error,
            })
          : null,
      ]

  return jsx(
    'div',
    attrs({
      class: classes.join(' '),
      hidden: shown ? undefined : true,
      'data-field': field.alias,
      'data-condition': field.condition ? JSON.stringify(field.condition) : undefined,
      // So the script can put `required` back when it reveals the field; the
      // markup could not carry it without breaking a no-JavaScript submit.
      'data-required': field.mandatory && !shown ? 'true' : undefined,
      children: labelled,
    }),
  )
}

function renderGroup(group: SchemaFormGroup, options: Parameters<typeof renderField>[1]): Child {
  const classes = ['bunbraco-form__group']
  if (group.columns > 1) classes.push(`bunbraco-form__group--columns-${group.columns}`)
  return jsx(
    'div',
    attrs({
      class: classes.join(' '),
      hidden: isShown(group.condition, options.values) ? undefined : true,
      'data-condition': group.condition ? JSON.stringify(group.condition) : undefined,
      style: group.columns > 1 ? `--bunbraco-form-columns:${group.columns}` : undefined,
      children: [
        group.caption
          ? jsx('legend', { class: 'bunbraco-form__group-caption', children: group.caption })
          : null,
        ...group.fields.map((field) => renderField(field, options)),
      ],
    }),
  )
}

function renderPage(
  page: SchemaFormPage,
  index: number,
  options: Parameters<typeof renderField>[1],
): Child {
  return jsx(
    'fieldset',
    attrs({
      class: 'bunbraco-form__page',
      'data-page': index,
      hidden: isShown(page.condition, options.values) ? undefined : true,
      'data-condition': page.condition ? JSON.stringify(page.condition) : undefined,
      children: [
        page.caption
          ? jsx('legend', { class: 'bunbraco-form__page-caption', children: page.caption })
          : null,
        ...page.groups.map((group) => renderGroup(group, options)),
      ],
    }),
  )
}

/**
 * A form, as HTML.
 *
 * Every page is rendered into one form rather than one page at a time. A
 * multi-page definition therefore submits in one go; stepping through pages with
 * a round trip each is a refinement on top of this, not a different shape.
 */
export function Form(props: FormProps): RawHtml {
  const form = props.form
  if (!form) return new RawHtml('')
  const accepted =
    props.message ??
    (props.submission?.formKey === (form.key ?? form.alias) ? props.submission.message : undefined)
  if (accepted !== undefined)
    return jsx('div', {
      class: 'bunbraco-form bunbraco-form--submitted',
      role: 'status',
      children: accepted,
    })

  // Only this form's own submission: a page with two forms must not show the
  // other one's errors, and the key is what tells them apart.
  const mine =
    props.submission && props.submission.formKey === (form.key ?? form.alias)
      ? props.submission
      : undefined
  const values = props.values ?? mine?.values ?? {}
  const errors = props.errors ?? mine?.errors ?? []
  const idPrefix = `form-${form.alias}`
  const options = { values, errors, components: props.components, idPrefix }
  const hasUpload = form.pages.some((page) =>
    page.groups.some((group) => group.fields.some((field) => field.type === 'fileUpload')),
  )

  const classes = ['bunbraco-form']
  if (form.theme) classes.push(`bunbraco-form--${form.theme}`)
  if (props.className) classes.push(props.className)

  const key = form.key ?? form.alias
  const renderedAt = props.renderedAt ?? Date.now()
  const token = props.token ?? signer?.(key, renderedAt)

  return jsx(
    'form',
    attrs({
      method: 'post',
      action: props.action ?? formAction(form),
      // Only when there is a file to carry: urlencoded bodies are smaller and
      // every other field posts fine without it.
      enctype: hasUpload ? 'multipart/form-data' : undefined,
      class: classes.join(' '),
      'data-form': form.alias,
      novalidate: undefined,
      children: [
        errors.length > 0
          ? jsx('div', {
              class: 'bunbraco-form__summary',
              role: 'alert',
              children: jsx('ul', {
                children: errors.map((error) => jsx('li', { children: error.message })),
              }),
            })
          : null,
        ...form.pages.map((page, index) => renderPage(page, index, options)),
        token ? jsx('input', { type: 'hidden', name: FORM_TOKEN_FIELD, value: token }) : null,
        jsx('input', {
          type: 'hidden',
          name: FORM_RENDERED_FIELD,
          value: String(renderedAt),
        }),
        // The honeypot: off-screen rather than `hidden`, because a bot that
        // skips hidden inputs would skip this one too. `autocomplete=off` and a
        // tab stop of -1 keep a real browser out of it.
        form.honeypot
          ? jsx('div', {
              class: 'bunbraco-form__honeypot',
              'aria-hidden': 'true',
              style: 'position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden',
              children: jsx('input', {
                type: 'text',
                name: FORM_HONEYPOT_FIELD,
                value: '',
                tabindex: '-1',
                autocomplete: 'off',
              }),
            })
          : null,
        jsx('div', {
          class: 'bunbraco-form__actions',
          children: jsx('button', {
            type: 'submit',
            class: 'bunbraco-form__submit',
            children: form.submitLabel ?? 'Submit',
          }),
        }),
      ],
    }),
  )
}
