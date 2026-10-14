/**
 * Context for page templates: the page being rendered from any component, a
 * value of the template's own handed down without props, and ids unique to the
 * render.
 *
 * React carries context down an element tree it renders later. This runtime
 * renders as it goes — a component's children have rendered before it runs —
 * so the values live in storage scoped to the render instead, which follows
 * every call and every `await` inside it and nothing outside it. Two requests
 * rendering at once each see their own.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Child } from './jsx-runtime.ts'
import type { PageProps } from './model.ts'

interface RenderScope {
  page: PageProps | undefined
  contexts: ReadonlyMap<symbol, unknown>
  /** Shared by every scope a provider opens inside one render, so ids stay unique. */
  ids: { next: number }
}

/**
 * Kept on `globalThis` so that two copies of this module, a site's and the
 * server's, share one store rather than each seeing nothing of the other's.
 */
const KEY = Symbol.for('crombolo.render-scope')
const shared = globalThis as Record<symbol, unknown>
if (!shared[KEY]) shared[KEY] = new AsyncLocalStorage<RenderScope>()
const store = shared[KEY] as AsyncLocalStorage<RenderScope>

/** Runs a render with `page` available to `usePage()`, and ids counted from zero. */
export function renderScope<T>(page: PageProps, render: () => T): T {
  return store.run({ page, contexts: new Map(), ids: { next: 0 } }, render)
}

function within(caller: string): RenderScope {
  const scope = store.getStore()
  if (!scope)
    throw new Error(
      `${caller} can only be called while a page is rendering: in a component, not at the top of a module or later in a timer.`,
    )
  return scope
}

/**
 * The page being rendered, from any component: `model`, `nav`, `culture`,
 * `member`, `signal` and the rest of what a template is given. Name the page's
 * generated interface to type it: `usePage<HomePage>()`.
 */
// biome-ignore lint/suspicious/noExplicitAny: an untyped page, as `PageProps` defaults to.
export function usePage<Properties = any>(): PageProps<Properties> {
  const { page } = within('usePage()')
  if (!page)
    throw new Error('usePage() was called inside a context Provider rendered outside a page.')
  return page as PageProps<Properties>
}

/**
 * An id unique within this render, for tying a label to its input or an
 * `aria-describedby` to its text. Not for CSS selectors: the colons need escaping.
 */
export function useId(): string {
  return `:b${within('useId()').ids.next++}:`
}

export interface ProviderProps<T> {
  value: T
  /**
   * A function, unlike React: children written plainly have already rendered by
   * the time the provider runs, so they could not see its value.
   */
  children: () => Child
}

/** A context: render it, or its `Provider`, to hand a value to everything inside. */
export interface Context<T> {
  (props: ProviderProps<T>): Child
  readonly Provider: (props: ProviderProps<T>) => Child
  readonly defaultValue: T
  readonly key: symbol
}

/**
 * A value handed down without props:
 *
 * ```tsx
 * const Theme = createContext('light')
 * <Theme.Provider value="dark">{() => <Sidebar />}</Theme.Provider>
 * // and in Sidebar, however deep: useContext(Theme)
 * ```
 */
export function createContext<T>(defaultValue: T): Context<T> {
  const key = Symbol('context')
  const Provider = ({ value, children }: ProviderProps<T>): Child => {
    if (typeof children !== 'function')
      throw new Error(
        'A context Provider takes its children as a function, {() => <Sidebar />}. Written plainly they have already rendered, without its value.',
      )
    const outer = store.getStore()
    const contexts = new Map(outer?.contexts)
    contexts.set(key, value)
    return store.run({ page: outer?.page, contexts, ids: outer?.ids ?? { next: 0 } }, children)
  }
  return Object.assign(Provider, { Provider, defaultValue, key }) as Context<T>
}

/** The value of the nearest provider of `context` around this component, or its default. */
export function useContext<T>(context: Context<T>): T {
  const contexts = store.getStore()?.contexts
  return contexts?.has(context.key) ? (contexts.get(context.key) as T) : context.defaultValue
}
