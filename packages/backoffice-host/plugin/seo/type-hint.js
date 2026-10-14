/**
 * A note in the document-type workspace footer for the "Search & sharing" type:
 * its own fields come with the CMS and stay, but a site may add fields beside
 * them. The server refuses removing or changing them; this says so up front.
 */
import { UMB_DOCUMENT_TYPE_WORKSPACE_CONTEXT } from '@umbraco-cms/backoffice/document-type'
import { UmbElementMixin } from '@umbraco-cms/backoffice/element-api'
import { css, html, LitElement, nothing } from '@umbraco-cms/backoffice/external/lit'

const SEO_FIELDS_KEY = '5e0f1c2a-7b3d-4c8e-9a61-0d2b4f6e8a13'

export default class CromboloSeoFieldsHintElement extends UmbElementMixin(LitElement) {
  static properties = { _unique: { state: true } }

  constructor() {
    super()
    this._unique = undefined
    this.consumeContext(UMB_DOCUMENT_TYPE_WORKSPACE_CONTEXT, (context) => {
      if (!context) return
      this.observe(context.unique, (value) => {
        this._unique = value
      })
    })
  }

  render() {
    if (this._unique?.toLowerCase() !== SEO_FIELDS_KEY) return nothing
    return html`<uui-tag
      color="default"
      look="secondary"
      title="Pages that include this type get these fields for search results and sharing. The fields it comes with cannot be removed or changed, but you can add your own beside them."
    >
      Provided by Crombolo — add your own fields beside these
    </uui-tag>`
  }

  static styles = css`
    :host {
      display: flex;
      align-items: center;
    }
  `
}

customElements.define('crombolo-seo-fields-hint', CromboloSeoFieldsHintElement)
