/**
 * A hint in the document-type workspace footer, for the one thing about element
 * types that nobody finds on their own: making a type an element type does not put
 * it in the Library. That takes a second toggle, **Allow in Library**, on a
 * different tab — and Umbraco's own "no allowed Element Types" message in the
 * Library's create dialog never appears, because Folder is always an option there,
 * so the dialog is never empty enough to explain itself.
 *
 * Both flags are worth keeping: most element types exist for block editors and
 * should stay out of the Library. This says so rather than changing it.
 *
 * Registered as a `workspaceFooterApp` conditioned on the document-type workspace,
 * not patched into Umbraco's own view — a manifest is the supported extension
 * point, so an upstream bump cannot silently drop it.
 */

import { UMB_DOCUMENT_TYPE_WORKSPACE_CONTEXT } from '@umbraco-cms/backoffice/document-type'
import { UmbElementMixin } from '@umbraco-cms/backoffice/element-api'
import { css, html, LitElement, nothing } from '@umbraco-cms/backoffice/external/lit'

export default class BunbracoElementTypeHintElement extends UmbElementMixin(LitElement) {
  static properties = { _isElement: { state: true }, _allowedInLibrary: { state: true } }

  constructor() {
    super()
    this._isElement = false
    this._allowedInLibrary = false
    this.consumeContext(UMB_DOCUMENT_TYPE_WORKSPACE_CONTEXT, (context) => {
      if (!context) return
      this.observe(context.isElement, (value) => {
        this._isElement = Boolean(value)
      })
      this.observe(context.allowedInLibrary, (value) => {
        this._allowedInLibrary = Boolean(value)
      })
    })
  }

  render() {
    if (!this._isElement || this._allowedInLibrary) return nothing
    return html`<uui-tag
      color="default"
      look="secondary"
      title="An element type is only offered in the Library's Create dialog when 'Allow in Library' is on, under the Structure tab. Leave it off for an element type that exists for block editors."
    >
      Not in the Library — see Structure
    </uui-tag>`
  }

  static styles = css`
    :host {
      display: flex;
      align-items: center;
    }
  `
}

customElements.define('bunbraco-element-type-hint', BunbracoElementTypeHintElement)
