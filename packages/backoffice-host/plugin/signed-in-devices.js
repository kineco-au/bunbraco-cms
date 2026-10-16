/**
 * The terminals signed in as the current person (story 107), in their profile:
 * each one named, when it signed in and was last used, and signed out from here.
 */
import { css, html, nothing } from '@umbraco-cms/backoffice/external/lit'
import { UmbLitElement } from '@umbraco-cms/backoffice/lit-element'

const API = '/umbraco/management/api/v1/security/back-office/devices'

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—')

export default class CromboloSignedInDevicesElement extends UmbLitElement {
  static properties = { _devices: { state: true }, _error: { state: true } }

  constructor() {
    super()
    this._devices = undefined
    this._error = ''
  }

  connectedCallback() {
    super.connectedCallback()
    this.#load()
  }

  async #load() {
    try {
      const response = await fetch(API, { credentials: 'include' })
      this._devices = response.ok ? await response.json() : []
    } catch {
      this._error = 'Could not load your signed-in devices.'
    }
  }

  async #signOut(id) {
    const response = await fetch(`${API}/${id}`, { method: 'DELETE', credentials: 'include' })
    if (!response.ok) this._error = 'That device could not be signed out.'
    await this.#load()
  }

  render() {
    if (!this._devices) return nothing
    return html`<uui-box headline="Signed-in devices">
      ${this._error ? html`<p class="error">${this._error}</p>` : nothing}
      ${
        this._devices.length === 0
          ? html`<p>No terminals are signed in as you.</p>`
          : html`<ul>
              ${this._devices.map(
                (device) => html`<li>
                  <div>
                    <strong>${device.name ?? 'A terminal'}</strong>
                    <small>signed in ${when(device.signedInAt)}, last used ${when(device.lastUsedAt)}</small>
                  </div>
                  <uui-button look="secondary" label="Sign out" @click=${() => this.#signOut(device.id)}></uui-button>
                </li>`,
              )}
            </ul>`
      }
    </uui-box>`
  }

  static styles = css`
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--uui-size-space-4);
      padding: var(--uui-size-space-3) 0;
      border-bottom: 1px solid var(--uui-color-divider);
    }
    li div {
      display: flex;
      flex-direction: column;
    }
    small {
      color: var(--uui-color-text-alt);
    }
    .error {
      color: var(--uui-color-danger);
    }
  `
}

customElements.define('crombolo-signed-in-devices', CromboloSignedInDevicesElement)
