/**
 * The Changes dashboard: counts by kind, each finding with its link, resolved
 * ones greyed. Reads a stable table, so whatever version is live can show what
 * the next version needs. docs/10, "The upgrade dashboard ships in the first release".
 *
 * Findings arrive from two sources — a pending upgrade and an arriving content
 * bundle — so they are grouped rather than pooled: the counts of one say nothing
 * about the other, and the actions that resolve them are different.
 *
 * Below them, each installed bundle that keeps data of its own lists the
 * changes it has made to its storage here, and any still to make.
 *
 * A content bundle waiting to be imported can be answered and imported here,
 * by those allowed to install packages: each finding offers the answers its
 * kind allows, and the import runs once nothing is outstanding.
 */
import { css, html, LitElement, nothing } from '@umbraco-cms/backoffice/external/lit'
import { downloadFile } from './download.js'
import { answersUrl, fetchReport, transferAction } from './report-client.js'

const KIND_LABEL = { blocking: 'Blocking', person: 'Needs a person', auto: 'Automatic' }
const KIND_COLOR = { blocking: 'danger', person: 'warning', auto: 'positive' }
const SOURCE_LABEL = { upgrade: 'Schema and upgrade', transfer: 'Content transfer' }
const CHOICE_LABEL = {
  'take-bundle': 'Use the incoming version',
  'keep-local': 'Keep this site’s version',
  skip: 'Leave this item out',
}
const ANSWERED_LABEL = {
  'take-bundle': 'uses the incoming version',
  'keep-local': 'keeps this site’s version',
  skip: 'is left out',
}

export default class CromboloChangesDashboardElement extends LitElement {
  static properties = {
    _report: { state: true },
    _error: { state: true },
    _showResolved: { state: true },
    _busy: { state: true },
    _outcome: { state: true },
    _backupTaken: { state: true },
    _passphrase: { state: true },
  }

  constructor() {
    super()
    this._report = undefined
    this._error = undefined
    this._showResolved = false
    this._busy = undefined
    this._outcome = {}
    this._backupTaken = {}
    // Held in this page only, sent with each request, never stored.
    this._passphrase = {}
  }

  async #act(bundleId, verb, body) {
    this._busy = bundleId
    const label = (this._report?.transfers ?? []).find((t) => t.bundleId === bundleId)?.label
    try {
      const passphrase = this._passphrase[bundleId]
      const result = await transferAction(
        bundleId,
        verb,
        passphrase ? { ...body, passphrase } : body,
      )
      this._outcome = { ...this._outcome, [bundleId]: { verb, label, ...result } }
    } finally {
      this._busy = undefined
      await this.#load()
    }
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

