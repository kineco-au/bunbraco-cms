/**
 * Sets up an authenticator app for the signed-in user (story 032): the QR code,
 * the first code to prove the app has it, then the recovery codes, shown once.
 * Umbraco's own setup screen throws the recovery codes away, hence this one.
 */

import { UmbCurrentUserRepository } from '@umbraco-cms/backoffice/current-user'
import { css, html, nothing } from '@umbraco-cms/backoffice/external/lit'
import { UmbLitElement } from '@umbraco-cms/backoffice/lit-element'

const endpoint = (providerName) =>
  `${(document.querySelector('base')?.getAttribute('href') ?? '/umbraco/').replace(/\/$/, '')}/management/api/v1/user/current/2fa/${encodeURIComponent(providerName)}`

export default class CromboloTwoFactorSetupElement extends UmbLitElement {
  static properties = {
    providerName: { attribute: false },
    displayName: { attribute: false },
    close: { attribute: false },
    _setup: { state: true },
    _error: { state: true },
    _codes: { state: true },
    _busy: { state: true },
  }

  constructor() {
    super()
    this.providerName = ''
    this.displayName = ''
    this.close = () => {}
    this._setup = undefined
    this._error = undefined
    this._codes = undefined
    this._busy = false
    this.#repository = new UmbCurrentUserRepository(this)
  }

  #repository

  async firstUpdated() {
    const response = await fetch(endpoint(this.providerName), {
      credentials: 'include',
      headers: { accept: 'application/json' },
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || !body.secret) {
      this._error = body.detail ?? 'Two-factor sign-in cannot be set up right now.'
      return
    }
    this._setup = body
  }

  async #submit(event) {
    event.preventDefault()
    const code = new FormData(event.target).get('code')?.toString().trim()
    if (!code) return
    this._busy = true
    this._error = undefined
    const response = await fetch(endpoint(this.providerName), {
      method: 'POST',
      credentials: 'include',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ code, secret: this._setup.secret }),
    })
    const body = await response.json().catch(() => ({}))
    this._busy = false
    if (!response.ok) {
      this._error = body.detail ?? 'That code is not right. Try the next one.'
      return
    }
    this._codes = body.recoveryCodes ?? []
  }

  async #done() {
    await this.#repository.requestMfaLoginProviders()
    this.close()
  }

  #copy() {
    navigator.clipboard?.writeText(this._codes.join('\n'))
  }

  render() {
    return html`<umb-body-layout headline=${this.displayName || 'Authenticator app'}>
      ${this._codes ? this.#renderCodes() : this.#renderSetup()}
    </umb-body-layout>`
  }

  #renderSetup() {
    if (!this._setup)
      return this._error
        ? html`<p class="error">${this._error}</p>
            <div slot="actions"><uui-button label="Close" @click=${() => this.close()}></uui-button></div>`
        : html`<uui-loader-bar></uui-loader-bar>`
    return html`<form id="setup" @submit=${this.#submit} novalidate>
        <p>Scan this code with your authenticator app, then enter the six-digit code it shows.</p>
        <img class="qr" src=${this._setup.qrCodeSetupImageUrl} alt="QR code for your authenticator app" />
        <p class="secret">Or enter this key by hand: <code>${this._setup.secret}</code></p>
        <uui-form-layout-item>
          <uui-label slot="label" for="code" required>Code from the app</uui-label>
          <uui-input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" label="Code from the app" required></uui-input>
        </uui-form-layout-item>
        ${this._error ? html`<p class="error">${this._error}</p>` : nothing}
      </form>
      <div slot="actions">
        <uui-button label="Cancel" @click=${() => this.close()}></uui-button>
        <uui-button type="submit" form="setup" look="primary" color="positive" label="Turn on" .state=${this._busy ? 'waiting' : undefined}
          @click=${() => this.renderRoot.querySelector('#setup')?.requestSubmit()}></uui-button>
      </div>`
  }

  #renderCodes() {
    return html`<p>Two-factor sign-in is on. Keep these recovery codes somewhere safe: each one
        signs you in once if you lose your phone. They will not be shown again.</p>
      <ul class="codes">${this._codes.map((code) => html`<li><code>${code}</code></li>`)}</ul>
      <div slot="actions">
        <uui-button label="Copy codes" @click=${this.#copy}></uui-button>
        <uui-button look="primary" label="Done" @click=${this.#done}></uui-button>
      </div>`
  }

  static styles = css`
    .qr {
      display: block;
      width: 200px;
      height: 200px;
      margin: var(--uui-size-space-4) auto;
      /* White in every mode: a scanner reads dark modules on a light ground. */
      background: #fff;
    }
    .secret code,
    .codes code {
      font-family: monospace;
      word-break: break-all;
    }
    .codes {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: var(--uui-size-space-2);
      padding: 0;
      list-style: none;
    }
    .error {
      color: var(--uui-color-danger);
    }
  `
}

customElements.define('crombolo-two-factor-setup', CromboloTwoFactorSetupElement)
