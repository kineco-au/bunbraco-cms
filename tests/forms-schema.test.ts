/**
 * Forms, phase 1 (`docs/18-forms.md`): a form definition is a file, so it
 * parses strictly, writes canonically, round trips, and is validated against
 * the rest of the schema.
 *
 * The exit: a form with a condition on a later field is refused with a reason,
 * and a form written by the writer parses back to exactly what was written.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  allFormFields,
  BUILTIN_DATA_TYPE_ALIASES,
  FORM_FIELD_TYPES,
  formFieldType,
  hashSchemaSet,
  loadSchemaDirectory,
  parseForm,
  type SchemaForm,
  storingFormFields,
  validateForms,
  validateSchemaSet,
  writeForm,
} from '@bunbraco/schema'

const CONTACT = `[form]
key = "9c4a7d1e-0001-4b2a-9f31-6d8e2c5a7b40"
alias = "contactUs"
name = "Contact us"
submit-label = "Send"
message-on-submit = "Thanks."

[[page]]
caption = "Your details"

  [[page.group]]
  caption = "About you"
  columns = 2

    [[page.group.field]]
    key = "9c4a7d1e-0002-4b2a-9f31-6d8e2c5a7b40"
    alias = "email"
    type = "email"
    caption = "Email address"
    mandatory = true
    mandatory-message = "We need an address to reply to"

    [[page.group.field]]
    alias = "enquiryType"
    type = "dropdown"
    caption = "What is this about?"
    values = ["Sales", "Support"]

    [[page.group.field]]
    alias = "orderNumber"
    type = "shortAnswer"
    caption = "Order number"
    sensitive = true

      [page.group.field.condition]
      action = "show"
      match = "all"
      rule = [{ field = "enquiryType", operator = "is", value = "Support" }]

[[workflow]]
type = "sendEmail"
name = "Tell the team"

  [workflow.settings]
  subject = "Contact form"
  to = "enquiries@example.com"
`

const parsed = (source: string) => parseForm('schema/forms/x.toml', source)

/** A minimal valid form, as a starting point for the validation cases. */
const form = (overrides: Partial<SchemaForm> = {}): SchemaForm => ({
  alias: 'basic',
  name: 'Basic',
  storeEntries: true,
  requiresApproval: false,
  honeypot: true,
  pages: [
    {
      groups: [
        {
          columns: 1,
          fields: [
            {
              alias: 'name',
              type: 'shortAnswer',
              caption: 'Name',
              mandatory: false,
              sensitive: false,
              values: [],
              accept: [],
            },
          ],
        },
      ],
    },
  ],
  workflows: [],
  ...overrides,
})

describe('the field type registry', () => {
  test('every type says what it stores and what settings it takes', () => {
    expect(FORM_FIELD_TYPES).toHaveLength(14)
    for (const info of FORM_FIELD_TYPES) {
      expect(formFieldType(info.type)).toBe(info)
      // A presentational field cannot store anything; a collecting one must.
      expect(info.presentational).toBe(info.stores === 'none')
      if (info.choices) expect(info.stores === 'string' || info.stores === 'strings').toBe(true)
    }
  })

  test('password is deliberately not a field type', () => {
    expect(formFieldType('password')).toBeUndefined()
    expect(formFieldType('recaptcha')).toBeUndefined()
  })
})

