/**
 * What an e-mail template is given: the form, what was sent, and where from.
 * `docs/forms.md`, "An e-mail template".
 *
 * An e-mail is not a page. There is no route, no member and no navigation, so a
 * template reads everything from these props, and `usePage()` says so.
 */
import type { SchemaForm } from '@crombolo/core'
import type { RawHtml } from './html.ts'

/** One field of the form, in the form's order, as the e-mail may show it. */
export interface EmailField {
  alias: string
  caption: string
  type: string
  /** What was entered: a choice's label before its stored value, as `{alias}` shows it. */
  values: string[]
  answered: boolean
  sensitive: boolean
  /** Sensitive, and the workflow does not send sensitive answers: `values` is empty. */
  leftOut: boolean
}

export interface EmailProps {
  form: SchemaForm
  fields: EmailField[]
  /** What was entered for a field, joined as `{alias}` joins it; empty when nothing was. */
  value(alias: string): string
  entry: {
    /** Absent for a form that stores no entries. */
    id: string | null
    /** When the workflow was queued: the submission, or the approval for `on = "approve"`. */
    submittedAt: Date
  }
  site: { name: string; url: string }
  /** The subject line, already substituted. */
  subject: string
  /** Aborts when the render has taken too long. */
  signal: AbortSignal
}

/** What a layout around an e-mail template is given: the same props, and the template inside. */
export interface EmailLayoutProps extends EmailProps {
  children: RawHtml
}

export type EmailRenderResult =
  | { status: 'ok'; html: string }
  /** No component answers to the alias in the views being served. */
  | { status: 'missing' }
  /** The message names the template and its line under `components/`, never a snapshot path. */
  | { status: 'error'; message: string }
