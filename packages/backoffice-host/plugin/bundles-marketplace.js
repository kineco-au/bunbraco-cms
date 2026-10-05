/**
 * The Marketplace view, in place of Umbraco's.
 *
 * Its manifest declares `overwrites: ['Umb.SectionView.Packages.Marketplace']`.
 * What it replaces is an iframe of marketplace.umbraco.com, which cannot work
 * here twice over: npm refuses to be framed (`x-frame-options: SAMEORIGIN`), and
 * an Umbraco package does not install into this CMS anyway.
 *
 * What it shows instead is the npm registry, searched for the keyword a bunbraco
 * bundle publishes, and filtered to the ones that really declare backoffice
 * extensions. Installing runs `bun add` on the server.
 */
import { css, html, nothing, repeat } from '@umbraco-cms/backoffice/external/lit'
import { UmbLitElement } from '@umbraco-cms/backoffice/lit-element'
import { installBundle, searchMarketplace } from './bundles-client.js'

export default class BunbracoBundlesMarketplaceElement extends UmbLitElement {
  static properties = {
    _items: { state: true },
    _loading: { state: true },
    _error: { state: true },
    _busy: { state: true },
    _notice: { state: true },
    _keyword: { state: true },
    _url: { state: true },
  }

  constructor() {
    super()
    this._items = []
    this._loading = true
    this._error = ''
    this._busy = ''
    this._notice = ''
    this._keyword = 'bunbraco-bundle'
    this._url = ''
    this._query = ''
  }

  connectedCallback() {
    super.connectedCallback()
    this.#load()
  }

  async #load() {
    this._loading = true
    this._error = ''
    try {
      const result = await searchMarketplace(this._query)
      this._items = result.items ?? []
      this._keyword = result.keyword ?? this._keyword
      this._url = result.url ?? ''
    } catch (error) {
      this._error = error instanceof Error ? error.message : String(error)
    } finally {
      this._loading = false
    }
  }

  #search(event) {
    this._query = event.target.value ?? ''
    this.#load()
  }

  async #install(item) {
    this._busy = item.name
    this._notice = ''
    try {
      const outcome = await installBundle(item.name, item.version)
      // The dependency line is what there is to commit, so it is shown rather
      // than described: the install lives in this node's node_modules until it
      // is in the site's repository.
      this._notice = outcome.dependency
        ? `${outcome.message} — "${outcome.dependency.name}": "${outcome.dependency.range}"`
        : (outcome.message ?? '')
      if (outcome.ok) await this.#load()
    } catch (error) {
      this._notice = error instanceof Error ? error.message : String(error)
    } finally {
      this._busy = ''
    }
  }

  #empty() {
    return html`
      <uui-box headline="No bundles published yet">
        <p>Nothing on npm carries the <code>${this._keyword}</code> keyword yet.</p>
      </uui-box>
    `
  }

  render() {
    if (this._loading && this._items.length === 0)
      return html`<div id="loader"><uui-loader></uui-loader></div>`

    return html`
      <div id="head">
        <uui-input
          type="search"
          label="Search bundles"
          placeholder="Search npm for bundles"
          @change=${this.#search}></uui-input>
        ${
          this._url
            ? html`<a href=${this._url} target="_blank" rel="noopener">Browse on npm</a>`
            : nothing
        }
      </div>
      ${this._error ? html`<uui-box headline="The registry could not be reached"><p>${this._error}</p></uui-box>` : nothing}
      ${this._notice ? html`<div id="notice">${this._notice}</div>` : nothing}
      ${
        this._items.length === 0 && !this._error
          ? this.#empty()
          : html`
            <div id="list">
              ${repeat(
                this._items,
                (item) => item.name,
                (item) => html`
                  <uui-box>
                    <div slot="headline">${item.name} <small>${item.version}</small></div>
                    <p>${item.description || 'No description.'}</p>
                    <p class="meta">
                      ${item.publisher ? html`<span>by ${item.publisher}</span>` : nothing}
                      <a href=${item.links.npm} target="_blank" rel="noopener">npm</a>
                      ${
                        item.links.repository
                          ? html`<a href=${item.links.repository} target="_blank" rel="noopener">source</a>`
                          : nothing
                      }
                    </p>
                    ${
                      item.installedVersion
                        ? html`<uui-tag look="positive">Installed ${item.installedVersion}</uui-tag>`
                        : html`
                          <uui-button
                            look="primary"
                            label="Install"
                            .state=${this._busy === item.name ? 'waiting' : undefined}
                            @click=${() => this.#install(item)}></uui-button>
                        `
                    }
                  </uui-box>
                `,
              )}
            </div>
          `
      }
    `
  }

  static styles = css`
    :host {
      display: block;
      padding: var(--uui-size-layout-1, 24px);
    }
    #loader {
      display: flex;
      justify-content: center;
      padding: var(--uui-size-layout-3, 48px);
    }
    #head {
      display: flex;
      align-items: center;
      gap: var(--uui-size-space-4, 12px);
      margin-bottom: var(--uui-size-space-5, 18px);
    }
    #head uui-input {
      flex: 1;
    }
    #notice {
      margin-bottom: var(--uui-size-space-4, 12px);
      padding: var(--uui-size-space-4, 12px);
      border-left: 3px solid var(--uui-color-positive, #2bc37c);
      background: var(--uui-color-surface-alt, #f3f3f5);
    }
    #list {
      display: grid;
      gap: var(--uui-size-space-5, 18px);
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    }
    p {
      max-width: 60ch;
      line-height: 1.5;
    }
    .meta {
      display: flex;
      gap: var(--uui-size-space-4, 12px);
      font-size: 0.9em;
      opacity: 0.8;
    }
    small {
      opacity: 0.7;
      font-weight: normal;
    }
  `
}

customElements.define('bunbraco-bundles-marketplace', BunbracoBundlesMarketplaceElement)
