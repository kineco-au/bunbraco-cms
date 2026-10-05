/**
 * A JSX runtime that renders straight to an HTML string.
 *
 * Templates are ordinary .tsx files executed by Bun, so there is no virtual DOM
 * and no hydration: a template is a function from a model to markup. Configured
 * through `jsxImportSource` in tsconfig.
 */
import { escapeHtml, RawHtml, serializeAttributes, VOID_ELEMENTS } from './html.ts'

export type Child = string | number | boolean | null | undefined | RawHtml | Child[]

/**
 * The value of the `setInnerHTML` attribute: markup, and whether to emit it
 * verbatim.
 *
 * React's `dangerouslySetInnerHTML` is always verbatim, and its name is the only
 * thing standing between a value and an injection. Making it a flag moves that
 * decision into the value, so a template that forgets it escapes rather than
 * trusting whatever arrived.
 */
export interface InnerHTML {
  __html: string
  /** Emit the markup as-is. Escaped when absent. */
  dangerously?: boolean
}

export interface ElementProps extends Record<string, unknown> {
  children?: Child
  setInnerHTML?: InnerHTML
}

export type Component = (props: ElementProps) => Child

export const Fragment = Symbol.for('bunbraco.fragment')

function renderChild(child: Child): string {
  if (child === null || child === undefined || child === false || child === true) return ''
  if (child instanceof RawHtml) return child.value
  if (Array.isArray(child)) return child.map(renderChild).join('')
  return escapeHtml(String(child))
}

export function jsx(
  type: string | Component | typeof Fragment,
  props: ElementProps | null,
): RawHtml {
  const actual = props ?? {}

  if (type === Fragment) return new RawHtml(renderChild(actual.children))

  if (typeof type === 'function') {
    return new RawHtml(renderChild(type(actual)))
  }

  const inner = actual.setInnerHTML
    ? actual.setInnerHTML.dangerously
      ? actual.setInnerHTML.__html
      : escapeHtml(actual.setInnerHTML.__html)
    : renderChild(actual.children)

  if (VOID_ELEMENTS.has(type)) return new RawHtml(`<${type}${serializeAttributes(actual)} />`)
  return new RawHtml(`<${type}${serializeAttributes(actual)}>${inner}</${type}>`)
}

export const jsxs = jsx
export const jsxDEV = jsx

/** What a view's `.tsx` compiles against: any tag, any attribute, a string out. */
export declare namespace JSX {
  type Element = string
  /**
   * What may stand in a JSX tag position. Without this, TypeScript requires a
   * component's declared return type to be assignable to `Element` — and
   * `jsx()` hands back `RawHtml`, so a component that annotates what it really
   * returns (`<Form>` in `forms.ts`) was rejected as "not a valid JSX element"
   * while an unannotated one inferred `Element` and passed.
   *
   * The props are `never` rather than `ElementProps` so that a component
   * declaring its own prop type still fits: parameters are contravariant, so
   * pinning them here would reject every component that takes anything more
   * specific than `ElementProps` — which is all of them. Props are checked
   * against the component's own signature regardless; this constrains only what
   * may stand in the tag position.
   */
  type ElementType = string | ((props: never) => Child)
  interface IntrinsicElements {
    [tag: string]: ElementProps
  }
  interface ElementChildrenAttribute {
    children: unknown
  }
}

/** Renders a template's return value to a complete HTML string. */
export function renderToString(child: Child): string {
  return renderChild(child)
}
