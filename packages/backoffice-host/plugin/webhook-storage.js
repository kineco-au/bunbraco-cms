/**
 * "Where it's kept", on a webhook's screen: with the site's files, or in this
 * environment only. Moving one is the server's decision to allow; this shows
 * what it said and asks it. docs/webhooks.md.
 */
import { css, html, nothing } from '@umbraco-cms/backoffice/external/lit'
import { UmbLitElement } from '@umbraco-cms/backoffice/lit-element'
import { UMB_WEBHOOK_WORKSPACE_CONTEXT } from '@umbraco-cms/backoffice/webhook'

const base = () =>
  `${(document.querySelector('base')?.getAttribute('href') ?? '/umbraco/').replace(/\/$/, '')}/crombolo/api/webhooks`

const PLACES = {
  files: {
    label: "With the site's files",
    detail:
      'Kept in the site’s code and deployed with it. A header that holds a secret names a server setting instead, written as env:NAME.',
  },
  database: {
    label: 'In this environment only',
    detail: 'Kept on this site alone, not in its code. A secret may be typed into a header.',
  },
}

export default class CromboloWebhookStorageElement extends UmbLitElement {
  static properties = {
    _state: { state: true },
    _busy: { state: true },
    _message: { state: true },
  }

  #unique

  constructor() {
    super()
    this._state = undefined
    this._busy = false
    this._message = ''
    this.consumeContext(UMB_WEBHOOK_WORKSPACE_CONTEXT, (context) => {
      this.observe(context?.unique, (unique) => {
        this.#unique = unique
        this.#load()
      })
    })
  }

  async #load() {
    if (!this.#unique) return
    const response = await fetch(`${base()}/${encodeURIComponent(this.#unique)}/store`, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    })
    this._state = response.ok ? await response.json() : { missing: true }
  }

  async #move(store) {
    this._busy = true
    this._message = ''
    try {
      const response = await fetch(`${base()}/${encodeURIComponent(this.#unique)}/store`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ store }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok)
        this._message = [body.reason, ...(body.problems ?? [])].filter(Boolean).join(' ')
      await this.#load()
    } finally {
      this._busy = false
    }
  }

  render() {
    const state = this._state
    if (!state) return html`<uui-box><uui-loader></uui-loader></uui-box>`
    if (state.missing)
      return html`<uui-box><p>Save the webhook first, then choose where it is kept.</p></uui-box>`
    const other = state.store === 'files' ? 'database' : 'files'
    return html`<uui-box headline="Where it's kept">
      <p><strong>${PLACES[state.store].label}.</strong> ${PLACES[state.store].detail}</p>
      ${
        state.available[other]
          ? html`<uui-button
              look="secondary"
              ?disabled=${this._busy}
              label=${`Keep it ${PLACES[other].label.toLowerCase()}`}
              @click=${() => this.#move(other)}
            >Keep it ${PLACES[other].label.toLowerCase()}</uui-button>`
          : html`<p class="fine">${state.unavailable[other]}</p>`
      }
      ${this._message ? html`<p class="problem" role="alert">${this._message}</p>` : nothing}
    </uui-box>`
  }

  static styles = css`
    .fine {
      color: var(--uui-color-text-alt, #555);
    }
    .problem {
      color: var(--uui-color-danger, #b00);
    }
  `
}

customElements.define('crombolo-webhook-storage', CromboloWebhookStorageElement)