describe('parsing a form', () => {
  test('reads the whole tree, with the defaults applied', () => {
    const result = parsed(CONTACT)
    expect(result.problems).toEqual([])
    const value = result.value as SchemaForm
    expect(value.alias).toBe('contactUs')
    expect(value.storeEntries).toBe(true)
    expect(value.honeypot).toBe(true)
    expect(value.pages).toHaveLength(1)
    expect(value.pages[0]?.groups[0]?.columns).toBe(2)
    expect(allFormFields(value).map((f) => f.alias)).toEqual([
      'email',
      'enquiryType',
      'orderNumber',
    ])
    expect(value.workflows[0]?.on).toBe('submit')
    expect(value.workflows[0]?.settings.to).toBe('enquiries@example.com')
  })

  test('a condition reads as an action, a match and its rules', () => {
    const value = parsed(CONTACT).value as SchemaForm
    const field = allFormFields(value).find((f) => f.alias === 'orderNumber')
    expect(field?.condition).toEqual({
      action: 'show',
      match: 'all',
      rules: [{ field: 'enquiryType', operator: 'is', value: 'Support' }],
    })
  })

  test('consent is mandatory unless the file says otherwise', () => {
    const value = parsed(`[form]
alias = "f"
name = "F"

[[page]]
  [[page.group]]
    [[page.group.field]]
    alias = "agree"
    type = "dataConsent"
    caption = "I agree"

    [[page.group.field]]
    alias = "maybe"
    type = "dataConsent"
    caption = "Optional"
    mandatory = false
`).value as SchemaForm
    const fields = allFormFields(value)
    expect(fields[0]?.mandatory).toBe(true)
    expect(fields[1]?.mandatory).toBe(false)
  })

  test('a misspelt key is an error, not something silently ignored', () => {
    const result = parsed(`[form]
alias = "f"
name = "F"
store-entires = false
`)
    expect(result.value).toBeUndefined()
    expect(result.problems[0]?.path).toBe('form.store-entires')
    expect(result.problems[0]?.message).toContain('unknown key')
  })

  test('an unknown field type and an unknown operator are both named', () => {
    const result = parsed(`[form]
alias = "f"
name = "F"

[[page]]
  [[page.group]]
    [[page.group.field]]
    alias = "a"
    type = "signature"
    caption = "A"

    [[page.group.field]]
    alias = "b"
    type = "shortAnswer"
    caption = "B"
      [page.group.field.condition]
      rule = [{ field = "a", operator = "resembles", value = "x" }]
`)
    const messages = result.problems.map((p) => p.message)
    expect(messages.some((m) => m.includes('unknown field type'))).toBe(true)
    expect(messages.some((m) => m.includes('unknown operator'))).toBe(true)
  })

  test('a condition with no rules is a condition that means nothing', () => {
    const result = parsed(`[form]
alias = "f"
name = "F"

[[page]]
  [[page.group]]
    [[page.group.field]]
    alias = "a"
    type = "shortAnswer"
    caption = "A"
      [page.group.field.condition]
      action = "hide"
`)
    expect(result.problems.map((p) => p.message)).toContain('a condition needs at least one rule')
  })

  test('invalid TOML is reported as such, with the parser message', () => {
    const result = parsed('[form\nalias = "f"\n')
    expect(result.value).toBeUndefined()
    expect(result.problems[0]?.message).toContain('invalid TOML')
  })

  test('a missing [form] table is named rather than crashing', () => {
    const result = parsed('[page]\ncaption = "x"\n')
    expect(result.value).toBeUndefined()
    expect(result.problems.some((p) => p.message.includes('[form] table is required'))).toBe(true)
  })
})

describe('writing a form', () => {
  test('parse(write(x)) equals x, which is what lets the backoffice write files', () => {
    const original = parsed(CONTACT).value as SchemaForm
    const written = writeForm(original)
    const again = parseForm('schema/forms/x.toml', written)
    expect(again.problems).toEqual([])
    expect(again.value).toEqual(original)
  })

  test('writing is deterministic, so a save with no change is an empty diff', () => {
    const original = parsed(CONTACT).value as SchemaForm
    expect(writeForm(original)).toBe(writeForm(original))
  })

  test('a default is not written, so a file stays as small as its meaning', () => {
    const written = writeForm(form())
    expect(written).not.toContain('store-entries')
    expect(written).not.toContain('honeypot')
    expect(written).not.toContain('requires-approval')
    expect(written).not.toContain('columns')
  })

  test('store-entries and honeypot are written when they are off', () => {
    const written = writeForm(
      form({
        storeEntries: false,
        honeypot: false,
        workflows: [
          {
            type: 'sendToUrl',
            name: 'w',
            on: 'submit',
            settings: { url: 'https://e.example.com' },
          },
        ],
      }),
    )
    expect(written).toContain('store-entries = false')
    expect(written).toContain('honeypot = false')
  })

  test("a consent field's mandatory flag round trips both ways", () => {
    for (const mandatory of [true, false]) {
      const subject = form()
      const field = subject.pages[0]?.groups[0]?.fields[0]
      if (field) {
        field.type = 'dataConsent'
        field.mandatory = mandatory
      }
      const again = parseForm('x', writeForm(subject)).value as SchemaForm
      expect(allFormFields(again)[0]?.mandatory).toBe(mandatory)
    }
  })

  test('a condition writes as one readable line of inline tables', () => {
    const written = writeForm(parsed(CONTACT).value as SchemaForm)
    expect(written).toContain(
      'rule = [{ field = "enquiryType", operator = "is", value = "Support" }]',
    )
  })
})

