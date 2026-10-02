/**
 * Bunbraco login page.
 *
 * Umbraco's own login screen ships as a separate, unpublished npm package, so
 * this is our equivalent, built from the component library that IS published
 * (@umbraco-cms/backoffice/external/uui) and resolved through the import map the
 * page embeds. It posts to the same endpoint Umbraco's does and then returns to
 * the authorize URL that sent us here. It also serves the two links a user may
 * be sent, as Umbraco's does: `?flow=invite-user` to choose a first password and
 * `?flow=reset-password` to choose a new one, plus the request for a reset link.
 */
import { css, html, LitElement, nothing } from '@umbraco-cms/backoffice/external/lit'
import '@umbraco-cms/backoffice/external/uui'

/**
 * Where to go once signed in, if that is somewhere on this site.
 *
 * The server reduces `returnUrl` to a local path before it reaches the attribute,
 * so this is the second lock rather than the only one — worth having because this
 * navigation happens the instant a session exists, which is the most valuable
 * moment to send someone elsewhere. Resolving against this origin is what catches
 * `//host` and `/\host`; a browser reads both as leaving the site while a text
 * check reads them as local.
 */
function localTarget(value, fallback) {
  if (!value) return fallback
  try {
    const resolved = new URL(value, window.location.origin)
    if (resolved.origin !== window.location.origin) return fallback
    return `${resolved.pathname}${resolved.search}${resolved.hash}`
  } catch {
    return fallback
  }
}

class BunbracoLoginElement extends LitElement {
  static properties = {
    returnUrl: { type: String, attribute: 'return-url' },
    logoImage: { type: String, attribute: 'logo-image-alternative' },
    usernameIsEmail: { type: Boolean, attribute: 'username-is-email' },
    allowPasswordReset: { type: Boolean, attribute: 'allow-password-reset' },
    _busy: { state: true },
    _error: { state: true },
    _view: { state: true },
    _notice: { state: true },
  }

  constructor() {
    super()
    this.returnUrl = ''
    this.logoImage = ''
    this.usernameIsEmail = true
    this.allowPasswordReset = false
    this._busy = false
    this._error = ''
    this._notice = ''
    const params = new URLSearchParams(window.location.search)
    const flow = params.get('flow')
    this._link =
      flow === 'invite-user'
        ? { kind: 'invite', user: params.get('userId'), code: params.get('inviteCode') }
        : flow === 'reset-password'
          ? { kind: 'reset', user: params.get('userId'), code: params.get('resetCode') }
          : undefined
    this._view = this._link ? 'checking' : 'login'
  }

  connectedCallback() {
    super.connectedCallback()
    if (this._link) this.#checkLink()
  }

