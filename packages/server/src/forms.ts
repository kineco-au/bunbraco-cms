/**
 * What the backoffice reads about forms. `docs/18-forms.md`.
 *
 * Non-contract, under the plugin path, because there is no form operation in
 * the vendored OpenAPI document — Umbraco Forms ships its own API and its own
 * client, and neither is here.
 *
 * Definitions come from the loaded schema rather than the database: the files
 * are the truth, and reading them here means the picker cannot disagree with
 * what a render would use.
 */

import type { FormEntryState } from '@bunbraco/data'
import { allFormFields, type SchemaForm, storingFormFields } from '@bunbraco/schema'

/** A form as the picker and the tree list it. */
export interface FormSummary {
  key: string
  alias: string
  name: string
  /** How many fields collect something, which is the useful size of a form. */
  fieldCount: number
  pageCount: number
  storeEntries: boolean
  requiresApproval: boolean
  workflowCount: number
}

export function formSummary(form: SchemaForm): FormSummary {
  return {
    // A form with no key in its file still has to be addressable, and its alias
    // is unique within the set, so it stands in until a key is written.
    key: form.key ?? form.alias,
    alias: form.alias,
    name: form.name,
    fieldCount: storingFormFields(form).length,
    pageCount: form.pages.length,
    storeEntries: form.storeEntries,
    requiresApproval: form.requiresApproval,
    workflowCount: form.workflows.length,
  }
}

/** The full definition, for the designer and for an entries view's columns. */
export function formDetail(form: SchemaForm): Record<string, unknown> {
  return {
    ...formSummary(form),
    notes: form.notes ?? null,
    theme: form.theme ?? null,
    submitLabel: form.submitLabel ?? null,
    messageOnSubmit: form.messageOnSubmit ?? null,
    redirectTo: form.redirectTo ?? null,
    honeypot: form.honeypot,
    maxEntries: form.maxEntries ?? null,
    fields: allFormFields(form).map((field) => ({
      alias: field.alias,
      type: field.type,
      caption: field.caption,
      mandatory: field.mandatory,
      sensitive: field.sensitive,
      values: field.values,
    })),
    workflows: form.workflows.map((workflow) => ({
      type: workflow.type,
      name: workflow.name,
      on: workflow.on,
    })),
  }
}

/** Which forms a site has, by key, so an entry can be matched to its definition. */
export function formsByKey(forms: readonly SchemaForm[]): Map<string, SchemaForm> {
  const out = new Map<string, SchemaForm>()
  for (const form of forms) out.set(form.key ?? form.alias, form)
  return out
}

/**
 * Redacts the values of sensitive fields unless the reader may see them.
 *
 * Done here rather than in the UI: the values must not reach a browser that is
 * not allowed them, so the redaction is on the way out of the server.
 */
export function redactSensitive(
  entry: { values: { fieldAlias: string; values: string[] }[] },
  form: SchemaForm | undefined,
  maySeeSensitive: boolean,
): { fieldAlias: string; values: string[]; redacted: boolean }[] {
  const sensitive = new Set(
    (form ? allFormFields(form) : [])
      .filter((field) => field.sensitive)
      .map((field) => field.alias.toLowerCase()),
  )
  return entry.values.map((value) => {
    const hide = !maySeeSensitive && sensitive.has(value.fieldAlias.toLowerCase())
    return {
      fieldAlias: value.fieldAlias,
      values: hide ? [] : value.values,
      redacted: hide,
    }
  })
}

/** The states the entries view may filter by, validated off the query string. */
export function parseEntryState(value: string | null): FormEntryState | undefined {
  return value === 'submitted' || value === 'approved' || value === 'rejected' ? value : undefined
}

// ------------------------------------------------------------------ export

/** A CSV cell: quoted when it has to be, and never able to start a formula. */
function csvCell(value: string): string {
  // A leading =, +, - or @ makes a spreadsheet treat the cell as a formula, so
  // an exported answer could run when somebody opens the file.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

export interface EntriesCsvOptions {
  /** Without it, a sensitive column is refused rather than silently blank. */
  includeSensitive: boolean
}

export type EntriesCsvResult =
  | { ok: true; csv: string; fileName: string }
  | { ok: false; reason: string }

/**
 * A form's entries as CSV, one row per entry.
 *
 * A sensitive field makes the whole export refuse rather than exporting blanks:
 * a file that looks complete and quietly is not is worse than an error, because
 * somebody will act on it. The permission, not the column, is the thing to fix.
 */
export function entriesCsv(
  form: SchemaForm,
  entries: readonly {
    createDate: Date
    state: string
    spam: boolean
    values: { fieldAlias: string; values: string[] }[]
  }[],
  options: EntriesCsvOptions,
): EntriesCsvResult {
  const fields = storingFormFields(form)
  const sensitive = fields.filter((field) => field.sensitive)
  if (sensitive.length > 0 && !options.includeSensitive)
    return {
      ok: false,
      reason: `This form has sensitive fields (${sensitive
        .map((field) => field.caption || field.alias)
        .join(', ')}), so exporting it needs sensitive-data access.`,
    }

  const header = ['Submitted', 'State', 'Spam', ...fields.map((f) => f.caption || f.alias)]
  const rows = entries.map((entry) => [
    entry.createDate.toISOString(),
    entry.state,
    String(entry.spam),
    ...fields.map((field) =>
      (entry.values.find((value) => value.fieldAlias === field.alias)?.values ?? []).join('; '),
    ),
  ])
  return {
    ok: true,
    // CRLF, which is what the format says and what Excel wants.
    csv: [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n'),
    fileName: `${form.alias}-entries.csv`,
  }
}
