/**
 * Forms, phase 3 (`docs/18-forms.md`): the submission rules, and a form as HTML.
 *
 * The exit: a value posted for a field the conditions hide is discarded rather
 * than stored, and a form renders as a real `<form method="post">` that works
 * with no JavaScript.
 */
import { describe, expect, test } from 'bun:test'
import {
  conditionMatches,
  evaluateRule,
  FORM_HONEYPOT_FIELD,
  FORM_RENDERED_FIELD,
  FORM_TOKEN_FIELD,
  type FormCondition,
  isShown,
  type SchemaForm,
  type SchemaFormField,
  type SubmittedValues,
  validateSubmission,
  visibleFields,
} from '@bunbraco/core'
import { Form, formAction, renderToString, setFormTokenSigner } from '@bunbraco/render'

const field = (overrides: Partial<SchemaFormField> & { alias: string }): SchemaFormField => ({
  type: 'shortAnswer',
  caption: overrides.alias,
  mandatory: false,
  sensitive: false,
  values: [],
  accept: [],
  ...overrides,
})

const form = (fields: SchemaFormField[], overrides: Partial<SchemaForm> = {}): SchemaForm => ({
  key: '9c4a7d1e-0001-4b2a-9f31-6d8e2c5a7b40',
  alias: 'contactUs',
  name: 'Contact us',
  storeEntries: true,
  requiresApproval: false,
  honeypot: true,
  pages: [{ groups: [{ columns: 1, fields }] }],
  workflows: [],
  ...overrides,
})

const html = (subject: SchemaForm, props: Record<string, unknown> = {}) =>
  renderToString(Form({ form: subject, token: 'TOKEN', renderedAt: 1700000000000, ...props }))

describe('condition rules', () => {
  const values: SubmittedValues = { topic: ['Support'], tags: ['a', 'b'], empty: [''] }

  test('each operator compares what it says it compares', () => {
    const rule = (operator: FormCondition['rules'][number]['operator'], value?: string) =>
      evaluateRule({ field: 'topic', operator, value }, values)
    expect(rule('is', 'Support')).toBe(true)
    expect(rule('is', 'Sales')).toBe(false)
    expect(rule('isNot', 'Sales')).toBe(true)
    expect(rule('contains', 'upp')).toBe(true)
    expect(rule('doesNotContain', 'xyz')).toBe(true)
    expect(rule('startsWith', 'Sup')).toBe(true)
    expect(rule('endsWith', 'ort')).toBe(true)
    expect(rule('isEmpty')).toBe(false)
    expect(rule('isNotEmpty')).toBe(true)
  })

  test('a value of only whitespace is empty, which is what a visitor means by it', () => {
    expect(evaluateRule({ field: 'empty', operator: 'isEmpty' }, values)).toBe(true)
    expect(evaluateRule({ field: 'missing', operator: 'isEmpty' }, values)).toBe(true)
  })

  test('a multi-value field matches on any of its values', () => {
    expect(evaluateRule({ field: 'tags', operator: 'is', value: 'b' }, values)).toBe(true)
    expect(evaluateRule({ field: 'tags', operator: 'isNot', value: 'b' }, values)).toBe(false)
  })

  test('greaterThan compares as numbers when both sides are numbers, else as text', () => {
    expect(evaluateRule({ field: 'n', operator: 'greaterThan', value: '9' }, { n: ['10'] })).toBe(
      true,
    )
    // '10' > '9' is false as text, which is the trap this avoids.
    expect(evaluateRule({ field: 'n', operator: 'lessThan', value: '9' }, { n: ['10'] })).toBe(
      false,
    )
    expect(evaluateRule({ field: 's', operator: 'greaterThan', value: 'a' }, { s: ['b'] })).toBe(
      true,
    )
  })

  test('all and any combine the rules as they say', () => {
    const rules: FormCondition['rules'] = [
      { field: 'topic', operator: 'is', value: 'Support' },
      { field: 'topic', operator: 'is', value: 'Sales' },
    ]
    expect(conditionMatches({ action: 'show', match: 'all', rules }, values)).toBe(false)
    expect(conditionMatches({ action: 'show', match: 'any', rules }, values)).toBe(true)
  })

  test('hide inverts the match, and no condition is always shown', () => {
    const rules: FormCondition['rules'] = [{ field: 'topic', operator: 'is', value: 'Support' }]
    expect(isShown({ action: 'show', match: 'all', rules }, values)).toBe(true)
    expect(isShown({ action: 'hide', match: 'all', rules }, values)).toBe(false)
    expect(isShown(undefined, values)).toBe(true)
  })
})