  async #post(path, body) {
    return fetch(`/umbraco/management/api/v1${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  async #checkLink() {
    const { kind, user, code } = this._link
    const response =
      kind === 'invite'
        ? await this.#post('/user/invite/verify', { user: { id: user }, token: code })
        : await this.#post('/security/forgot-password/verify', {
            user: { id: user },
            resetCode: code,
          })
    if (response.ok) {
      this._view = 'new-password'
      return
    }
    this._view = 'login'
    this._error =
      kind === 'invite'
        ? 'This invitation is no longer valid. Ask for a new one.'
        : 'This reset link is no longer valid. Ask for a new one.'
  }

  async #setPassword(event) {
    event.preventDefault()
    if (this._busy) return
    const form = event.target
    const password = form.elements.password.value
    if (password !== form.elements.confirm.value) {
      this._error = 'The passwords do not match.'
      return
    }
    const { kind, user, code } = this._link
    this._busy = true
    this._error = ''
    try {
      const response =
        kind === 'invite'
          ? await this.#post('/user/invite/create-password', {
              user: { id: user },
              token: code,
              password,
            })
          : await this.#post('/security/forgot-password/reset', {
              user: { id: user },
              resetCode: code,
              password,
            })
      if (response.ok) {
        this._view = 'login'
        this._notice = 'Your password is set. Sign in with it now.'
        return
      }
      const problem = await response.json().catch(() => ({}))
      this._error = problem.detail ?? 'The password could not be set.'
    } catch {
      this._error = 'Could not reach the server.'
    } finally {
      this._busy = false
    }
  }

  async #requestReset(event) {
    event.preventDefault()
    if (this._busy) return
    const email = event.target.elements.email.value.trim()
    if (!email) return
    this._busy = true
    try {
      await this.#post('/security/forgot-password', { email })
      this._view = 'login'
      this._notice = 'If that address belongs to an account, a reset link is on its way.'
    } catch {
      this._error = 'Could not reach the server.'
    } finally {
      this._busy = false
    }
  }

  async #submit(event) {
    event.preventDefault()
    if (this._busy) return
    const form = event.target
    const username = form.elements.username.value.trim()
    const password = form.elements.password.value
    if (!username || !password) {
      this._error = 'Enter your credentials to sign in.'
      return
    }

    this._busy = true
    this._error = ''
    try {
      const response = await fetch('/umbraco/management/api/v1/security/back-office/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })

      if (response.ok) {
        // Back to the authorize endpoint, which now sees a session cookie.
        window.location.href = localTarget(this.returnUrl, '/umbraco')
        return
      }
      if (response.status === 402) {
        this._error = 'This account requires two-factor authentication, which is not yet supported.'
      } else if (response.status === 403) {
        this._error = 'This account is locked or not approved.'
      } else if (response.status === 401) {
        this._error = 'Those credentials were not recognised.'
      } else {
        this._error = 'Sign-in failed. Please try again.'
      }
    } catch {
      this._error = 'Could not reach the server.'
    } finally {
      this._busy = false
    }
  }

  #messages() {
    return html`${this._notice ? html`<p id="notice" role="status">${this._notice}</p>` : nothing}
    ${this._error ? html`<p id="error" role="alert">${this._error}</p>` : nothing}`
  }

  #newPasswordForm() {
    return html`
      <h1 class="uui-h3">${this._link?.kind === 'invite' ? 'Choose your password' : 'Choose a new password'}</h1>
      <form @submit=${this.#setPassword}>
        <uui-form-layout-item>
          <uui-label for="password" slot="label" required>Password</uui-label>
          <uui-input id="password" name="password" type="password" autocomplete="new-password" required></uui-input>
        </uui-form-layout-item>
        <uui-form-layout-item>
          <uui-label for="confirm" slot="label" required>Confirm password</uui-label>
          <uui-input id="confirm" name="confirm" type="password" autocomplete="new-password" required></uui-input>
        </uui-form-layout-item>
        ${this.#messages()}
        <uui-button type="submit" look="primary" color="positive" .state=${this._busy ? 'waiting' : undefined} label="Set password"></uui-button>
      </form>
    `
  }

  #resetRequestForm() {
    return html`
      <h1 class="uui-h3">Forgotten password</h1>
      <form @submit=${this.#requestReset}>
        <uui-form-layout-item>
          <uui-label for="email" slot="label" required>Email</uui-label>
          <uui-input id="email" name="email" type="email" autocomplete="email" required></uui-input>
        </uui-form-layout-item>
        ${this.#messages()}
        <uui-button type="submit" look="primary" .state=${this._busy ? 'waiting' : undefined} label="Send reset link"></uui-button>
        <uui-button look="link" label="Back to sign in" @click=${() => {
          this._view = 'login'
        }}></uui-button>
      </form>
    `
  }

  render() {
    const body =
      this._view === 'checking'
        ? html`<uui-loader></uui-loader>`
        : this._view === 'new-password'
          ? this.#newPasswordForm()
          : this._view === 'forgot'
            ? this.#resetRequestForm()
            : this.#loginForm()
    return html`
      <div id="layout">
        <uui-box id="card">
          ${this.logoImage ? html`<img id="logo" src=${this.logoImage} alt="bunbraco" />` : nothing}
          ${body}
        </uui-box>
      </div>
    `
  }

  #loginForm() {
    return html`
          <h1 class="uui-h3">Sign in</h1>
          <form @submit=${this.#submit}>
            <uui-form-layout-item>
              <uui-label for="username" slot="label" required>
                ${this.usernameIsEmail ? 'Email' : 'Username'}
              </uui-label>
              <uui-input
                id="username"
                name="username"
                type=${this.usernameIsEmail ? 'email' : 'text'}
                autocomplete="username"
                required
                ?disabled=${this._busy}></uui-input>
            </uui-form-layout-item>

            <uui-form-layout-item>
              <uui-label for="password" slot="label" required>Password</uui-label>
              <uui-input
                id="password"
                name="password"
                type="password"
                autocomplete="current-password"
                required
                ?disabled=${this._busy}></uui-input>
            </uui-form-layout-item>

            ${this.#messages()}

            <uui-button
              type="submit"
              look="primary"
              color="positive"
              .state=${this._busy ? 'waiting' : undefined}
              label="Sign in"></uui-button>
            ${
              this.allowPasswordReset
                ? html`<uui-button look="link" label="Forgotten password?" @click=${() => {
                    this._error = ''
                    this._view = 'forgot'
                  }}></uui-button>`
                : nothing
            }
          </form>
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
      max-width: 400px;
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

customElements.define('bunbraco-login', BunbracoLoginElement)
