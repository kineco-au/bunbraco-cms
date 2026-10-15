/**
 * The Installed view, in place of Umbraco's.
 *
 * Its manifest declares `overwrites: ['Umb.SectionView.Packages.Installed']`.
 * Umbraco's view is built around package migrations — it lists installed
 * packages so that pending C# migrations can be run. Nothing carries those here
 * (`docs/bundles.md`), so the view would be a list of nothing with a button
 * that cannot apply.
 *
 * What it lists instead is the site's bundle dependencies, which is what
 * "installed" means here: what each one adds, whether its content has been
 * added to this site, and whether its server features are switched on.
 *
 * Two columns: the bundles on the left, filtered as you type; the one chosen
 * on the right, with its details and the button that uninstalls it.
 */
import { css, html, nothing, repeat } from '@umbraco-cms/backoffice/external/lit'
import { UmbLitElement } from '@umbraco-cms/backoffice/lit-element'
import { carriesTags } from './bundles-carries.js'
import { listInstalled, uninstallBundle } from './bundles-client.js'

/** Where each part of a bundle stands on this site, in the words of someone running it. */
function status(item) {
  const parts = []
  if (item.carries?.content)
    parts.push(
      item.contentApplied
        ? html`<span>Content added (${item.contentApplied})</span>`
        : html`<span>Content not added yet</span>`,
    )
  if (item.carries?.server)
    parts.push(
      item.wired
        ? html`<span>Server features on</span>`
        : html`<span>Server features off until the site's configuration includes it</span>`,
    )
  return parts.length > 0 ? parts : html`<span>Ready</span>`
}

export default class CromboloBundlesInstalledElement extends UmbLitElement {
  static properties = {
    _items: { state: true },
    _loading: { state: true },
    _busy: { state: true },
    _notice: { state: true },
    _installs: { state: true },
    _filter: { state: true },
    _selected: { state: true },
  }

  constructor() {
    super()
    this._items = []
    this._loading = true
    this._busy = ''
    this._notice = ''
    this._installs = true
    this._filter = ''
    this._selected = ''
  }

  connectedCallback() {
    super.connectedCallback()
    this.#load()
  }

  async #load() {
    this._loading = true
    try {
      const result = await listInstalled()
      this._items = result.items ?? []
      this._installs = result.installs !== false
      if (!this._items.some((item) => item.packageName === this._selected))
        this._selected = this._items[0]?.packageName ?? ''
    } catch (error) {
      this._notice = error instanceof Error ? error.message : String(error)
    } finally {
      this._loading = false
    }
  }

  async #uninstall(item) {
    this._busy = item.packageName
    try {
      const outcome = await uninstallBundle(item.packageName)
      this._notice = outcome.message ?? ''
      if (outcome.ok) await this.#load()
    } catch (error) {
      this._notice = error instanceof Error ? error.message : String(error)
    } finally {
      this._busy = ''
    }
  }

  #pick(item) {
    this._selected = item.packageName
    this.requestUpdate()
  }

  get #shown() {
    const words = this._filter.trim().toLowerCase()
    if (!words) return this._items
    return this._items.filter((item) =>
      [item.name, item.packageName, item.description].some((text) =>
        text?.toLowerCase().includes(words),
      ),
    )
  }

  render() {
    if (this._loading) return html`<div id="loader"><uui-loader></uui-loader></div>`
    if (this._items.length === 0)
      return html`
        ${this._notice ? html`<div id="notice">${this._notice}</div>` : nothing}
        <uui-box headline="No bundles installed">
          <p>Install one from the Marketplace tab, and it appears here.</p>
        </uui-box>
      `
    const selected = this._items.find((item) => item.packageName === this._selected)
    const shown = this.#shown
    return html`
      ${this._notice ? html`<div id="notice">${this._notice}</div>` : nothing}
      <div id="columns">
        <uui-box headline="Installed bundles" style="--uui-box-default-padding:0;">
          <div id="filter">
            <uui-input
              label="Filter"
              placeholder="Filter"
              .value=${this._filter}
              @input=${(event) => {
                this._filter = event.target.value
              }}>
              <uui-icon name="icon-search" slot="prepend"></uui-icon>
            </uui-input>
          </div>
          ${
            shown.length === 0
              ? html`<p class="empty">No bundle matches.</p>`
              : html`<uui-ref-list>
                  ${repeat(
                    shown,
                    (item) => item.packageName,
                    (item) => html`<uui-ref-node
                      name=${item.name}
                      detail=${`${item.packageName} ${item.version}`}
                      selectable
                      select-only
                      ?selected=${item.packageName === this._selected}
                      @selected=${() => this.#pick(item)}
                      @deselected=${() => this.#pick(item)}
                      @open=${() => this.#pick(item)}></uui-ref-node>`,
                  )}
                </uui-ref-list>`
          }
        </uui-box>
        ${selected ? this.#details(selected) : nothing}
      </div>
    `
  }

  #details(item) {
    return html`<uui-box headline=${item.name}>
      ${item.description ? html`<p>${item.description}</p>` : nothing}
      <dl>
        <dt>npm package</dt>
        <dd><code>${item.packageName}</code></dd>
        <dt>Version</dt>
        <dd>${item.version}</dd>
        <dt>Adds</dt>
        <dd class="carries">${carriesTags(item.carries)}</dd>
        <dt>On this site</dt>
        <dd class="status">${status(item)}</dd>
        <dt>Works with</dt>
        <dd>Crombolo ${item.peerRange}</dd>
      </dl>
      ${
        this._installs
          ? html`<uui-button
              look="primary"
              color="danger"
              label="Uninstall"
              .state=${this._busy === item.packageName ? 'waiting' : undefined}
              @click=${() => this.#uninstall(item)}></uui-button>`
          : html`<p class="note">This site adds and removes bundles with a deploy, so every server has the same ones.</p>`
      }
    </uui-box>`
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
    #notice {
      margin-bottom: var(--uui-size-space-4, 12px);
      padding: var(--uui-size-space-4, 12px);
      border-left: 3px solid var(--uui-color-positive, #2bc37c);
      background: var(--uui-color-surface-alt, #f3f3f5);
    }
    #columns {
      display: grid;
      grid-template-columns: minmax(240px, 1fr) 2fr;
      gap: var(--uui-size-layout-1, 24px);
      align-items: start;
    }
    @media (max-width: 800px) {
      #columns {
        grid-template-columns: 1fr;
      }
    }
    #filter {
      padding: var(--uui-size-space-4, 12px);
    }
    #filter uui-input {
      width: 100%;
    }
    .empty {
      padding: 0 var(--uui-size-space-4, 12px) var(--uui-size-space-4, 12px);
    }
    p {
      max-width: 60ch;
      line-height: 1.5;
    }
    dl {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: var(--uui-size-space-3, 9px) var(--uui-size-space-5, 18px);
      margin: 0 0 var(--uui-size-space-5, 18px);
    }
    dt {
      font-weight: 700;
    }
    dd {
      margin: 0;
    }
    .carries {
      display: flex;
      gap: var(--uui-size-space-2, 6px);
    }
    .status span {
      display: block;
    }
    .note {
      opacity: 0.8;
      font-size: 0.9em;
    }
  `
}

customElements.define('crombolo-bundles-installed', CromboloBundlesInstalledElement)
