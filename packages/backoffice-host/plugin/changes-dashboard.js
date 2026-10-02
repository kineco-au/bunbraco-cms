/**
 * The Changes dashboard: counts by kind, each finding with its link, resolved
 * ones greyed. Reads a stable table, so whatever version is live can show what
 * the next version needs. docs/10, "The upgrade dashboard ships in the first release".
 *
 * Findings arrive from two sources — a pending upgrade and an arriving content
 * bundle — so they are grouped rather than pooled: the counts of one say nothing
 * about the other, and the actions that resolve them are different.
 */
import { css, html, LitElement, nothing } from '@umbraco-cms/backoffice/external/lit'
import { fetchReport } from './report-client.js'

const KIND_LABEL = { blocking: 'Blocking', person: 'Needs a person', auto: 'Automatic' }
const KIND_COLOR = { blocking: 'danger', person: 'warning', auto: 'positive' }
const SOURCE_LABEL = { upgrade: 'Schema and upgrade', transfer: 'Content transfer' }

export default class BunbracoChangesDashboardElement extends LitElement {
  static properties = {
    _report: { state: true },
    _error: { state: true },
    _showResolved: { state: true },
  }

  constructor() {
    super()
    this._report = undefined
    this._error = undefined
    this._showResolved = false
  }

  connectedCallback() {
    super.connectedCallback()
    this.#load()
  }

  async #load() {
    try {
      this._report = await fetchReport()
      this._error = undefined
    } catch (error) {
      this._error = error.message
    }
  }

  #group(findings) {
    const groups = new Map()
    for (const f of findings) {
      const source = f.source ?? 'upgrade'
      const key = `${source}|${f.scope ?? ''}`
      const group = groups.get(key) ?? { source, scope: f.scope ?? null, findings: [] }
      group.findings.push(f)
      groups.set(key, group)
    }
    return [...groups.values()]
  }

  render() {
    if (this._error) return html`<uui-box headline="Changes"><p>${this._error}</p></uui-box>`
    if (!this._report) return html`<uui-box headline="Changes"><uui-loader></uui-loader></uui-box>`
    const { health, findings, counts } = this._report
    const shown = findings.filter((f) => this._showResolved || f.status === 'open')
    return html`
      <uui-box headline="Changes">
        <p>
          This server runs schema <strong>${health.version}+${health.revision}</strong>
          ${
            health.readOnly
              ? html`<uui-tag color="warning">read-only: the database is ahead of this server</uui-tag>`
              : html`<uui-tag color="positive">current</uui-tag>`
          }
        </p>
        <div class="counts">
          ${Object.entries(KIND_LABEL).map(
            ([kind, label]) =>
              html`<uui-tag color=${KIND_COLOR[kind]}>${label}: ${counts[kind] ?? 0}</uui-tag>`,
          )}
          <uui-button look="secondary" compact @click=${() => this.#load()} label="Refresh">Refresh</uui-button>
          <uui-toggle
            label="Show resolved"
            .checked=${this._showResolved}
            @change=${(e) => (this._showResolved = e.target.checked)}
          ></uui-toggle>
        </div>
        ${
          shown.length === 0
            ? html`<p class="empty">Nothing outstanding. <code>bunbraco upgrade check</code> and <code>bunbraco content check</code> write findings here.</p>`
            : this.#group(shown).map((group) => this.#renderGroup(group))
        }
      </uui-box>
    `
  }

  #renderGroup(group) {
    return html`
      <h4>
        ${SOURCE_LABEL[group.source] ?? group.source}
        ${group.scope ? html`<code>${group.scope}</code>` : nothing}
      </h4>
      <uui-table>
        <uui-table-head>
          <uui-table-head-cell>Kind</uui-table-head-cell>
          <uui-table-head-cell>What</uui-table-head-cell>
          <uui-table-head-cell>Where</uui-table-head-cell>
        </uui-table-head>
        ${group.findings.map(
          (f) => html`<uui-table-row class=${f.status}>
            <uui-table-cell><uui-tag color=${KIND_COLOR[f.kind]}>${KIND_LABEL[f.kind]}</uui-tag></uui-table-cell>
            <uui-table-cell>${f.message}</uui-table-cell>
            <uui-table-cell>
              ${f.link ? html`<a href=${f.link}>${f.subjectName}</a>` : f.subjectName}
              ${f.propertyAlias ? html`<code>${f.propertyAlias}</code>` : nothing}
              ${f.culture ? html`<small>${f.culture}</small>` : nothing}
            </uui-table-cell>
          </uui-table-row>`,
        )}
      </uui-table>
    `
  }

  static styles = css`
    :host { display: block; padding: var(--uui-size-layout-1); }
    .counts { display: flex; gap: var(--uui-size-space-3); align-items: center; margin-bottom: var(--uui-size-space-4); }
    h4 { margin: var(--uui-size-space-5) 0 var(--uui-size-space-2); }
    h4:first-of-type { margin-top: 0; }
    uui-table-row.resolved { opacity: 0.5; text-decoration: line-through; }
    code { margin-left: var(--uui-size-space-2); }
    small { margin-left: var(--uui-size-space-2); }
    .empty { color: var(--uui-color-text-alt); }
  `
}

customElements.define('bunbraco-changes-dashboard', BunbracoChangesDashboardElement)
