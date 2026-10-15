/**
 * The fixture bundle story 095 is tested with: `acme-forms`, which adds a
 * postcode field type and a CRM hand-off workflow type, through the same public
 * contract a published bundle would use.
 */
import { element } from '@crombolo/render'
import type {
  FormFieldTypeDefinition,
  FormWorkflowTypeDefinition,
  ServerBundle,
} from '@crombolo/server'

export const FORMS_BUNDLE_ID = 'acme-forms'

const POSTCODE: Record<string, RegExp> = {
  AU: /^\d{4}$/,
  GB: /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i,
}

export const postcodeField: FormFieldTypeDefinition = {
  type: 'postcode',
  label: 'Postcode',
  stores: 'string',
  settings: [
    { key: 'country', label: 'Country', kind: 'text', required: true },
    { key: 'lookup', label: 'Offer address lookup', kind: 'boolean' },
  ],
  validate(values, settings) {
    const pattern = POSTCODE[String(settings.country)]
    const value = values[0] ?? ''
    return pattern && !pattern.test(value)
      ? `That is not a ${settings.country} postcode`
      : undefined
  },
  render: ({ field, values, id, name, shown }) =>
    element('input', {
      id,
      name,
      type: 'text',
      inputmode: field.settings?.country === 'AU' ? 'numeric' : undefined,
      autocomplete: 'postal-code',
      value: values[0] ?? '',
      'data-country': String(field.settings?.country ?? ''),
      required: field.mandatory && shown ? true : undefined,
    }),
}

export const crmHandoff: FormWorkflowTypeDefinition = {
  type: 'crmHandoff',
  label: 'Hand off to the CRM',
  settings: [
    { key: 'endpoint', label: 'Endpoint', kind: 'text', required: true },
    { key: 'list', label: 'List', kind: 'text' },
  ],
  validate: (settings) =>
    /^https?:\/\//.test(String(settings.endpoint))
      ? undefined
      : 'the endpoint must be a web address',
  async run({ form, values, settings, attempt, fetch }) {
    const response = await fetch(String(settings.endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ form: form.alias, list: settings.list ?? null, attempt, values }),
    })
    if (response.ok) return { ok: true }
    // A refusal will refuse again; a fault on their side may not last.
    return {
      ok: false,
      error: `The CRM answered ${response.status}`,
      retry: response.status >= 500,
    }
  },
}

export function formsBundle(over: Partial<ServerBundle> = {}): ServerBundle {
  return {
    id: FORMS_BUNDLE_ID,
    section: 'settings',
    capabilities: [],
    routes: [],
    forms: { fields: [postcodeField], workflows: [crmHandoff] },
    ...over,
  }
}

/** What the site's `package.json` dependency carries, for discovery to find. */
export const FORMS_PACKAGE = {
  '@acme/forms': { json: { crombolo: { id: FORMS_BUNDLE_ID, server: 'forms' } } },
}
