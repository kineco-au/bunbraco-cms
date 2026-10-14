/**
 * The same JSX runtime with unchecked attributes: any attribute on any tag, and
 * a JSX expression typed as text. For a site that is upgrading and has views
 * the checked types would flag; set `"jsxImportSource": "@crombolo/crombolo/loose"`.
 * What renders is identical either way.
 */
import type { Child, ElementProps } from '../jsx-runtime.ts'

export type { Child, ElementProps } from '../jsx-runtime.ts'
export { Fragment, jsx, jsxDEV, jsxs } from '../jsx-runtime.ts'

export declare namespace JSX {
  type Element = string
  type ElementType = string | ((props: never) => Child)
  interface IntrinsicElements {
    [tag: string]: ElementProps
  }
  interface ElementChildrenAttribute {
    children: unknown
  }
}