describe('what a visitor can see', () => {
  test('hiding a group hides the fields in it, which is the point of the group', () => {
    const subject = form([], {
      pages: [
        {
          groups: [
            { columns: 1, fields: [field({ alias: 'topic', type: 'shortAnswer' })] },
            {
              columns: 1,
              condition: {
                action: 'show',
                match: 'all',
                rules: [{ field: 'topic', operator: 'is', value: 'Support' }],
              },
              fields: [field({ alias: 'order' })],
            },
          ],
        },
      ],
    })
    expect(visibleFields(subject, {}).map((v) => v.field.alias)).toEqual(['topic'])
    expect(visibleFields(subject, { topic: ['Support'] }).map((v) => v.field.alias)).toEqual([
      'topic',
      'order',
    ])
  })

  test('hiding a page hides everything on it', () => {
    const subject = form([], {
      pages: [
        { groups: [{ columns: 1, fields: [field({ alias: 'a' })] }] },
        {
          condition: {
            action: 'show',
            match: 'all',
            rules: [{ field: 'a', operator: 'is', value: 'yes' }],
          },
          groups: [{ columns: 1, fields: [field({ alias: 'b' })] }],
        },
      ],
    })
    expect(visibleFields(subject, {}).map((v) => v.field.alias)).toEqual(['a'])
    expect(visibleFields(subject, { a: ['yes'] })).toHaveLength(2)
  })
})

describe('validating a submission', () => {
  test('a value for a hidden field is discarded, not trusted', () => {
    const subject = form([
      field({ alias: 'topic' }),
      field({
        alias: 'order',
        condition: {
          action: 'show',
          match: 'all',
          rules: [{ field: 'topic', operator: 'is', value: 'Support' }],
        },
      }),
    ])
    // The browser said the field was hidden; a bot could say anything. The
    // server decides, so the value never reaches storage.
    const result = validateSubmission(subject, { topic: ['Sales'], order: ['A-1'] })
    expect(result.ok).toBe(true)
    expect(result.values.map((v) => v.fieldAlias)).toEqual(['topic'])
  })

  test('a mandatory field that is empty fails, with its own message when it has one', () => {
    const subject = form([
      field({ alias: 'name', mandatory: true }),
      field({ alias: 'email', type: 'email', mandatory: true, mandatoryMessage: 'We need this' }),
    ])
    const result = validateSubmission(subject, {})
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual([
      { field: 'name', message: 'name is required' },
      { field: 'email', message: 'We need this' },
    ])
  })

  test('an answered-with-nothing field is kept, which is not the same as absent', () => {
    const subject = form([field({ alias: 'name' })])
    const result = validateSubmission(subject, { name: [''] })
    expect(result.ok).toBe(true)
    expect(result.values).toEqual([{ fieldAlias: 'name', values: [] }])
  })

  test('an email must be an address, and a pattern must match', () => {
    const subject = form([
      field({ alias: 'email', type: 'email' }),
      field({ alias: 'ref', pattern: '^[A-Z]-\\d+$', patternMessage: 'Like A-123' }),
    ])
    const result = validateSubmission(subject, { email: ['nope'], ref: ['bad'] })
    expect(result.errors.map((e) => e.message)).toEqual([
      'email must be an email address',
      'Like A-123',
    ])
  })

  test('a pattern that does not compile does not reject what a visitor typed', () => {
    // The schema validator reports it; here it must not punish the visitor.
    const subject = form([field({ alias: 'ref', pattern: '([unclosed' })])
    expect(validateSubmission(subject, { ref: ['anything'] }).ok).toBe(true)
  })

  test('a number is a number, within its bounds', () => {
    const subject = form([field({ alias: 'n', type: 'number', min: 1, max: 10 })])
    expect(validateSubmission(subject, { n: ['abc'] }).errors[0]?.message).toContain(
      'must be a number',
    )
    expect(validateSubmission(subject, { n: ['0'] }).errors[0]?.message).toContain(
      'cannot be less than 1',
    )
    expect(validateSubmission(subject, { n: ['11'] }).errors[0]?.message).toContain(
      'cannot be more than 10',
    )
    expect(validateSubmission(subject, { n: ['5'] }).ok).toBe(true)
  })

  test('a date is a date', () => {
    const subject = form([field({ alias: 'd', type: 'date' })])
    expect(validateSubmission(subject, { d: ['not-a-date'] }).ok).toBe(false)
    expect(validateSubmission(subject, { d: ['2026-01-05'] }).ok).toBe(true)
  })

  test('a choice has to be one of the choices, however it was posted', () => {
    const subject = form([
      field({ alias: 'topic', type: 'dropdown', values: ['Sales', 'Support'] }),
      field({ alias: 'tags', type: 'multipleChoice', values: ['a', 'b'] }),
    ])
    const result = validateSubmission(subject, { topic: ['Elsewhere'], tags: ['a', 'z'] })
    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(2)
    // The unknown value is dropped rather than carried into storage.
    expect(result.values.find((v) => v.fieldAlias === 'tags')?.values).toEqual(['a'])
  })

  test('a maxlength is enforced on the server too', () => {
    const subject = form([field({ alias: 'name', maxlength: 3 })])
    expect(validateSubmission(subject, { name: ['abcd'] }).errors[0]?.message).toContain(
      'cannot be longer than 3',
    )
  })

  test('an unticked mandatory consent box fails; a ticked one stores true', () => {
    const subject = form([field({ alias: 'agree', type: 'dataConsent', mandatory: true })])
    expect(validateSubmission(subject, {}).ok).toBe(false)
    const ticked = validateSubmission(subject, { agree: ['true'] })
    expect(ticked.ok).toBe(true)
    expect(ticked.values).toEqual([{ fieldAlias: 'agree', values: ['true'] }])
    // An unticked optional checkbox stores false rather than nothing.
    const optional = form([field({ alias: 'news', type: 'checkbox' })])
    expect(validateSubmission(optional, {}).values).toEqual([
      { fieldAlias: 'news', values: ['false'] },
    ])
  })

  test('a presentational field collects nothing, whatever is posted for it', () => {
    const subject = form([
      field({ alias: 'prose', type: 'richText', content: '<p>hi</p>' }),
      field({ alias: 'name' }),
    ])
    const result = validateSubmission(subject, { prose: ['injected'], name: ['Ada'] })
    expect(result.values.map((v) => v.fieldAlias)).toEqual(['name'])
  })

  test('a field not on the page being validated is carried, not checked', () => {
    const subject = form([field({ alias: 'a', mandatory: true })], {
      pages: [
        { groups: [{ columns: 1, fields: [field({ alias: 'a', mandatory: true })] }] },
        { groups: [{ columns: 1, fields: [field({ alias: 'b', mandatory: true })] }] },
      ],
    })
    const result = validateSubmission(subject, { a: ['x'] }, { page: 0 })
    expect(result.ok).toBe(true)
  })
})

