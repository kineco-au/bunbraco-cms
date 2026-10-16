/**
 * The page a push to a protected environment is approved on (story 107). The
 * person who pushed shares its link; someone else allowed to push here looks at
 * who sent it and when, and approves or declines it.
 */
import { css, html, LitElement, nothing } from '@umbraco-cms/backoffice/external/lit'
import '@umbraco-cms/backoffice/external/uui'

const API = '/umbraco/remote/v1/jobs'

class CromboloRemoteApprovalElement extends LitElement {
  static properties = {
    job: { type: String },
    logoImage: { type: String, attribute: 'logo-image' },
    _job: { state: true },
    _error: { state: true },
    _busy: { state: true },
  }

  constructor() {
    super()
    this.job = ''
    this.logoImage = ''
    this._job = undefined
    this._error = ''
    this._busy = false
  }

  connectedCallback() {
    super.connectedCallback()
    this.#load()
  }

  async #load() {
    const response = await fetch(`${API}/${encodeURIComponent(this.job)}`, {
      credentials: 'include',
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      this._error = body.title ?? 'There is no such push.'
      return
    }
    this._job = body
  }

  async #decide(approve) {
    this._busy = true
    this._error = ''
    const response = await fetch(
      `${API}/${encodeURIComponent(this.job)}/${approve ? 'approve' : 'decline'}`,
      {
        method: 'POST',
        credentials: 'include',
      },
    )
    const body = await response.json().catch(() => ({}))
    this._busy = false
    if (!response.ok) {
      this._error = body.title ?? 'That could not be done.'
      return
    }
    this._job = body
  }

  #body() {
    const job = this._job
    if (!job)
      return this._error ? html`<p id="error">${this._error}</p>` : html`<uui-loader></uui-loader>`
    const when = new Date(job.createdAt).toLocaleString()
    if (job.state !== 'approval-required')
      return html`<p>
        ${job.state === 'refused' ? (job.problem?.title ?? 'This push was declined.') : 'This push has been decided.'}
      </p>`
    return html`
      <p>
        <strong>${job.requestedBy}</strong> wants to replace <strong>${job.environment}</strong> with a copy of their
        site, sent ${when}. Everything on ${job.environment} that is not in it goes to the recycle bin, and a backup is
        taken first.
      </p>
      ${this._error ? html`<p id="error" role="alert">${this._error}</p>` : nothing}
      <div id="actions">
        <uui-button look="primary" color="positive" label="Approve" .state=${this._busy ? 'waiting' : undefined}
          @click=${() => this.#decide(true)}></uui-button>
        <uui-button look="outline" color="danger" label="Decline" @click=${() => this.#decide(false)}></uui-button>
      </div>`
  }

  render() {
    return html`<div id="layout">
      <uui-box id="card">
        ${this.logoImage ? html`<img id="logo" src=${this.logoImage} alt="" />` : nothing}
        <h1 class="uui-h3">Approve a push</h1>
        ${this.#body()}
      </uui-box>
    </div>`
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
      max-width: 480px;
    }
    #logo {
      display: block;
      height: 48px;
      margin-bottom: var(--uui-size-space-4, 12px);
    }
    h1 {
      margin: 0 0 var(--uui-size-space-5, 18px);
    }
    #actions {
      display: flex;
      gap: var(--uui-size-space-3, 9px);
    }
    #error {
      color: var(--uui-color-danger, #d42054);
    }
  `
}

customElements.define('crombolo-remote-approval', CromboloRemoteApprovalElement)