  #group(findings, transfers = []) {
    const groups = new Map()
    // A bundle with nothing to answer is still waiting to be imported.
    for (const pending of transfers)
      groups.set(`transfer|${pending.bundleId}`, {
        source: 'transfer',
        scope: pending.bundleId,
        findings: [],
      })
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
    const { health, findings, counts, bundles = [], upgrades, transfers = [] } = this._report
    const shown = findings.filter((f) => this._showResolved || f.status === 'open')
    const groups = this.#group(shown, transfers)
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
        ${upgrades ? html`<p class="release">${this.#describeUpgrades(upgrades)}</p>` : nothing}
        ${Object.entries(this._outcome)
          .filter(
            ([id, o]) => o.verb === 'import' && o.ok && !transfers.some((t) => t.bundleId === id),
          )
          .map(
            ([id, o]) => html`<h4>${o.label ?? id}</h4>${this.#renderOutcome({ bundleId: id }, o)}`,
          )}
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
          groups.length === 0
            ? html`<p class="empty">Nothing outstanding. <code>crombolo upgrade check</code> and <code>crombolo content check</code> write findings here.</p>`
            : groups.map((group) => this.#renderGroup(group))
        }
        ${bundles.map((bundle) => this.#renderBundle(bundle))}
      </uui-box>
    `
  }

  #describeUpgrades({ version, installedAt, lastUpgrade }) {
    const day = (at) => at?.slice(0, 10) ?? ''
    const parts = [`Crombolo ${version}`]
    if (installedAt) parts.push(`installed ${day(installedAt)}`)
    if (lastUpgrade)
      parts.push(
        `last upgraded ${day(lastUpgrade.at)}${lastUpgrade.release ? ` to ${lastUpgrade.release}` : ''}, ` +
          `${lastUpgrade.steps} storage change${lastUpgrade.steps === 1 ? '' : 's'}`,
      )
    return parts.join(' · ')
  }

  #renderBundle(bundle) {
    const steps = [
      ...bundle.pending.map((step) => ({ ...step, done: false })),
      ...bundle.applied.map((step) => ({ ...step, done: true })).reverse(),
    ]
    return html`
      <h4>${bundle.name} <small>data storage</small></h4>
      ${
        bundle.pending.length > 0
          ? html`<p><uui-tag color="warning">${bundle.pending.length} change(s) waiting for the next upgrade</uui-tag></p>`
          : nothing
      }
      <uui-table>
        <uui-table-head>
          <uui-table-head-cell>Change</uui-table-head-cell>
          <uui-table-head-cell>Release</uui-table-head-cell>
          <uui-table-head-cell>State</uui-table-head-cell>
        </uui-table-head>
        ${steps.map(
          (step) => html`<uui-table-row>
            <uui-table-cell>${step.name}${step.kind === 'contract' ? html`<small>removes data</small>` : nothing}</uui-table-cell>
            <uui-table-cell>${step.release ?? ''}</uui-table-cell>
            <uui-table-cell>${
              step.done
                ? html`<uui-tag color="positive">done ${step.appliedAt?.slice(0, 10) ?? ''}</uui-tag>`
                : html`<uui-tag color="warning">waiting</uui-tag>`
            }</uui-table-cell>
          </uui-table-row>`,
        )}
      </uui-table>
    `
  }

  #renderGroup(group) {
    const pending =
      group.source === 'transfer'
        ? (this._report.transfers ?? []).find((t) => t.bundleId === group.scope)
        : undefined
    const answering = Boolean(pending && this._report.mayImport)
    return html`
      <h4>
        ${SOURCE_LABEL[group.source] ?? group.source}
        ${pending?.label ? html`<strong>${pending.label}</strong>` : group.scope ? html`<code>${group.scope}</code>` : nothing}
      </h4>
      ${
        group.findings.length === 0
          ? nothing
          : html`<uui-table>
        <uui-table-head>
          <uui-table-head-cell>Kind</uui-table-head-cell>
          <uui-table-head-cell>What</uui-table-head-cell>
          <uui-table-head-cell>Where</uui-table-head-cell>
          ${answering ? html`<uui-table-head-cell>Answer</uui-table-head-cell>` : nothing}
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
            ${answering ? html`<uui-table-cell>${this.#renderChoices(pending, f)}</uui-table-cell>` : nothing}
          </uui-table-row>`,
        )}
      </uui-table>`
      }
      ${answering ? this.#renderPending(pending, group.findings) : nothing}
    `
  }

  #renderChoices(pending, finding) {
    if (finding.status !== 'open' || !finding.choices?.length) return nothing
    return html`<div class="choices">
      ${finding.choices.map(
        (choice) => html`<uui-button
          look="secondary"
          compact
          ?disabled=${this._busy === pending.bundleId}
          label=${CHOICE_LABEL[choice.resolution]}
          @click=${() =>
            this.#act(pending.bundleId, 'answer', {
              nodeKey: finding.subjectKey,
              handle: choice.handle,
              resolution: choice.resolution,
            })}
        >${CHOICE_LABEL[choice.resolution]}</uui-button>`,
      )}
    </div>`
  }

  #describeAnswer(answer) {
    const named = (this._report.findings ?? []).find((f) => f.subjectKey === answer.nodeKey)
    const name = named?.subjectName ?? 'An item'
    if (answer.handle === '*') return `${name} ${ANSWERED_LABEL[answer.resolution] ?? ''}`
    const [field, culture] = answer.handle.split('@')
    return `${name}: its ${field}${culture ? ` (${culture})` : ''} ${ANSWERED_LABEL[answer.resolution] ?? ''}`
  }

  #renderPending(pending, findings) {
    const open = findings.filter((f) => f.status === 'open')
    const waiting = open.filter((f) => f.kind === 'blocking' || f.kind === 'person')
    const blocking = waiting.filter((f) => f.kind === 'blocking').length
    const missingFiles = pending.allowMissingBlobs || open.some((f) => f.code === 'missing-blob')
    const busy = this._busy === pending.bundleId
    const outcome = this._outcome[pending.bundleId]
    const encrypted =
      open.some((f) => f.code === 'content-sealed') ||
      outcome?.needsPassphrase === true ||
      this._passphrase[pending.bundleId] !== undefined
    return html`<div class="pending">
      ${
        encrypted
          ? html`<p class="passphrase">
              <span>This content is encrypted. Enter the passphrase it was exported with.</span>
              <uui-input
                type="password"
                label="Passphrase"
                autocomplete="off"
                .value=${this._passphrase[pending.bundleId] ?? ''}
                @input=${(e) => {
                  this._passphrase = { ...this._passphrase, [pending.bundleId]: e.target.value }
                }}
              ></uui-input>
              <uui-button
                look="secondary"
                ?disabled=${busy || !this._passphrase[pending.bundleId]}
                label="Open"
                @click=${() => this.#act(pending.bundleId, 'check')}
              >Open</uui-button>
            </p>`
          : nothing
      }
      ${
        pending.answers.length > 0
          ? html`<p><strong>Answers given</strong></p>
            <ul>
              ${pending.answers.map(
                (answer) => html`<li>
                  ${this.#describeAnswer(answer)}
                  <uui-button
                    look="secondary"
                    compact
                    ?disabled=${busy}
                    label="Change"
                    @click=${() =>
                      this.#act(pending.bundleId, 'answer', {
                        nodeKey: answer.nodeKey,
                        handle: answer.handle,
                        resolution: null,
                      })}
                  >Change</uui-button>
                </li>`,
              )}
            </ul>`
          : nothing
      }
      ${
        missingFiles
          ? html`<uui-toggle
              label="Import even where a media file is missing"
              .checked=${pending.allowMissingBlobs}
              ?disabled=${busy}
              @change=${(e) => this.#act(pending.bundleId, 'missing-files', { allow: e.target.checked })}
            ></uui-toggle>`
          : nothing
      }
      <p class="state">
        ${
          waiting.length === 0
            ? html`<uui-tag color="positive">Ready to import</uui-tag>`
            : blocking > 0
              ? html`<uui-tag color="danger">${blocking} blocking: these need a change to this site before the import can run</uui-tag>`
              : html`<uui-tag color="warning">${waiting.length} still to answer</uui-tag>`
        }
        ${pending.publish ? html`<small>Pages live where the content came from are published too.</small>` : nothing}
      </p>
      <div class="actions">
        <uui-button
          look="primary"
          ?disabled=${busy || waiting.length > 0}
          label="Import"
          @click=${() =>
            this.#act(pending.bundleId, 'import', {
              backupTaken: this._backupTaken[pending.bundleId] === true,
            })}
        >Import</uui-button>
        <uui-button look="secondary" ?disabled=${busy} label="Check again" @click=${() => this.#act(pending.bundleId, 'check')}>Check again</uui-button>
        <uui-button look="secondary" label="Download answers" @click=${() =>
          downloadFile(answersUrl(pending.bundleId), 'resolutions.json').catch((error) => {
            this._outcome = {
              ...this._outcome,
              [pending.bundleId]: { ok: false, message: error.message },
            }
          })}>Download answers</uui-button>
      </div>
      ${outcome ? this.#renderOutcome(pending, outcome) : nothing}
    </div>`
  }

  #renderOutcome(pending, outcome) {
    if (outcome.verb === 'import' && outcome.ok) {
      const c = outcome.counts ?? {}
      return html`<p class="outcome">
        <uui-tag color="positive">Imported</uui-tag>
        ${c.create ?? 0} new, ${c.update ?? 0} updated, ${c.unchanged ?? 0} unchanged, ${c.skip ?? 0} left out${
          outcome.published?.length ? html`; ${outcome.published.length} published` : nothing
        }.
        ${
          outcome.publishFailures?.length
            ? html`<ul>${outcome.publishFailures.map((f) => html`<li>${f.name} was not published: ${f.reason}</li>`)}</ul>`
            : nothing
        }
      </p>`
    }
    if (outcome.needsBackup)
      return html`<p class="outcome">
        ${outcome.message}
        <uui-checkbox
          label="A backup of this site has been taken"
          .checked=${this._backupTaken[pending.bundleId] === true}
          @change=${(e) => (this._backupTaken = { ...this._backupTaken, [pending.bundleId]: e.target.checked })}
        >A backup of this site has been taken</uui-checkbox>
      </p>`
    if (outcome.ok === false)
      return html`<p class="outcome"><uui-tag color="danger">Not done</uui-tag> ${outcome.message ?? 'Something is still outstanding.'}</p>`
    return nothing
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
    .choices, .actions { display: flex; flex-wrap: wrap; gap: var(--uui-size-space-2); }
    .pending { margin: var(--uui-size-space-3) 0 var(--uui-size-space-5); }
    .pending ul { margin: 0 0 var(--uui-size-space-3); padding-left: var(--uui-size-space-5); }
    .state { display: flex; gap: var(--uui-size-space-3); align-items: center; }
    .passphrase { display: flex; flex-wrap: wrap; gap: var(--uui-size-space-3); align-items: center; }
  `
}

customElements.define('crombolo-changes-dashboard', CromboloChangesDashboardElement)
