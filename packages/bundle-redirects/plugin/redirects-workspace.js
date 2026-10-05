/**
 * The Redirects screen, in Settings under Advanced.
 *
 * It lists every rule in force, not only the ones it can change: a screen that
 * hid the configured and tracked rules would be lying about what the site does
 * when a URL is requested. The three are told apart by a badge, and only a rule
 * added here is editable — the others belong to the site's code and to the URL
 * tracker, and the server refuses to change them whatever this screen sends.
 *
 * The editor offers everything the matcher supports, because the alternative is
 * a screen quietly weaker than `bunbraco.config.ts`: exact, starts-with and
 * regular-expression matching, a page, a path or an external URL as the target,
 * the four redirect status codes, and an optional culture.
 */
// Both imports are for their side effects: they register the custom elements
// this template uses. `uui-*` is registered by the app shell, but
// `umb-body-layout` and `umb-input-document` are defined in chunks the shell
// loads lazily — and this module is loaded through the import map rather than as
// part of the client's own chunk graph, so nothing else would pull them in.
import '@umbraco-cms/backoffice/components'
import '@umbraco-cms/backoffice/document'
import { css, html, nothing, repeat } from '@umbraco-cms/backoffice/external/lit'
import { UmbLitElement } from '@umbraco-cms/backoffice/lit-element'
import {
  createRedirect,
  deleteRedirect,
  listRedirects,
  updateRedirect,
} from './redirects-client.js'

const MATCH_KINDS = [
  ['exact', 'Exactly this URL'],
  ['prefix', 'This URL and everything below it'],
  ['regex', 'A regular expression'],
]

const TARGET_KINDS = [
  ['document', 'A page on this site'],
  ['path', 'A path on this site'],
  ['url', 'Another site'],
]

const STATUS_CODES = [
  [301, '301 — moved permanently'],
  [302, '302 — found, temporarily'],
  [307, '307 — temporary, keeping the method'],
  [308, '308 — permanent, keeping the method'],
]

const SOURCES = {
  manual: { label: 'Added here', look: 'primary' },
  config: { label: 'In configuration', look: 'secondary' },
  tracked: { label: 'From a rename', look: 'default' },
}

const BLANK = {
  matchKind: 'exact',
  pattern: '',
  targetKind: 'document',
  target: '',
  statusCode: 301,
  culture: '',
}

export default class BunbracoRedirectsWorkspaceElement extends UmbLitElement {
  static properties = {
    _rules: { state: true },
    _loading: { state: true },
    _editing: { state: true },
    _problem: { state: true },
    _notice: { state: true },
    _busy: { state: true },
  }

  constructor() {
    super()
    this._rules = []
    this._loading = true
    this._editing = undefined
    this._problem = ''
    this._notice = ''
    this._busy = false
    this._filter = ''
  }

  connectedCallback() {
    super.connectedCallback()
    this.#load()
  }