describe('validating forms', () => {
  const problems = (subject: SchemaForm) => validateForms([subject]).map((p) => p.message)

  test('a valid form has nothing to say about it', () => {
    expect(validateForms([parsed(CONTACT).value as SchemaForm])).toEqual([])
  })

  test('two forms cannot share an alias or a key', () => {
    const a = form({ alias: 'same', key: 'k' })
    const b = form({ alias: 'same', key: 'k' })
    const messages = validateForms([a, b]).map((p) => p.message)
    expect(messages.some((m) => m.includes('duplicate form alias'))).toBe(true)
    expect(messages.some((m) => m.includes('already used by'))).toBe(true)
  })

  test('two fields in one form cannot share an alias', () => {
    const subject = form()
    subject.pages[0]?.groups[0]?.fields.push({
      alias: 'name',
      type: 'shortAnswer',
      caption: 'Again',
      mandatory: false,
      sensitive: false,
      values: [],
      accept: [],
    })
    expect(problems(subject).some((m) => m.includes('duplicate field alias'))).toBe(true)
  })

  test('a choice field needs choices, and a plain one cannot have them', () => {
    const dropdown = form()
    const field = dropdown.pages[0]?.groups[0]?.fields[0]
    if (field) field.type = 'dropdown'
    expect(problems(dropdown).some((m) => m.includes('needs values to choose from'))).toBe(true)

    const text = form()
    const other = text.pages[0]?.groups[0]?.fields[0]
    if (other) other.values = ['a']
    expect(problems(text).some((m) => m.includes('nothing to choose from'))).toBe(true)
  })

  test('a default has to be one of the choices, or the form opens invalid', () => {
    const subject = form()
    const field = subject.pages[0]?.groups[0]?.fields[0]
    if (field) {
      field.type = 'singleChoice'
      field.values = ['a', 'b']
      field.defaultValue = 'c'
    }
    expect(problems(subject).some((m) => m.includes('is not one of the values'))).toBe(true)
  })

  test('a setting that does not apply to the type is named', () => {
    const subject = form()
    const field = subject.pages[0]?.groups[0]?.fields[0]
    if (field) field.rows = 5
    expect(problems(subject).some((m) => m.includes('does not apply to a shortAnswer field'))).toBe(
      true,
    )
  })

  test('a presentational field cannot be mandatory or sensitive', () => {
    const subject = form()
    const field = subject.pages[0]?.groups[0]?.fields[0]
    if (field) {
      field.type = 'richText'
      field.mandatory = true
      field.sensitive = true
    }
    const messages = problems(subject)
    expect(messages.some((m) => m.includes('cannot be mandatory'))).toBe(true)
    expect(messages.some((m) => m.includes('cannot be sensitive'))).toBe(true)
  })

  test('a form of nothing but prose collects nothing, which is a mistake', () => {
    const subject = form()
    const field = subject.pages[0]?.groups[0]?.fields[0]
    if (field) field.type = 'titleAndDescription'
    expect(problems(subject).some((m) => m.includes('the form collects nothing'))).toBe(true)
  })

  test('a pattern that is not a regular expression is caught before a visitor meets it', () => {
    const subject = form()
    const field = subject.pages[0]?.groups[0]?.fields[0]
    if (field) field.pattern = '([unclosed'
    expect(problems(subject).some((m) => m.includes('not a valid regular expression'))).toBe(true)
  })

  test('a condition can only look at a field the visitor has already reached', () => {
    const subject = form()
    const fields = subject.pages[0]?.groups[0]?.fields
    fields?.push({
      alias: 'later',
      type: 'shortAnswer',
      caption: 'Later',
      mandatory: false,
      sensitive: false,
      values: [],
      accept: [],
    })
    const first = fields?.[0]
    if (first)
      first.condition = {
        action: 'show',
        match: 'all',
        rules: [{ field: 'later', operator: 'is', value: 'x' }],
      }
    expect(problems(subject).some((m) => m.includes('comes later in the form'))).toBe(true)
  })

  test('a condition on an unknown field is named, not ignored', () => {
    const subject = form()
    const field = subject.pages[0]?.groups[0]?.fields[0]
    if (field)
      field.condition = {
        action: 'show',
        match: 'all',
        rules: [{ field: 'nope', operator: 'is', value: 'x' }],
      }
    expect(problems(subject).some((m) => m.includes('unknown field "nope"'))).toBe(true)
  })

  test('isEmpty takes no value, and is needs one', () => {
    const subject = form()
    const fields = subject.pages[0]?.groups[0]?.fields
    fields?.push({
      alias: 'second',
      type: 'shortAnswer',
      caption: 'Second',
      mandatory: false,
      sensitive: false,
      values: [],
      accept: [],
      condition: {
        action: 'show',
        match: 'all',
        rules: [
          { field: 'name', operator: 'isEmpty', value: 'x' },
          { field: 'name', operator: 'is' },
        ],
      },
    })
    const messages = problems(subject)
    expect(messages.some((m) => m.includes('isEmpty takes no value'))).toBe(true)
    expect(messages.some((m) => m.includes('is needs a value'))).toBe(true)
  })

  test('a workflow missing a required setting, or carrying an unknown one, is named', () => {
    const subject = form({
      workflows: [
        {
          type: 'sendEmail',
          name: 'mail',
          on: 'submit',
          settings: { to: 'a@b.com', subjekt: 'x' },
        },
      ],
    })
    // The setting's name is in the path, which is what points at the line.
    expect(
      validateForms([subject]).some(
        (p) => p.path === 'workflow[0].settings.subject' && p.message.includes('is required'),
      ),
    ).toBe(true)
    expect(problems(subject).some((m) => m.includes('unknown setting'))).toBe(true)
  })

  test('a workflow on approval needs a form that requires approval', () => {
    const subject = form({
      workflows: [
        { type: 'sendToUrl', name: 'w', on: 'approve', settings: { url: 'https://e.example.com' } },
      ],
    })
    expect(problems(subject).some((m) => m.includes('nothing ever approves it'))).toBe(true)
  })

  test('sendToUrl needs an http URL and a method it understands', () => {
    const subject = form({
      workflows: [
        {
          type: 'sendToUrl',
          name: 'w',
          on: 'submit',
          settings: { url: 'ftp://x', method: 'PATCH' },
        },
      ],
    })
    const messages = problems(subject)
    expect(messages.some((m) => m.includes('must be an http or https URL'))).toBe(true)
    expect(messages.some((m) => m.includes("expected 'POST' or 'PUT'"))).toBe(true)
  })

  test("saveAsContent is held to a document type that exists, and to the form's own fields", () => {
    const subject = form({
      workflows: [
        {
          type: 'saveAsContent',
          name: 'w',
          on: 'submit',
          settings: {
            'document-type': 'nope',
            parent: 'x',
            'name-field': 'missing',
            map: { alsoMissing: 'title' },
          },
        },
      ],
    })
    const messages = validateForms([subject], {
      documentTypeAliases: new Set(['page']),
    }).map((p) => p.message)
    expect(messages.some((m) => m.includes('unknown document type "nope"'))).toBe(true)
    expect(messages.some((m) => m.includes('unknown field "missing"'))).toBe(true)
    expect(messages.some((m) => m.includes('unknown field "alsoMissing"'))).toBe(true)
  })

  test('attaching uploads needs an upload field to attach', () => {
    const subject = form({
      workflows: [
        {
          type: 'sendEmail',
          name: 'w',
          on: 'submit',
          settings: { to: 'a@b.com', subject: 's', 'attach-uploads': true },
        },
      ],
    })
    expect(problems(subject).some((m) => m.includes('nothing to attach'))).toBe(true)
  })

  test('a form that stores nothing and runs nothing has no effect at all', () => {
    expect(
      problems(form({ storeEntries: false })).some((m) =>
        m.includes('needs at least one workflow'),
      ),
    ).toBe(true)
  })

  test('approval without stored entries has nothing to approve', () => {
    expect(
      problems(
        form({
          requiresApproval: true,
          storeEntries: false,
          workflows: [
            {
              type: 'sendToUrl',
              name: 'w',
              on: 'submit',
              settings: { url: 'https://e.example.com' },
            },
          ],
        }),
      ).some((m) => m.includes('requires store-entries')),
    ).toBe(true)
  })

  test('an unknown theme is caught when the theme directories are known', () => {
    expect(
      validateForms([form({ theme: 'nope' })], { formThemes: new Set(['default']) }).some((p) =>
        p.message.includes('no theme directory'),
      ),
    ).toBe(true)
    // Unknown set of themes means the check is skipped rather than guessed at.
    expect(validateForms([form({ theme: 'nope' })])).toEqual([])
  })

  test('an alias that is not an alias is refused', () => {
    expect(
      problems(form({ alias: '2cool' })).some((m) => m.includes('must start with a letter')),
    ).toBe(true)
  })
})

