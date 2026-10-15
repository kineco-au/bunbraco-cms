/**
 * Page addresses: whether the top-level page's name is part of every address
 * below it, as Umbraco's `HideTopLevelNodeFromPath` sets it. Saving moves the
 * addresses, and the old ones redirect to the new. docs/rendering.md, "URLs".
 */
import { css, html, LitElement, nothing } from '@umbraco-cms/backoffice/external/lit'

const endpoint = () =>
  `${(document.querySelector('base')?.getAttribute('href') ?? '/umbraco/').replace(/\/$/, '')}/crombolo/api/url-options`

export default class CromboloAddressesDashboardElement extends LitElement {
  static properties = {
    _settings: { state: true },
    _showTopLevel: { state: true },
    _message: { state: true },
    _busy: { state: true },
  }

  constructor() {
    super()
    this._settings = undefined
    this._showTopLevel = false
    this._message = undefined
    this._busy = false
  }

  connectedCallback() {
    super.connectedCallback()
    this.#load()
  }

  async #load() {
    const response = await fetch(endpoint(), {
      credentials: 'include',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      this._message = 'The address settings could not be read.'
      return
    }
    this._settings = await response.json()
    this._showTopLevel = !this._settings.hideTopLevel
  }

  async #save() {
    this._busy = true
    try {
      const response = await fetch(endpoint(), {
        method: 'PUT',
        credentials: 'include',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ hideTopLevel: !this._showTopLevel }),
      })
      const result = await response.json().catch(() => ({}))
      this._message = response.ok
        ? 'Saved. Pages that moved still answer on their old addresses, which now redirect.'
        : (result.message ?? 'The setting was not saved.')
      if (response.ok) this._settings = result
    } finally {
      this._busy = false
    }
  }

  render() {
    if (!this._settings)
      return html`<uui-box headline="Page addresses">${this._message ?? html`<uui-loader></uui-loader>`}</uui-box>`
    const changed = this._showTopLevel === this._settings.hideTopLevel
    return html`
      <uui-box headline="Page addresses">
        <p>
          Normally the first top-level page is the home page at <code>/</code>, and the top-level
          page's name is left out of the addresses of the pages below it.
        </p>
        <uui-toggle
          label="Include the top-level page in addresses"
          .checked=${this._showTopLevel}
          ?disabled=${!this._settings.editable || this._busy}
          @change=${(e) => (this._showTopLevel = e.target.checked)}
        >Include the top-level page in addresses</uui-toggle>
        <p class="example">
          A page called News under a top-level page called Home is at
          <code>${this._showTopLevel ? '/home/news/' : '/news/'}</code>.
        </p>
        ${
          this._settings.editable
            ? html`<uui-button look="primary" label="Save" ?disabled=${!changed || this._busy} @click=${() => this.#save()}>Save</uui-button>`
            : html`<p class="note">This site keeps this setting with its files, so it is changed there rather than here.</p>`
        }
        ${this._message ? html`<p>${this._message}</p>` : nothing}
      </uui-box>
    `
  }

  static styles = css`
    :host { display: block; padding: var(--uui-size-layout-1); }
    .example, .note { color: var(--uui-color-text-alt); }
  `
}

customElements.define('crombolo-addresses-dashboard', CromboloAddressesDashboardElement)