  async #load() {
    this._loading = true
    try {
      const result = await listRedirects(this._filter)
      this._rules = result.items ?? []
      this._problem = ''
    } catch (error) {
      this._problem = error instanceof Error ? error.message : String(error)
    } finally {
      this._loading = false
    }
  }

  #filterChanged(event) {
    this._filter = event.target.value ?? ''
    this.#load()
  }

  #add() {
    this._notice = ''
    this._problem = ''
    this._editing = { ...BLANK }
  }

  #edit(rule) {
    this._notice = ''
    this._problem = ''
    this._editing = {
      key: rule.key,
      matchKind: rule.matchKind,
      pattern: rule.pattern,
      targetKind: rule.targetKind,
      target: rule.target,
      statusCode: rule.statusCode,
      culture: rule.culture ?? '',
    }
  }

  #change(field, value) {
    this._editing = { ...this._editing, [field]: value }
  }

  /** Changing what the target *is* makes the old value meaningless. */
  #changeTargetKind(value) {
    this._editing = { ...this._editing, targetKind: value, target: '' }
  }

  async #save() {
    const editing = this._editing
    if (!editing) return
    this._busy = true
    this._problem = ''
    try {
      const rule = {
        matchKind: editing.matchKind,
        pattern: editing.pattern,
        targetKind: editing.targetKind,
        target: editing.target,
        statusCode: Number(editing.statusCode),
        culture: editing.culture,
      }
      const outcome = editing.key
        ? await updateRedirect(editing.key, rule)
        : await createRedirect(rule)
      if (!outcome.ok) {
        this._problem = outcome.message ?? 'The redirect could not be saved.'
        return
      }
      this._editing = undefined
      this._notice = editing.key ? 'Redirect updated.' : 'Redirect added.'
      await this.#load()
    } catch (error) {
      this._problem = error instanceof Error ? error.message : String(error)
    } finally {
      this._busy = false
    }
  }

  async #delete(rule) {
    if (!confirm(`Delete the redirect from ${this.#from(rule)}?`)) return
    this._problem = ''
    try {
      const outcome = await deleteRedirect(rule.key)
      if (!outcome.ok) {
        this._problem = outcome.message ?? 'The redirect could not be deleted.'
        return
      }
      this._notice = 'Redirect deleted.'
      await this.#load()
    } catch (error) {
      this._problem = error instanceof Error ? error.message : String(error)
    }
  }

  /** What a visitor would have typed, which is the pattern plus how it matches. */
  #from(rule) {
    if (rule.matchKind === 'prefix') return `${rule.pattern === '/' ? '' : rule.pattern}/*`
    if (rule.matchKind === 'regex') return `/${rule.pattern}/`
    return rule.pattern
  }

  #to(rule) {
    if (rule.targetKind === 'document') return rule.destinationUrl || 'a page that is not published'
    return rule.target
  }

  #editor() {
    const editing = this._editing
    const documentTarget = editing.targetKind === 'document'
    return html`
      <uui-box headline=${editing.key ? 'Edit redirect' : 'Add a redirect'}>
        <div class="field">
          <label for="match">Match</label>
          <uui-select
            id="match"
            .value=${editing.matchKind}
            @change=${(event) => this.#change('matchKind', event.target.value)}
            .options=${MATCH_KINDS.map(([value, name]) => ({
              value,
              name,
              selected: value === editing.matchKind,
            }))}></uui-select>
        </div>

        <div class="field">
          <label for="pattern">Redirect from</label>
          <uui-input
            id="pattern"
            .value=${editing.pattern}
            placeholder=${editing.matchKind === 'regex' ? '^/news/(\\d+)$' : '/old-page'}
            @input=${(event) => this.#change('pattern', event.target.value)}></uui-input>
          ${
            editing.matchKind === 'regex'
              ? html`<small
                  >Captures are available in the target as <code>$1</code> to
                  <code>$9</code>.</small
                >`
              : nothing
          }
          ${
            editing.matchKind === 'prefix'
              ? html`<small
                  >Everything below this path is matched; the remainder is available as
                  <code>$1</code>.</small
                >`
              : nothing
          }
        </div>

        <div class="field">
          <label for="target-kind">Redirect to</label>
          <uui-select
            id="target-kind"
            .value=${editing.targetKind}
            @change=${(event) => this.#changeTargetKind(event.target.value)}
            .options=${TARGET_KINDS.map(([value, name]) => ({
              value,
              name,
              selected: value === editing.targetKind,
            }))}></uui-select>
        </div>

        <div class="field">
          ${
            documentTarget
              ? html`
                <label>Page</label>
                <umb-input-document
                  max="1"
                  .selection=${editing.target ? [editing.target] : []}
                  @change=${(event) => this.#change('target', event.target.selection?.[0] ?? '')}>
                </umb-input-document>
                <small>
                  A page keeps working as a target when it is renamed or moved, because the
                  rule names the page rather than its URL.
                </small>
              `
              : html`
                <label for="target">${editing.targetKind === 'url' ? 'URL' : 'Path'}</label>
                <uui-input
                  id="target"
                  .value=${editing.target}
                  placeholder=${
                    editing.targetKind === 'url' ? 'https://example.com/page' : '/new-page'
                  }
                  @input=${(event) => this.#change('target', event.target.value)}></uui-input>
              `
          }
        </div>

        <div class="field">
          <label for="status">Status code</label>
          <uui-select
            id="status"
            .value=${String(editing.statusCode)}
            @change=${(event) => this.#change('statusCode', event.target.value)}
            .options=${STATUS_CODES.map(([value, name]) => ({
              value: String(value),
              name,
              selected: value === Number(editing.statusCode),
            }))}></uui-select>
        </div>

        <div class="field">
          <label for="culture">Culture</label>
          <uui-input
            id="culture"
            .value=${editing.culture}
            placeholder="Every culture"
            @input=${(event) => this.#change('culture', event.target.value)}></uui-input>
          <small>Leave this empty to redirect whichever language the URL resolved in.</small>
        </div>

        <div slot="actions">
          <uui-button
            label="Cancel"
            @click=${() => {
              this._editing = undefined
            }}></uui-button>
          <uui-button
            look="primary"
            color="positive"
            label=${editing.key ? 'Save' : 'Add redirect'}
            .state=${this._busy ? 'waiting' : undefined}
            @click=${() => this.#save()}></uui-button>
        </div>
      </uui-box>
    `
  }

  #table() {
    if (this._rules.length === 0)
      return html`
        <uui-box headline="No redirects yet">
          <p>
            Nothing redirects on this site. Add a rule here, or rename a published page —
            which records one by itself so the old URL keeps working.
          </p>
        </uui-box>
      `

    return html`
      <uui-table>
        <uui-table-head>
          <uui-table-head-cell>From</uui-table-head-cell>
          <uui-table-head-cell>To</uui-table-head-cell>
          <uui-table-head-cell>Status</uui-table-head-cell>
          <uui-table-head-cell>Source</uui-table-head-cell>
          <uui-table-head-cell></uui-table-head-cell>
        </uui-table-head>
        ${repeat(
          this._rules,
          (rule) => rule.key,
          (rule) => html`
            <uui-table-row>
              <uui-table-cell><code>${this.#from(rule)}</code></uui-table-cell>
              <uui-table-cell>
                <code>${this.#to(rule)}</code>
                ${
                  rule.culture
                    ? html`<uui-tag look="default" size="s">${rule.culture}</uui-tag>`
                    : nothing
                }
              </uui-table-cell>
              <uui-table-cell>${rule.statusCode}</uui-table-cell>
              <uui-table-cell>
                <uui-tag look=${SOURCES[rule.source]?.look ?? 'default'} size="s">
                  ${SOURCES[rule.source]?.label ?? rule.source}
                </uui-tag>
              </uui-table-cell>
              <uui-table-cell class="actions">
                ${
                  rule.editable
                    ? html`
                      <uui-button
                        label="Edit"
                        look="secondary"
                        compact
                        @click=${() => this.#edit(rule)}></uui-button>
                      <uui-button
                        label="Delete"
                        look="secondary"
                        color="danger"
                        compact
                        @click=${() => this.#delete(rule)}></uui-button>
                    `
                    : nothing
                }
              </uui-table-cell>
            </uui-table-row>
          `,
        )}
      </uui-table>
    `
  }

  render() {
    return html`
      <umb-body-layout headline="Redirects">
        <div id="content">
          <div id="head">
            <uui-input
              type="search"
              label="Search redirects"
              placeholder="Search either URL"
              @change=${this.#filterChanged}></uui-input>
            <uui-button
              look="primary"
              label="Add redirect"
              @click=${() => this.#add()}></uui-button>
          </div>

          ${this._problem ? html`<div class="banner problem">${this._problem}</div>` : nothing}
          ${this._notice ? html`<div class="banner notice">${this._notice}</div>` : nothing}
          ${this._editing ? this.#editor() : nothing}
          ${
            this._loading && this._rules.length === 0
              ? html`<div id="loader"><uui-loader></uui-loader></div>`
              : this.#table()
          }
        </div>
      </umb-body-layout>
    `
  }

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }
    #content {
      padding: var(--uui-size-layout-1, 24px);
      display: flex;
      flex-direction: column;
      gap: var(--uui-size-space-5, 18px);
    }
    #head {
      display: flex;
      align-items: center;
      gap: var(--uui-size-space-4, 12px);
    }
    #head uui-input {
      flex: 1;
    }
    #loader {
      display: flex;
      justify-content: center;
      padding: var(--uui-size-layout-3, 48px);
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: var(--uui-size-space-2, 6px);
      margin-bottom: var(--uui-size-space-5, 18px);
      max-width: 48rem;
    }
    .field label {
      font-weight: bold;
    }
    .field small {
      opacity: 0.8;
      line-height: 1.5;
    }
    .banner {
      padding: var(--uui-size-space-4, 12px);
      border-left: 3px solid var(--uui-color-default, #3544b1);
      background: var(--uui-color-surface-alt, #f3f3f5);
    }
    .banner.problem {
      border-left-color: var(--uui-color-danger, #d42054);
    }
    .banner.notice {
      border-left-color: var(--uui-color-positive, #2bc37c);
    }
    .actions {
      display: flex;
      gap: var(--uui-size-space-2, 6px);
      justify-content: flex-end;
    }
    code {
      word-break: break-all;
    }
    p {
      max-width: 60ch;
      line-height: 1.5;
    }
  `
}

customElements.define('bunbraco-redirects-workspace', BunbracoRedirectsWorkspaceElement)