describe('rendering a form', () => {
  test('is a real form that works without JavaScript', () => {
    const subject = form([field({ alias: 'name', mandatory: true, caption: 'Your name' })])
    const markup = html(subject)
    expect(markup).toContain('<form method="post"')
    expect(markup).toContain(`action="${formAction(subject)}"`)
    expect(markup).toContain('<input type="text" id="form-contactUs-name" name="name"')
    expect(markup).toContain('required')
    expect(markup).toContain('<label class="bunbraco-form__label" for="form-contactUs-name"')
    expect(markup).toContain('Your name')
    expect(markup).toContain('<button type="submit"')
  })

  test('carries the token, the render time and the honeypot', () => {
    const markup = html(form([field({ alias: 'name' })]))
    expect(markup).toContain(`name="${FORM_TOKEN_FIELD}" value="TOKEN"`)
    expect(markup).toContain(`name="${FORM_RENDERED_FIELD}" value="1700000000000"`)
    // Off-screen rather than hidden: a bot that skips hidden inputs skips the trap.
    expect(markup).toContain(`name="${FORM_HONEYPOT_FIELD}"`)
    expect(markup).toContain('left:-9999px')
  })

  test('a form with the honeypot off does not draw one', () => {
    expect(html(form([field({ alias: 'name' })], { honeypot: false }))).not.toContain(
      FORM_HONEYPOT_FIELD,
    )
  })

  test('the signer provides the token when a view does not', () => {
    setFormTokenSigner((key, at) => `signed:${key}:${at}`)
    try {
      const markup = renderToString(
        Form({ form: form([field({ alias: 'name' })]), renderedAt: 42 }),
      )
      expect(markup).toContain('value="signed:9c4a7d1e-0001-4b2a-9f31-6d8e2c5a7b40:42"')
    } finally {
      setFormTokenSigner(undefined)
    }
  })

  test('a conditional field is in the markup but hidden, so a script has something to reveal', () => {
    const subject = form([
      field({ alias: 'topic' }),
      field({
        alias: 'order',
        condition: {
          action: 'show',
          match: 'all',
          rules: [{ field: 'topic', operator: 'is', value: 'Support' }],
        },
      }),
    ])
    const markup = html(subject)
    expect(markup).toContain('data-field="order"')
    expect(markup).toContain('hidden')
    expect(markup).toContain('data-condition="')
    // With the answer that reveals it, it is not hidden.
    const shown = html(subject, { values: { topic: ['Support'] } })
    expect(shown).toContain('data-field="order"')
    expect(shown.split('data-field="order"')[1]?.slice(0, 40)).not.toContain('hidden')
  })

  test('every field type draws a control', () => {
    const types: SchemaFormField['type'][] = [
      'shortAnswer',
      'longAnswer',
      'email',
      'number',
      'date',
      'checkbox',
      'dropdown',
      'singleChoice',
      'multipleChoice',
      'fileUpload',
      'dataConsent',
      'titleAndDescription',
      'richText',
      'hidden',
    ]
    for (const type of types) {
      const needsChoices =
        type === 'dropdown' || type === 'singleChoice' || type === 'multipleChoice'
      const markup = html(
        form([
          field({
            alias: 'f',
            type,
            values: needsChoices ? ['a', 'b'] : [],
            content: '<p>c</p>',
          }),
        ]),
      )
      expect(markup, `${type} renders something`).toContain('bunbraco-form')
      if (type === 'longAnswer') expect(markup).toContain('<textarea')
      if (type === 'dropdown') expect(markup).toContain('<select')
      if (needsChoices && type !== 'dropdown') expect(markup).toContain('value="a"')
      if (type === 'fileUpload') expect(markup).toContain('type="file"')
      if (type === 'richText') expect(markup).toContain('<p>c</p>')
    }
  })

  test('multipart only when there is a file to carry', () => {
    expect(html(form([field({ alias: 'f', type: 'fileUpload' })]))).toContain(
      'enctype="multipart/form-data"',
    )
    expect(html(form([field({ alias: 'name' })]))).not.toContain('enctype')
  })

  test('errors are shown against their field and summarised at the top', () => {
    const markup = html(form([field({ alias: 'name' })]), {
      errors: [{ field: 'name', message: 'name is required' }],
    })
    expect(markup).toContain('bunbraco-form__summary')
    expect(markup).toContain('bunbraco-form__field--invalid')
    expect(markup).toContain('aria-invalid="true"')
    expect(markup).toContain('name is required')
  })

  test('what was typed comes back, so a refused submission is not retyped', () => {
    const markup = html(form([field({ alias: 'name' })]), {
      values: { name: ['Ada Lovelace'] },
    })
    expect(markup).toContain('value="Ada Lovelace"')
  })

  test('a default value fills a field that has no submitted value', () => {
    expect(html(form([field({ alias: 'name', defaultValue: 'Anon' })]))).toContain('value="Anon"')
  })

  test('an accepted submission shows its message in place of the form', () => {
    const markup = html(form([field({ alias: 'name' })]), { message: 'Thanks.' })
    expect(markup).toContain('bunbraco-form--submitted')
    expect(markup).toContain('Thanks.')
    expect(markup).not.toContain('<input')
  })

  test('a submission is used only by the form it belongs to', () => {
    const subject = form([field({ alias: 'name' })])
    const mine = html(subject, {
      submission: {
        formKey: subject.key,
        formAlias: subject.alias,
        values: {},
        errors: [],
        message: 'Thanks.',
      },
    })
    expect(mine).toContain('Thanks.')
    // Another form's submission must not show here, or two forms on one page
    // would report each other's results.
    const theirs = html(subject, {
      submission: {
        formKey: 'some-other-form',
        formAlias: 'other',
        values: { name: ['leaked'] },
        errors: [{ field: 'name', message: 'leaked' }],
        message: 'Thanks.',
      },
    })
    expect(theirs).not.toContain('Thanks.')
    expect(theirs).not.toContain('leaked')
  })

  test('a site can replace the markup for one field type', () => {
    const markup = html(form([field({ alias: 'name' })]), {
      components: { shortAnswer: () => '<custom-input></custom-input>' },
    })
    expect(markup).toContain('&lt;custom-input&gt;')
  })

  test('a theme becomes a class, which is all a stylesheet needs', () => {
    expect(html(form([field({ alias: 'name' })], { theme: 'compact' }))).toContain(
      'bunbraco-form bunbraco-form--compact',
    )
  })

  test('no form renders nothing at all, rather than an empty form', () => {
    expect(renderToString(Form({ form: null }))).toBe('')
    expect(renderToString(Form({ form: undefined }))).toBe('')
  })

  test('what a visitor typed is escaped, not reflected as markup', () => {
    const markup = html(form([field({ alias: 'name' })]), {
      values: { name: ['"><script>alert(1)</script>'] },
    })
    expect(markup).not.toContain('<script>')
    expect(markup).toContain('&lt;script&gt;')
  })
})
