/**
 * A JSX runtime that renders straight to an HTML string.
 *
 * Templates are ordinary .tsx files executed by Bun, so there is no virtual DOM
 * and no hydration: a template is a function from a model to markup. Configured
 * through `jsxImportSource` in tsconfig.
 *
 * A component may be async. Rendering stays synchronous until it meets a
 * promise, and from there hands back a promise of the markup instead, so a tree
 * without one renders exactly as it always has.
 */
import { escapeHtml, RawHtml, serializeAttributes, VOID_ELEMENTS } from './html.ts'

export type Child =
  | string
  | number
  | boolean
  | null
  | undefined
  | RawHtml
  | Promise<Child>
  | Child[]

/** What `jsx()` returns: markup, or a promise of it once an async component is involved. */
export type Html = RawHtml | Promise<RawHtml>

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
  __html: string | Promise<string>
  /** Emit the markup as-is. Escaped when absent. */
  dangerously?: boolean
}

export interface ElementProps extends Record<string, unknown> {
  children?: Child
  setInnerHTML?: InnerHTML
}

export type Component = (props: ElementProps) => Child

export const Fragment = Symbol.for('bunbraco.fragment')

export function isPromise(value: unknown): value is Promise<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function'
}

function renderChild(child: Child): string | Promise<string> {
  if (child === null || child === undefined || child === false || child === true) return ''
  if (child instanceof RawHtml) return child.value
  if (isPromise(child))
    return (child as Promise<unknown>).then((value) => renderChild(value as Child))
  if (Array.isArray(child)) {
    const parts = child.map(renderChild)
    return parts.some(isPromise)
      ? Promise.all(parts).then((done) => done.join(''))
      : (parts as string[]).join('')
  }
  return escapeHtml(String(child))
}

function toHtml(content: string | Promise<string>, wrap = (inner: string) => inner): Html {
  if (!isPromise(content)) return new RawHtml(wrap(content))
  const html = content.then((inner) => new RawHtml(wrap(inner)))
  // Marked handled so an element built but never rendered does not surface as an
  // unhandled rejection; whoever renders it still receives the error.
  html.catch(() => {})
  return html
}

function innerHtml(props: ElementProps): string | Promise<string> {
  const inner = props.setInnerHTML
  if (!inner) return renderChild(props.children)
  const output = (html: string) => (inner.dangerously ? html : escapeHtml(html))
  return isPromise(inner.__html) ? inner.__html.then(output) : output(inner.__html)
}

export function jsx(type: string | Component | typeof Fragment, props: ElementProps | null): Html {
  const actual = props ?? {}

  if (type === Fragment) return toHtml(renderChild(actual.children))

  if (typeof type === 'function') return toHtml(renderChild(type(actual)))

  for (const [name, value] of Object.entries(actual)) {
    if (name !== 'children' && name !== 'setInnerHTML' && isPromise(value))
      throw new Error(
        `The "${name}" attribute of <${type}> is a promise. Await it before rendering the element.`,
      )
  }
  const open = `<${type}${serializeAttributes(actual)}`
  if (VOID_ELEMENTS.has(type)) return new RawHtml(`${open} />`)
  return toHtml(innerHtml(actual), (inner) => `${open}>${inner}</${type}>`)
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

/** Renders a template's return value to HTML: a string, or a promise of one when anything in it is async. */
export function renderToString(child: Child): string | Promise<string> {
  return renderChild(child)
}

/**
 * `jsx()` for markup that must be ready now: the built-in components, whose
 * return types promise `RawHtml`. Refuses a promise rather than handing one on.
 */
export function element(
  type: string | Component | typeof Fragment,
  props: ElementProps | null,
): RawHtml {
  const html = jsx(type, props)
  if (isPromise(html))
    throw new Error(
      `<${typeof type === 'string' ? type : 'component'}> was given an async child, which this element cannot wait for.`,
    )
  return html
}
