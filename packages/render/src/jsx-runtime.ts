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
import type { CustomElementAttributes, KnownElements } from './jsx-attributes.ts'

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
  /** React's spelling, always verbatim. `setInnerHTML` escapes unless told not to. */
  dangerouslySetInnerHTML?: { __html: string | Promise<string> }
}

export type Component = (props: ElementProps) => Child

export const Fragment = Symbol.for('bunbraco.fragment')

export function isPromise(value: unknown): value is Promise<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function'
}

const REACT_ELEMENTS = new Set([
  Symbol.for('react.element'),
  Symbol.for('react.transitional.element'),
])

/** Refuses what has no markup of its own, saying what to do instead. */
function refuseChild(child: unknown): never {
  if (typeof child === 'function')
    throw new Error(
      'A function is not valid as a child. Call it, or render it as a component: <Name />.',
    )
  if (typeof child === 'symbol') throw new Error('A symbol is not valid as a child.')
  if (REACT_ELEMENTS.has((child as { $$typeof?: symbol }).$$typeof as symbol))
    throw new Error(
      "A React element was rendered in a page template. Templates render with Bunbraco's own " +
        'JSX, to static HTML, so a React component cannot run here. Render an element to mount ' +
        'it on, and load your client code from /scripts/.',
    )
  const found =
    Object.getPrototypeOf(child) === Object.prototype
      ? `object with keys {${Object.keys(child as object).join(', ')}}`
      : Object.prototype.toString.call(child)
  throw new Error(
    `Objects are not valid as a child (found: ${found}). Render a list as an array, and a value as text.`,
  )
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
  if (typeof child === 'string' || typeof child === 'number' || typeof child === 'bigint')
    return escapeHtml(String(child))
  return refuseChild(child)
}

function toHtml(content: string | Promise<string>, wrap = (inner: string) => inner): Html {
  if (!isPromise(content)) return new RawHtml(wrap(content))
  const html = content.then((inner) => new RawHtml(wrap(inner)))
  // Marked handled so an element built but never rendered does not surface as an
  // unhandled rejection; whoever renders it still receives the error.
  html.catch(() => {})
  return html
}

function innerHtml(type: string, props: ElementProps): string | Promise<string> {
  const verbatim = props.dangerouslySetInnerHTML
  if (verbatim) {
    if (props.setInnerHTML)
      throw new Error(`<${type}> was given both setInnerHTML and dangerouslySetInnerHTML.`)
    if (props.children !== undefined && props.children !== null)
      throw new Error(`<${type}> was given both children and dangerouslySetInnerHTML.`)
    return verbatim.__html
  }
  const inner = props.setInnerHTML
  if (!inner) return renderChild(props.children)
  const output = (html: string) => (inner.dangerously ? html : escapeHtml(html))
  return isPromise(inner.__html) ? inner.__html.then(output) : output(inner.__html)
}

/**
 * An `<option>` that keeps its value until it is written, so the `<select>`
 * holding it can mark it selected. JSX builds the options before the select,
 * so by then a finished string could only be edited, not asked.
 */
class OptionHtml extends RawHtml {
  readonly optionValue: string | undefined
  readonly #props: ElementProps
  readonly #inner: string

  constructor(props: ElementProps, inner: string) {
    super(`<option${serializeAttributes(props, 'option')}>${inner}</option>`)
    this.#props = props
    this.#inner = inner
    // Without a value attribute an option submits its text, so that is what matches.
    this.optionValue =
      props.value !== undefined && props.value !== null
        ? String(props.value)
        : textOf(props.children)
  }

