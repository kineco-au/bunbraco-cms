/**
 * A page's Workflow tab (story 028): which workflow covers it, where a request
 * stands in its graph, what the reader may do about it, and its history.
 *
 * Sending for approval sends what is saved: the editor saves first, as they
 * would before publishing.
 */
import { UMB_DOCUMENT_WORKSPACE_CONTEXT } from '@umbraco-cms/backoffice/document'
import { UmbElementMixin } from '@umbraco-cms/backoffice/element-api'
import { css, html, LitElement, nothing, unsafeCSS } from '@umbraco-cms/backoffice/external/lit'
import { decide, pageApproval, sendForApproval } from './workflow-client.js'
import { drawGraph, GRAPH_STYLES } from './workflow-graph.js'

const KIND = {
  sent: 'Sent for approval',
  approved: 'Approved',
  'sent-back': 'Sent back',
  withdrawn: 'Withdrawn',
  edited: 'Changed while waiting',
  restarted: 'Started again',
  published: 'Published',
  unpublished: 'Taken down',
}
const STATE = {
  waiting: 'Waiting for approval',
  approved: 'Approved',
  'sent-back': 'Sent back',
  withdrawn: 'Withdrawn',
}

export default class CromboloWorkflowTabElement extends UmbElementMixin(LitElement) {
  static properties = {
    _key: { state: true },
    _data: { state: true },
    _message: { state: true },
    _busy: { state: true },
    _comment: { state: true },
  }

  constructor() {
    super()
    this._comment = ''
    this.consumeContext(UMB_DOCUMENT_WORKSPACE_CONTEXT, (context) => {
      if (!context) return
      this.observe(context.unique, (unique) => {
        if (!unique || unique === this._key) return
        this._key = unique
        this.#load()
      })
    })
  }