describe('forms in a schema directory', () => {
  const site = (files: Record<string, string>) => {
    const root = mkdtempSync(join(process.cwd(), 'output', 'forms-schema-'))
    mkdirSync(join(root, 'forms'), { recursive: true })
    writeFileSync(join(root, 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    for (const [name, source] of Object.entries(files))
      writeFileSync(join(root, 'forms', name), source)
    return root
  }

  test('a forms directory loads, and names the file each form came from', () => {
    const root = site({ 'contact-us.toml': CONTACT })
    try {
      const loaded = loadSchemaDirectory(root)
      expect(loaded.problems).toEqual([])
      expect(loaded.set.forms?.map((f) => f.alias)).toEqual(['contactUs'])
      expect(loaded.files.get('form:contactUs')).toContain('contact-us.toml')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a site with no forms directory is not a problem', () => {
    const root = mkdtempSync(join(process.cwd(), 'output', 'forms-none-'))
    try {
      writeFileSync(join(root, 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
      const loaded = loadSchemaDirectory(root)
      expect(loaded.problems).toEqual([])
      expect(loaded.set.forms).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a form changes the set hash, and reordering files does not', () => {
    const base = loadSchemaDirectory(site({})).set
    const withForm = loadSchemaDirectory(site({ 'contact-us.toml': CONTACT })).set
    expect(hashSchemaSet(withForm)).not.toBe(hashSchemaSet(base))
    // The hash is over meaning, so the same forms in another order match.
    const reversed = { ...withForm, forms: [...(withForm.forms ?? [])].reverse() }
    expect(hashSchemaSet(reversed)).toBe(hashSchemaSet(withForm))
  })

  test('whole-set validation reaches forms, and knows the document types', () => {
    const problems = validateSchemaSet({
      version: '1.0.0',
      documentTypes: [],
      dataTypes: [],
      languages: [],
      forms: [
        form({
          workflows: [
            {
              type: 'saveAsContent',
              name: 'w',
              on: 'submit',
              settings: { 'document-type': 'page', parent: 'x' },
            },
          ],
        }),
      ],
    })
    expect(problems.some((p) => p.message.includes('unknown document type "page"'))).toBe(true)
  })
})

describe('the form picker data type', () => {
  test('is built in, so a property can use it with no file', () => {
    expect(BUILTIN_DATA_TYPE_ALIASES.has('formPicker')).toBe(true)
  })

  test('a property typed formPicker validates without a data-type file', () => {
    const problems = validateSchemaSet({
      version: '1.0.0',
      documentTypes: [
        {
          alias: 'page',
          name: 'Page',
          icon: 'icon-document',
          allowAtRoot: true,
          isElement: false,
          allowInLibrary: false,
          variesByCulture: false,
          variesBySegment: false,
          compositions: [],
          allowChildren: [],
          components: [],
          cleanup: { prevent: false },
          properties: [
            {
              alias: 'form',
              name: 'Form',
              type: 'formPicker',
              mandatory: false,
              variesByCulture: false,
              variesBySegment: false,
              labelOnTop: false,
            },
          ],
          tabs: [],
        },
      ],
      dataTypes: [],
      languages: [],
    })
    expect(problems).toEqual([])
  })
})

describe('reading a form', () => {
  test('storing fields exclude the presentational ones, which carry no value', () => {
    const subject = form()
    subject.pages[0]?.groups[0]?.fields.push({
      alias: 'prose',
      type: 'richText',
      caption: 'Prose',
      mandatory: false,
      sensitive: false,
      values: [],
      accept: [],
      content: '<p>hi</p>',
    })
    expect(allFormFields(subject)).toHaveLength(2)
    expect(storingFormFields(subject).map((f) => f.alias)).toEqual(['name'])
  })
})
