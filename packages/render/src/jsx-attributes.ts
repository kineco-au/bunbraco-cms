/**
 * The attributes each tag accepts, for type checking a view.
 *
 * React's DOM types are the source, adapted to how this runtime renders: to a
 * string, once, on the server. So children may be async, a style object is
 * CSS, an event handler is refused (nothing could run it), and the HTML
 * spellings (`class`, `for`, `charset`) are accepted beside React's.
 */
import type * as React from 'react'
import type { Child, InnerHTML } from './jsx-runtime.ts'

/**
 * A `style` object: React's typed CSS properties, plus custom properties. A
 * `null` leaves the property out, as it does an attribute.
 */
export type CSSProperties = {
  [Property in keyof React.CSSProperties]: React.CSSProperties[Property] | null
} & {
  [custom: `--${string}`]: string | number | null | undefined
}

/**
 * Attributes a site adds to every element, for one these types do not know yet:
 *
 * ```ts
 * declare module 'bunbraco' {
 *   interface ExtraAttributes { popover?: 'auto' | 'manual' }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: empty so that a site can merge into it.
export interface ExtraAttributes {}

/** What this runtime does differently from React, on every element. */
export interface RuntimeAttributes {
  children?: Child
  style?: string | CSSProperties
  /** Markup to write inside the element, escaped unless `dangerously` is set. */
  setInnerHTML?: InnerHTML
  /** React's spelling, written verbatim. */
  dangerouslySetInnerHTML?: { __html: string | Promise<string> }
  class?: string
  for?: string
  /** Dropped when rendered. */
  ref?: unknown
  /** A page is static HTML, so a handler could never run. */
  [handler: `on${Capitalize<string>}`]: never
}

/** Props React declares that mean nothing to a string renderer, or that are typed again above. */
type Replaced =
  | 'children'
  | 'style'
  | 'ref'
  | 'dangerouslySetInnerHTML'
  | 'suppressContentEditableWarning'
  | 'suppressHydrationWarning'

/**
 * React's props for one tag, without its handlers and the props replaced above.
 * Each also takes `null`, which leaves the attribute out — and is what
 * `model.value()` returns for an empty property.
 */
type ReactAttributes<Props> = {
  [Name in keyof Props as Name extends Replaced | `on${Capitalize<string>}` ? never : Name]:
    | Props[Name]
    | null
}

/** Each attribute again in lower case, as HTML writes it: `charset`, `tabindex`. */
type HtmlSpellings<Props> = {
  [Name in keyof Props as Lowercase<Name & string>]?: Props[Name]
}

export type Attributes<Props> = ReactAttributes<Props> &
  HtmlSpellings<ReactAttributes<Props>> &
  RuntimeAttributes &
  ExtraAttributes

/** Every tag React knows, with its attributes. */
export type KnownElements = {
  [Tag in keyof React.JSX.IntrinsicElements]: Attributes<React.JSX.IntrinsicElements[Tag]>
}

/**
 * A custom element (`<my-widget>`): its attributes are its own, so any is
 * accepted, and the runtime's still apply.
 */
export interface CustomElementAttributes extends RuntimeAttributes {
  [attribute: string]: unknown
}
