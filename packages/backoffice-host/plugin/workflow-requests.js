/**
 * The Workflow section's lists (story 028): what waits for the reader's
 * approval, every request in flight, and those decided. Each row links to the
 * page, whose Workflow tab is where a request is acted on.
 */
import { css, html, nothing } from '@umbraco-cms/backoffice/external/lit'
import { UmbLitElement } from '@umbraco-cms/backoffice/lit-element'
import { finished, inFlight, waitingForMe } from './workflow-client.js'

const STATE = {
  waiting: ['warning', 'Waiting'],
  approved: ['positive', 'Approved'],
  'sent-back': ['danger', 'Sent back'],
  withdrawn: ['default', 'Withdrawn'],
}

const pageLink = (key) => {
  const base = (document.querySelector('base')?.getAttribute('href') ?? '/umbraco/').replace(
    /\/$/,
    '',
  )
  return `${base}/section/content/workspace/document/edit/${key}/view/workflow`
}

class CromboloWorkflowListElement extends UmbLitElement {
  static properties = {
    _items: { state: true },
    _message: { state: true },
    _total: { state: true },
    _skip: { state: true },
  }

  /** Overridden: what this list is, and how it loads. */
  get headline() {
    return ''
  }
  get empty() {
    return ''
  }
  async fetch(_skip) {
    return { ok: true, items: [] }
  }

  connectedCallback() {
    super.connectedCallback()
    this._skip = 0
    this.#load()
  }

  async #load() {
    const result = await this.fetch(this._skip)
    if (!result.ok) {
      this._message = result.message
      return
    }
    this._items = result.items
    this._total = result.total
  }

  render() {
    if (this._message) return html`<uui-box headline=${this.headline}>${this._message}</uui-box>`
    if (!this._items)
      return html`<uui-box headline=${this.headline}><uui-loader></uui-loader></uui-box>`
    return html`<uui-box headline=${this.headline}>
      ${
        this._items.length === 0
          ? html`<p>${this.empty}</p>`
          : html`<uui-table>
              <uui-table-head>
                <uui-table-head-cell>Page</uui-table-head-cell>
                <uui-table-head-cell>Workflow</uui-table-head-cell>
                <uui-table-head-cell>Asked for</uui-table-head-cell>
                <uui-table-head-cell>Where it stands</uui-table-head-cell>
                <uui-table-head-cell>Sent</uui-table-head-cell>
              </uui-table-head>
              ${this._items.map((item) => {
                const [color, label] = STATE[item.state] ?? ['default', item.state]
                const waiting = item.stages.filter((s) => s.state === 'waiting').map((s) => s.alias)
                return html`<uui-table-row>
                  <uui-table-cell><a href=${pageLink(item.nodeKey)}>${item.nodeName}</a></uui-table-cell>
                  <uui-table-cell>${item.workflow.name}</uui-table-cell>
                  <uui-table-cell>${item.action === 'unpublish' ? 'Taking it down' : 'Publishing'}</uui-table-cell>
                  <uui-table-cell>
                    <uui-tag color=${color}>${label}</uui-tag>
                    ${waiting.length > 0 ? html`<small>at ${waiting.join(', ')}</small>` : nothing}
                  </uui-table-cell>
                  <uui-table-cell>${new Date(item.requestedAt).toLocaleString()}</uui-table-cell>
                </uui-table-row>`
              })}
            </uui-table>`
      }
      ${
        this._total !== undefined && this._total > this._items.length + this._skip
          ? html`<uui-button look="secondary" label="Older" @click=${() => {
              this._skip += this._items.length
              this.#load()
            }}>Older</uui-button>`
          : nothing
      }
    </uui-box>`
  }

  static styles = css`
    :host { display: block; padding: var(--uui-size-layout-1); }
    small { margin-left: var(--uui-size-space-2); opacity: 0.8; }
  `
}

customElements.define(
  'crombolo-workflow-waiting',
  class extends CromboloWorkflowListElement {
    get headline() {
      return 'Waiting for my approval'
    }
    get empty() {
      return 'Nothing is waiting for your approval.'
    }
    fetch() {
      return waitingForMe()
    }
  },
)

customElements.define(
  'crombolo-workflow-in-flight',
  class extends CromboloWorkflowListElement {
    get headline() {
      return 'In flight'
    }
    get empty() {
      return 'No page is waiting for approval.'
    }
    fetch() {
      return inFlight()
    }
  },
)

customElements.define(
  'crombolo-workflow-history',
  class extends CromboloWorkflowListElement {
    get headline() {
      return 'Decided'
    }
    get empty() {
      return 'No request has been decided yet.'
    }
    fetch(skip) {
      return finished(skip, 25)
    }
  },
)
