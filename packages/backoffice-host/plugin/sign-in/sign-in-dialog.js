/**
 * The dialog shown when a session ends while the backoffice is open: crombolo's
 * own, laid out as the login page is. Signing in opens the login page in a
 * pop-up, as the client's dialog does, so what was on screen stays put.
 *
 * Closes once whichever comes first reports the session back: the sign-in it
 * started, or another tab signing in.
 */
import { UMB_AUTH_CONTEXT } from '@umbraco-cms/backoffice/auth'
import { css, html, nothing } from '@umbraco-cms/backoffice/external/lit'
import { UmbModalBaseElement } from '@umbraco-cms/backoffice/modal'
import { UMB_SERVER_CONTEXT } from '@umbraco-cms/backoffice/server'

/** The identity provider the server's authorize endpoint knows; nothing displays it. */
const PROVIDER = 'Umbraco'
const LOGO = '/umbraco/management/api/v1/security/back-office/graphics/login-logo-alternative'

export class CromboloSignInDialogElement extends UmbModalBaseElement {
  static properties = {
    _logo: { state: true },
    _busy: { state: true },
    _error: { state: true },
  }

  #auth
  #closed = false

  constructor() {
    super()
    this.consumeContext(UMB_SERVER_CONTEXT, (server) => {
      this._logo = `${server?.getServerUrl() ?? ''}${LOGO}`
    })
    this.consumeContext(UMB_AUTH_CONTEXT, (auth) => {
      this.#auth = auth
      this.observe(auth?.isAuthorized, (authorized) => {
        if (authorized) this.#close()
      })
    })
  }

  get #timedOut() {
    return this.data?.userLoginState === 'timedOut'
  }

  #close() {
    if (this.#closed) return
    this.#closed = true
    this.value = { success: true }
    this._submitModal()
  }

  async #signIn() {
    if (!this.#auth) return
    this._busy = true
    this._error = undefined
    try {
      // A pop-up when the session timed out, so the page underneath survives;
      // otherwise the whole window goes to the login page.
      await this.#auth.makeAuthorizationRequest(PROVIDER, !this.#timedOut)
      if (this.#auth.getIsAuthorized()) this.#close()
    } catch {
      this._error = 'Signing in did not complete. Try again.'
    } finally {
      this._busy = false
    }
  }

  render() {
    return html`<div id="layout">
      <uui-box id="card">
        ${this._logo ? html`<img id="logo" src=${this._logo} alt="" />` : nothing}
        <h1 class="uui-h3">${this.#timedOut ? 'Your session has ended' : 'Sign in'}</h1>
        ${this.#timedOut ? html`<p>Sign in again to carry on where you left off.</p>` : nothing}
        ${this._error ? html`<p id="error">${this._error}</p>` : nothing}
        <uui-button
          look="primary"
          color="positive"
          label="Sign in"
          .state=${this._busy ? 'waiting' : undefined}
          @click=${() => this.#signIn()}
        ></uui-button>
      </uui-box>
    </div>`
  }

  static styles = css`
    :host {
      display: block;
      width: 100vw;
      height: 100vh;
      background: var(--uui-color-surface-alt, #f4f4f4);
    }
    #layout {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      padding: 16px;
      box-sizing: border-box;
    }
    #card {
      width: 100%;
      max-width: 400px;
    }
    #logo {
      display: block;
      height: 48px;
      margin-bottom: var(--uui-size-space-4, 12px);
    }
    h1 {
      margin: 0 0 var(--uui-size-space-4, 12px);
    }
    p {
      margin: 0 0 var(--uui-size-space-5, 18px);
    }
    #error {
      color: var(--uui-color-danger, #d42054);
    }
    uui-button {
      width: 100%;
    }
  `
}

customElements.define('crombolo-sign-in-dialog', CromboloSignInDialogElement)

export default CromboloSignInDialogElement