  /** This option as the select's value says it should be. */
  chosen(selected: boolean): OptionHtml {
    return new OptionHtml({ ...this.#props, selected }, this.#inner)
  }
}

/** An `<optgroup>` that keeps its options, so the select can reach through it. */
class OptgroupHtml extends RawHtml {
  readonly #props: ElementProps

  constructor(props: ElementProps, inner: string) {
    super(`<optgroup${serializeAttributes(props, 'optgroup')}>${inner}</optgroup>`)
    this.#props = props
  }

  get options(): Child {
    return this.#props.children
  }

  /** This group, written again with its options as the select chose them. */
  withOptions(children: Child): Html {
    return optgroup({ ...this.#props, children })
  }
}

function optgroup(props: ElementProps): Html {
  const inner = renderChild(props.children)
  if (!isPromise(inner)) return new OptgroupHtml(props, inner)
  const group = inner.then((done) => new OptgroupHtml(props, done))
  group.catch(() => {})
  return group
}

/** The plain text of children that are only text, as an option's implicit value. */
function textOf(children: Child): string | undefined {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) {
    const parts = children.map(textOf)
    return parts.every((part) => part !== undefined) ? parts.join('') : undefined
  }
  return undefined
}

/** Marks the options among `children` whose value was chosen, noting which values it found. */
function chooseOptions(children: Child, chosen: Set<string>, found: Set<string>): Child {
  if (children instanceof OptionHtml) {
    const selected = children.optionValue !== undefined && chosen.has(children.optionValue)
    if (selected) found.add(children.optionValue as string)
    return children.chosen(selected)
  }
  if (children instanceof OptgroupHtml)
    return children.withOptions(chooseOptions(children.options, chosen, found))
  if (Array.isArray(children)) return children.map((child) => chooseOptions(child, chosen, found))
  if (isPromise(children))
    return (children as Promise<unknown>).then((resolved) =>
      chooseOptions(resolved as Child, chosen, found),
    )
  return children
}

/** React's controlled form values, as the attributes and content the HTML spells them with. */
function formControl(type: string, props: ElementProps): ElementProps {
  if (type === 'input') {
    const { defaultValue, defaultChecked, ...rest } = props
    return {
      ...rest,
      ...(rest.value === undefined && defaultValue !== undefined ? { value: defaultValue } : {}),
      ...(rest.checked === undefined && defaultChecked !== undefined
        ? { checked: defaultChecked }
        : {}),
    }
  }
  if (type === 'textarea') {
    const { value, defaultValue, ...rest } = props
    const text = value ?? defaultValue
    if (text === undefined || text === null) return rest
    if (rest.children !== undefined && rest.children !== null)
      throw new Error('<textarea> was given both a value and children; use the value alone.')
    return { ...rest, children: String(text) }
  }
  return props
}

function select(props: ElementProps): Html {
  const { value, defaultValue, ...rest } = props
  const wanted = value ?? defaultValue
  if (wanted === undefined || wanted === null) return jsx('select', rest)
  const chosen = new Set((Array.isArray(wanted) ? wanted : [wanted]).map(String))
  const found = new Set<string>()
  const children = chooseOptions(rest.children, chosen, found)
  const check = (html: RawHtml) => {
    const missing = [...chosen].filter((v) => !found.has(v))
    if (missing.length > 0)
      throw new Error(
        `<select> was given the value ${JSON.stringify(missing[0])}, but no <option> it can see ` +
          'has it. An option inside a fragment or returned from a component is written before ' +
          'the select can ask it, so put `selected` on that option instead.',
      )
    return html
  }
  const html = jsx('select', { ...rest, children })
  return isPromise(html) ? html.then(check) : check(html)
}

export function jsx(type: string | Component | typeof Fragment, props: ElementProps | null): Html {
  const actual = props ?? {}

  if (type === Fragment) return toHtml(renderChild(actual.children))

  if (typeof type === 'function') return toHtml(renderChild(type(actual)))

  if (type === 'select' && (actual.value != null || actual.defaultValue != null))
    return select(actual)

  for (const [name, value] of Object.entries(actual)) {
    if (name !== 'children' && name !== 'setInnerHTML' && isPromise(value))
      throw new Error(
        `The "${name}" attribute of <${type}> is a promise. Await it before rendering the element.`,
      )
  }
  const attributes = formControl(type, actual)
  if (type === 'optgroup') return optgroup(attributes)
  const open = `<${type}${serializeAttributes(attributes, type)}`
  if (VOID_ELEMENTS.has(type)) return new RawHtml(`${open} />`)
  const inner = innerHtml(type, attributes)
  if (type === 'option') {
    if (!isPromise(inner)) return new OptionHtml(attributes, inner)
    const option = inner.then((done) => new OptionHtml(attributes, done))
    option.catch(() => {})
    return option
  }
  return toHtml(inner, (done) => `${open}>${done}</${type}>`)
}

export const jsxs = jsx
export const jsxDEV = jsx

/**
 * What a view's `.tsx` compiles against: each tag with its own attributes (see
 * `jsx-attributes.ts`), and markup out. `bunbraco/loose` is the same runtime
 * with any attribute on any tag, for a site not ready to be checked.
 */
export declare namespace JSX {
  /** What a JSX expression is: markup, or a promise of it once anything in it is async. */
  type Element = Html
  /**
   * What may stand in a JSX tag position. Without this, TypeScript requires a
   * component's declared return type to be assignable to `Element`, so a
   * component returning plain text or a list would be rejected.
   *
   * The props are `never` rather than `ElementProps` so that a component
   * declaring its own prop type still fits: parameters are contravariant, so
   * pinning them here would reject every component that takes anything more
   * specific than `ElementProps` — which is all of them. Props are checked
   * against the component's own signature regardless; this constrains only what
   * may stand in the tag position.
   */
  type ElementType = string | ((props: never) => Child)
  interface IntrinsicElements extends KnownElements {
    [custom: `${string}-${string}`]: CustomElementAttributes
  }
  interface IntrinsicAttributes {
    key?: string | number | bigint | null
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
