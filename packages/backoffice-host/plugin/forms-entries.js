/**
 * The Forms section's Entries view.
 *
 * What a person actually does here: read what was submitted, approve or reject
 * it, delete it, and take the lot away as CSV.
 *
 * A sensitive field arrives already redacted — the server withholds it rather
 * than the UI hiding it — so this shows that it is withheld rather than
 * pretending the answer was blank.
 */
import { css, html, nothing, repeat } from '@umbraco-cms/backoffice/external/lit'
import { UmbLitElement } from '@umbraco-cms/backoffice/lit-element'
import {
  deleteEntry,
  entriesCsvUrl,
  listEntries,
  listForms,
  setEntryState,
} from './forms-client.js'

export default class BunbracoFormsEntriesElement extends UmbLitElement {
  static properties = {
    _forms: { state: true },
    _selected: { state: true },
    _entries: { state: true },
    _total: { state: true },
    _state: { state: true },
    _search: { state: true },
    _includeSpam: { state: true },
    _notice: { state: true },
  }

  constructor() {
    super()
    this._forms = undefined
    this._selected = ''
    this._entries = []
    this._total = 0
    this._state = ''
    this._search = ''
    this._includeSpam = false
    this._notice = ''
  }

  connectedCallback() {
    super.connectedCallback()
    listForms().then(
      (forms) => {
        this._forms = forms
        this._selected = forms[0]?.key ?? ''
        if (this._selected) this.#load()
      },
      (error) => {
        this._forms = []
        this._notice = error.message
      },
    )
  }

  async #load() {
    this._notice = ''
    try {
      const page = await listEntries(this._selected, {
        state: this._state,
        search: this._search,
        includeSpam: this._includeSpam ? 'true' : '',
        take: 200,
      })
      this._entries = page.items ?? []
      this._total = page.total ?? 0
    } catch (error) {
      this._entries = []
      this._notice = error.message
    }
  }

  async #setState(entry, state) {
    try {
      const result = await setEntryState(entry.id, state)
      if (!result.ok) this._notice = 'That entry could not be changed.'
      await this.#load()
    } catch (error) {
      this._notice = error.message
    }
  }

  async #remove(entry) {
    if (!confirm('Delete this entry? It cannot be undone.')) return
    try {
      await deleteEntry(entry.id)
      await this.#load()
    } catch (error) {
      this._notice = error.message
    }
  }

  render() {
    if (this._forms === undefined) return html`<uui-loader></uui-loader>`
    if (this._forms.length === 0)
      return html`<uui-box headline="Entries"><p>There are no forms yet.</p></uui-box>`

    return html`
      <uui-box headline="Entries">
        <div class="filters">
          <select
            @change=${(event) => {
              this._selected = event.target.value
              this.#load()
            }}
          >
            ${this._forms.map(
              (form) =>
                html`<option value=${form.key} ?selected=${form.key === this._selected}>${form.name}</option>`,
            )}
          </select>
          <select
            @change=${(event) => {
              this._state = event.target.value
              this.#load()
            }}
          >
            <option value="">Any state</option>
            <option value="submitted">Submitted</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
          <uui-input
            placeholder="Search the answers"
            .value=${this._search}
            @change=${(event) => {
              this._search = event.target.value
              this.#load()
            }}
          ></uui-input>
          <uui-toggle
            label="Include spam"
            .checked=${this._includeSpam}
            @change=${(event) => {
              this._includeSpam = event.target.checked
              this.#load()
            }}
          ></uui-toggle>
          <a class="csv" href=${entriesCsvUrl(this._selected)} download>Export CSV</a>
        </div>

        ${this._notice ? html`<p class="notice" role="alert">${this._notice}</p>` : nothing}
        <p>${this._total} entr${this._total === 1 ? 'y' : 'ies'}.</p>

        ${
          this._entries.length === 0
            ? html`<p>Nothing to show.</p>`
            : repeat(
                this._entries,
                (entry) => entry.id,
                (entry) => html`
                  <div class="entry">
                    <div class="meta">
                      <strong>${new Date(entry.createDate).toLocaleString()}</strong>
                      <span class="state">${entry.state}</span>
                      ${entry.spam ? html`<span class="spam">spam</span>` : nothing}
                    </div>
                    <dl>
                      ${entry.values.map(
                        (value) => html`
                          <dt>${value.fieldAlias}</dt>
                          <dd>
                            ${
                              value.redacted
                                ? html`<em>withheld — needs sensitive-data access</em>`
                                : value.values.join(', ') || html`<em>not answered</em>`
                            }
                          </dd>
                        `,
                      )}
                    </dl>
                    <div class="actions">
                      <uui-button look="secondary" label="Approve" @click=${() => this.#setState(entry, 'approved')}></uui-button>
                      <uui-button look="secondary" label="Reject" @click=${() => this.#setState(entry, 'rejected')}></uui-button>
                      <uui-button look="secondary" color="danger" label="Delete" @click=${() => this.#remove(entry)}></uui-button>
                    </div>
                  </div>
                `,
              )
        }
      </uui-box>
    `
  }

  static styles = css`
    :host {
      display: block;
      padding: var(--uui-size-layout-1, 24px);
    }
    .filters {
      display: flex;
      gap: var(--uui-size-space-4, 12px);
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: var(--uui-size-layout-1, 24px);
    }
    .entry {
      border-top: 1px solid var(--uui-color-border, #e5e5e5);
      padding: var(--uui-size-space-4, 12px) 0;
    }
    .meta {
      display: flex;
      gap: var(--uui-size-space-4, 12px);
      align-items: baseline;
    }
    .state,
    .spam {
      font-size: var(--uui-type-small-size, 0.8rem);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .spam {
      color: var(--uui-color-danger, #d42054);
    }
    dl {
      display: grid;
      grid-template-columns: minmax(8rem, 14rem) 1fr;
      gap: var(--uui-size-space-2, 6px) var(--uui-size-space-4, 12px);
      margin: var(--uui-size-space-4, 12px) 0;
    }
    dt {
      color: var(--uui-color-text-alt, #666);
    }
    dd {
      margin: 0;
    }
    .actions {
      display: flex;
      gap: var(--uui-size-space-4, 12px);
    }
    .notice {
      color: var(--uui-color-danger, #d42054);
    }
    .csv {
      margin-left: auto;
    }
  `
}

customElements.define('bunbraco-forms-entries', BunbracoFormsEntriesElement)
