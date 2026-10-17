/**
 * The "Search & sharing" view on a page whose type includes those fields: how
 * the page will look in search results, and where each value comes from.
 *
 * The values come from the server, which works them out with the same code the
 * page's head uses, so the preview cannot disagree with what is served. It
 * reads the last saved version, so an editor sees a change once it is saved.
 */
import { UMB_DOCUMENT_WORKSPACE_CONTEXT } from '@umbraco-cms/backoffice/document'
import { css, html, nothing } from '@umbraco-cms/backoffice/external/lit'
import { UmbLitElement } from '@umbraco-cms/backoffice/lit-element'
import { UMB_PROPERTY_DATASET_CONTEXT } from '@umbraco-cms/backoffice/property'
import { readPreview } from './client.js'

const SOURCES = {
  page: 'From this page',
  template: 'From the page design',
  site: 'Site setting',
  name: 'Page name',
  none: 'Not set',
}

export default class CromboloSeoDocumentViewElement extends UmbLitElement {
  static properties = {
    _preview: { state: true },
    _error: { state: true },
  }

  #unique = undefined
  #culture = null

  constructor() {
    super()
    this.consumeContext(UMB_DOCUMENT_WORKSPACE_CONTEXT, (context) => {
      if (!context) return
      this.observe(context.unique, (unique) => {
        this.#unique = unique
        this.#load()
      })
    })
    this.consumeContext(UMB_PROPERTY_DATASET_CONTEXT, (dataset) => {
      this.#culture = dataset?.getVariantId?.()?.culture ?? null
      this.#load()
    })
  }

  async #load() {
    if (!this.#unique) return
    try {
      this._preview = await readPreview(this.#unique, this.#culture)
      this._error = undefined
    } catch (error) {
      this._error = error.message
    }
  }

  #row(label, item, render = (value) => value) {
    return html`
      <tr>
        <th>${label}</th>
        <td>${item.value ? render(item.value) : html`<em>Nothing yet</em>`}</td>
        <td><uui-tag look="secondary">${SOURCES[item.source] ?? item.source}</uui-tag></td>
      </tr>
    `
  }

  render() {
    if (this._error) return html`<uui-box><p>${this._error}</p></uui-box>`
    const preview = this._preview
    if (!preview) return html`<uui-loader></uui-loader>`
    const { meta, snippet } = preview
    return html`
      <uui-box headline="In search results">
        <div class="snippet">
          <div class="url">${snippet.url || 'This page has no address yet'}</div>
          <div class="title">${snippet.title}</div>
          <div class="description">
            ${snippet.description || html`<em>Search engines will pick some text from the page.</em>`}
          </div>
        </div>
        ${
          meta.noindex.value
            ? html`<p class="warning">
                ${
                  meta.noindex.source === 'site'
                    ? 'The whole site is hidden from search engines in Settings.'
                    : 'This page asks search engines to leave it out of their results.'
                }
              </p>`
            : nothing
        }
        <p class="note">
          Shows the last saved version${preview.published ? '' : ', which is not published yet'}.
        </p>
      </uui-box>
      <uui-box headline="Where each value comes from">
        <table>
          ${this.#row('Title', meta.title)}
          ${this.#row('Description', meta.description)}
          ${this.#row('Sharing image', meta.image, (src) => html`<img src=${src} alt="" />`)}
          ${this.#row('Preferred address', meta.canonical)}
        </table>
      </uui-box>
    `
  }

  static styles = css`
    :host {
      display: block;
      padding: var(--uui-size-layout-1);
    }
    uui-box + uui-box {
      margin-top: var(--uui-size-layout-1);
    }
    .snippet {
      max-width: 600px;
      font-family: arial, sans-serif;
    }
    .snippet .url {
      color: var(--uui-color-text-alt);
      font-size: 14px;
      overflow-wrap: anywhere;
    }
    .snippet .title {
      /* A search result's link blue: Google's own, light and dark. */
      color: var(--crombolo-snippet-title, #1a0dab);
      font-size: 20px;
      margin: 4px 0;
    }
    .snippet .description {
      color: var(--uui-color-text);
      font-size: 14px;
    }
    .warning {
      color: var(--uui-color-danger);
    }
    .note {
      color: var(--uui-color-text-alt);
      font-size: 12px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th,
    td {
      text-align: left;
      padding: var(--uui-size-space-3);
      border-bottom: 1px solid var(--uui-color-divider);
      vertical-align: top;
    }
    th {
      width: 12em;
    }
    img {
      max-width: 240px;
      max-height: 140px;
    }
  `
}

customElements.define('crombolo-seo-document-view', CromboloSeoDocumentViewElement)
