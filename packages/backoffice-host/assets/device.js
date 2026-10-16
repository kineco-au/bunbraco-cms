/**
 * The page a person approves a command-line sign-in on (story 107, RFC 8628).
 * The `crombolo` command shows a code and opens this page; the person, already
 * signed in here, checks the code matches and allows it — or declines.
 */
import { css, html, LitElement, nothing } from '@umbraco-cms/backoffice/external/lit'
import '@umbraco-cms/backoffice/external/uui'

const API = '/umbraco/management/api/v1/security/back-office'

class CromboloDeviceElement extends LitElement {
  static properties = {
    userCode: { type: String, attribute: 'user-code' },
    logoImage: { type: String, attribute: 'logo-image' },
    _pending: { state: true },
    _error: { state: true },
    _done: { state: true },
    _busy: { state: true },
  }

  constructor() {
    super()
    this.userCode = ''
    this.logoImage = ''
    this._pending = undefined
    this._error = ''
    this._done = ''
    this._busy = false
  }

  connectedCallback() {
    super.connectedCallback()
    if (this.userCode) this.#look(this.userCode)
  }

  async #look(code) {
    this._error = ''
    this._busy = true
    try {
      const response = await fetch(`${API}/device/pending?user_code=${encodeURIComponent(code)}`, {
        credentials: 'include',
      })
      if (response.ok) {
        this._pending = await response.json()
        return
      }
      const problem = await response.json().catch(() => ({}))
      this._error = problem.detail ?? problem.title ?? 'That code is not waiting.'
    } catch {
      this._error = 'Could not reach the server.'
    } finally {
      this._busy = false
    }
  }

  async #decide(approve) {
    this._busy = true
    try {
      const response = await fetch(`${API}/device/decide`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userCode: this._pending.userCode, approve }),
      })
      if (!response.ok) {
        this._error = 'That code is no longer waiting. Start the sign-in again.'
        this._pending = undefined
        return
      }
      this._done = approve
        ? 'Signed in. You can close this window and go back to your terminal.'
        : 'Declined. Nothing was signed in.'
    } catch {
      this._error = 'Could not reach the server.'
    } finally {
      this._busy = false
    }
  }

  #submitCode(event) {
    event.preventDefault()
    const code = event.target.elements.code.value.trim()
    if (code) this.#look(code)
  }

  #body() {
    if (this._done) return html`<p id="notice" role="status">${this._done}</p>`
    if (this._pending)
      return html`
        <p>
          ${this._pending.clientName ?? 'A command line'} is asking to sign in as you. Check that this
          code matches the one it shows:
        </p>
        <p id="code">${this._pending.userCode}</p>
        ${this._error ? html`<p id="error" role="alert">${this._error}</p>` : nothing}
        <div id="actions">
          <uui-button look="primary" color="positive" label="Allow" .state=${this._busy ? 'waiting' : undefined}
            @click=${() => this.#decide(true)}></uui-button>
          <uui-button look="outline" label="Decline" @click=${() => this.#decide(false)}></uui-button>
        </div>`
    return html`
      <form @submit=${this.#submitCode}>
        <uui-form-layout-item>
          <uui-label for="code" slot="label" required>The code your terminal shows</uui-label>
          <uui-input id="code" name="code" autocomplete="off" required .value=${this.userCode ?? ''}></uui-input>
        </uui-form-layout-item>
        ${this._error ? html`<p id="error" role="alert">${this._error}</p>` : nothing}
        <uui-button type="submit" look="primary" label="Continue" .state=${this._busy ? 'waiting' : undefined}></uui-button>
      </form>`
  }

  render() {
    return html`
      <div id="layout">
        <uui-box id="card">
          ${this.logoImage ? html`<img id="logo" src=${this.logoImage} alt="" />` : nothing}
          <h1 class="uui-h3">Sign in from your terminal</h1>
          ${this.#body()}
        </uui-box>
      </div>
    `
  }

  static styles = css`
    :host {
      display: block;
      min-height: 100vh;
      background: var(--uui-color-surface-alt, #f4f4f4);
    }
    #layout {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 16px;
      box-sizing: border-box;
    }
    #card {
      width: 100%;
      max-width: 420px;
    }
    #logo {
      display: block;
      height: 48px;
      margin-bottom: var(--uui-size-space-4, 12px);
    }
    h1 {
      margin: 0 0 var(--uui-size-space-5, 18px);
    }
    form {
      display: flex;
      flex-direction: column;
      gap: var(--uui-size-space-4, 12px);
    }
    uui-input {
      width: 100%;
    }
    #code {
      font-family: monospace;
      font-size: 1.75rem;
      letter-spacing: 0.15em;
      text-align: center;
      margin: var(--uui-size-space-4, 12px) 0;
    }
    #actions {
      display: flex;
      gap: var(--uui-size-space-3, 9px);
    }
    #error {
      margin: 0;
      color: var(--uui-color-danger, #d42054);
    }
    #notice {
      margin: 0;
      color: var(--uui-color-positive, #0b8152);
    }
  `
}

customElements.define('crombolo-device', CromboloDeviceElement)