  async #load() {
    const result = await pageApproval(this._key)
    this._data = result.ok ? result : undefined
    if (!result.ok) this._message = result.message
  }

  async #act(run) {
    this._busy = true
    this._message = undefined
    const result = await run()
    this._busy = false
    if (!result.ok) {
      this._message = result.message ?? 'That did not work.'
      return
    }
    this._comment = ''
    await this.#load()
  }

  render() {
    if (!this._data)
      return html`<uui-box headline="Workflow">${this._message ?? html`<uui-loader></uui-loader>`}</uui-box>`
    const { workflow, request, past, can } = this._data
    return html`
      <uui-box headline=${workflow ? `Workflow: ${workflow.name}` : 'Workflow'}>
        ${
          workflow
            ? html`<p class="lead">
                ${
                  can.publishDirectly
                    ? 'This page is covered by this workflow, and you may publish it directly.'
                    : 'Publishing this page goes through this workflow.'
                }
              </p>`
            : html`<p class="lead">No workflow covers this page: it publishes as soon as someone who may publish does.</p>`
        }
        ${this._message ? html`<p class="message">${this._message}</p>` : nothing}
        ${request ? this.#renderRequest(request) : workflow ? this.#renderSend(workflow, can) : nothing}
      </uui-box>
      ${past.length > 0 ? html`<uui-box headline="Earlier requests">${past.map((r) => this.#renderPast(r))}</uui-box>` : nothing}
    `
  }

  #renderSend(workflow, can) {
    if (!can.send && !can.requestUnpublish) return nothing
    return html`
      <div class="graph-wrap">${drawGraph(workflow.stages)}</div>
      <uui-textarea
        label="A note for the approvers"
        placeholder="A note for the approvers (optional)"
        .value=${this._comment}
        @input=${(e) => {
          this._comment = e.target.value
        }}
      ></uui-textarea>
      <div class="actions">
        ${
          can.send
            ? html`<uui-button look="primary" ?disabled=${this._busy} label="Send for approval"
                @click=${() => this.#act(() => sendForApproval(this._key, 'publish', this._comment))}
              >Send for approval</uui-button>`
            : nothing
        }
        ${
          can.requestUnpublish
            ? html`<uui-button look="secondary" ?disabled=${this._busy} label="Request unpublish"
                @click=${() => this.#act(() => sendForApproval(this._key, 'unpublish', this._comment))}
              >Request unpublish</uui-button>`
            : nothing
        }
      </div>
    `
  }

  #renderRequest(request) {
    const states = Object.fromEntries(request.stages.map((s) => [s.alias, s.state]))
    const progress = request.stages
      .filter((s) => s.state === 'waiting')
      .map((s) => `${s.alias}: ${s.approvals} of ${s.needed}`)
      .join(' · ')
    return html`
      <p>
        <uui-tag color="warning">${STATE[request.state]}</uui-tag>
        ${request.action === 'unpublish' ? 'To take this page down.' : 'To publish this page.'}
        ${progress ? html`<small>${progress}</small>` : nothing}
      </p>
      <div class="graph-wrap">${drawGraph(request.workflow.stages, { states })}</div>
      ${
        request.can.approve.length > 0 || request.can.sendBack.length > 0 || request.can.withdraw
          ? html`
              <uui-textarea
                label="Comment"
                placeholder=${request.workflow.comments === 'optional' ? 'A comment (optional)' : 'A comment'}
                .value=${this._comment}
                @input=${(e) => {
                  this._comment = e.target.value
                }}
              ></uui-textarea>
              <div class="actions">
                ${request.can.approve.map(
                  (
                    stage,
                  ) => html`<uui-button look="primary" color="positive" ?disabled=${this._busy}
                    label="Approve"
                    @click=${() => this.#act(() => decide(request.key, 'approve', { stage, comment: this._comment }))}
                  >Approve${request.can.approve.length > 1 ? ` (${stage})` : ''}</uui-button>`,
                )}
                ${request.can.sendBack.map(
                  (
                    stage,
                  ) => html`<uui-button look="secondary" color="danger" ?disabled=${this._busy}
                    label="Send back"
                    @click=${() => this.#act(() => decide(request.key, 'send-back', { stage, comment: this._comment }))}
                  >Send back${request.can.sendBack.length > 1 ? ` (${stage})` : ''}</uui-button>`,
                )}
                ${
                  request.can.withdraw
                    ? html`<uui-button look="secondary" ?disabled=${this._busy} label="Withdraw"
                        @click=${() => this.#act(() => decide(request.key, 'withdraw', {}))}
                      >Withdraw</uui-button>`
                    : nothing
                }
              </div>
            `
          : nothing
      }
      ${this.#renderHistory(request)}
    `
  }

  #renderPast(request) {
    return html`<details>
      <summary>${STATE[request.state]} — ${new Date(request.requestedAt).toLocaleString()}</summary>
      ${this.#renderHistory(request)}
    </details>`
  }

  #renderHistory(request) {
    return html`<ol class="history">
      ${request.history.map(
        (h) => html`<li>
          <strong>${KIND[h.kind] ?? h.kind}</strong>
          ${h.stage ? html`<span>at ${h.stage}</span>` : nothing}
          <small>${new Date(h.at).toLocaleString()}</small>
          ${h.comment ? html`<blockquote>${h.comment}</blockquote>` : nothing}
        </li>`,
      )}
    </ol>`
  }

  static styles = css`
    :host { display: block; padding: var(--uui-size-layout-1); }
    uui-box + uui-box { margin-top: var(--uui-size-space-5); }
    .lead { margin-top: 0; }
    .message { color: var(--uui-color-danger); }
    .graph-wrap { overflow-x: auto; margin: var(--uui-size-space-4) 0; }
    .actions { display: flex; gap: var(--uui-size-space-3); margin: var(--uui-size-space-3) 0; }
    uui-textarea { width: 100%; }
    .history { padding-left: var(--uui-size-space-5); }
    .history li { margin-bottom: var(--uui-size-space-2); }
    .history small { opacity: 0.7; margin-left: var(--uui-size-space-2); }
    blockquote { margin: var(--uui-size-space-1) 0 0; padding-left: var(--uui-size-space-3); border-left: 3px solid var(--uui-color-border); }
    ${unsafeCSS(GRAPH_STYLES)}
  `
}

customElements.define('crombolo-workflow-tab', CromboloWorkflowTabElement)
