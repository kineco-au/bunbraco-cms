/**
 * A header app that shows when this server has fallen behind the database:
 * reads keep working, writes answer 409, and the load balancer is draining it.
 */
import { css, html, LitElement, nothing } from '@umbraco-cms/backoffice/external/lit'
import { fetchReport } from './report-client.js'

export default class BunbracoReadOnlyBannerElement extends LitElement {
  static properties = { _health: { state: true } }

  constructor() {
    super()
    this._health = undefined
    this._timer = undefined
  }

  connectedCallback() {
    super.connectedCallback()
    this.#poll()
    this._timer = setInterval(() => this.#poll(), 15_000)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    clearInterval(this._timer)
  }

  async #poll() {
    try {
      this._health = (await fetchReport()).health
    } catch {
      // The report is not reachable; say nothing rather than something wrong.
    }
  }

  render() {
    if (!this._health?.readOnly) return nothing
    return html`<uui-tag color="warning" look="primary" title="An upgrade moved the database past this server (${this._health.version}+${this._health.revision}). Editing resumes on the new servers.">
      Read-only: upgrade in progress
    </uui-tag>`
  }

  static styles = css`
    :host { display: flex; align-items: center; padding: 0 var(--uui-size-space-3); }
  `
}

customElements.define('bunbraco-read-only-banner', BunbracoReadOnlyBannerElement)
