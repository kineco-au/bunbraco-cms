/**
 * The Forms section's list, and the editor for one form.
 *
 * Umbraco Forms' designer is drag-and-drop over a canvas. This is a table: a
 * form is a file, and what somebody edits here is written straight back to
 * TOML, so the shape that matters is the one a diff will show. Reordering,
 * multi-page layout and the richer per-type settings are refinements on top.
 *
 * Saving sends the whole definition. The server writes it to TOML and reads it
 * back with the strict parser before keeping it, so a refusal here is the same
 * refusal a hand-written file would get.
 */
import { css, html, nothing, repeat } from '@umbraco-cms/backoffice/external/lit'
import { UmbLitElement } from '@umbraco-cms/backoffice/lit-element'
import { deleteForm, listForms, readForm, saveForm } from './forms-client.js'

const FIELD_TYPES = [
  'shortAnswer',
  'longAnswer',
  'email',
  'number',
  'date',
  'checkbox',
  'dropdown',
  'singleChoice',
  'multipleChoice',
  'fileUpload',
  'dataConsent',
  'titleAndDescription',
  'richText',
  'hidden',
]
const CHOICE_TYPES = new Set(['dropdown', 'singleChoice', 'multipleChoice'])

export default class BunbracoFormsOverviewElement extends UmbLitElement {
  static properties = {
    _forms: { state: true },
    _editing: { state: true },
    _problems: { state: true },
    _notice: { state: true },
    _busy: { state: true },
  }

  constructor() {
    super()
    this._forms = undefined
    this._editing = undefined
    this._problems = []
    this._notice = ''
    this._busy = false
  }

  connectedCallback() {
    super.connectedCallback()
    this.#load()
  }

  async #load() {
    try {
      this._forms = await listForms()
    } catch (error) {
      this._forms = []
      this._notice = error.message
    }
  }

  async #edit(key) {
    this._problems = []
    this._notice = ''
    const detail = await readForm(key)
    this._editing = structuredClone(detail.definition)
  }

  #new() {
    this._problems = []
    this._notice = ''
    this._editing = {
      key: crypto.randomUUID(),
      alias: '',
      name: '',
      storeEntries: true,
      requiresApproval: false,
      honeypot: true,
      pages: [{ groups: [{ columns: 1, fields: [] }] }],
      workflows: [],
    }
  }

  get #fields() {
    return this._editing?.pages?.[0]?.groups?.[0]?.fields ?? []
  }

  #touch() {
    // Lit tracks the reference, not what is inside it.
    this._editing = { ...this._editing }
  }

  async #save() {
    this._busy = true
    this._problems = []
    this._notice = ''
    try {
      const result = await saveForm(this._editing)
      if (result.ok) {
        this._notice = 'Saved.'
        this._editing = undefined
        await this.#load()
      } else {
        this._problems = result.body.problems ?? []
        if (result.body.status === 'readOnly')
          this._notice = 'The schema directory is read-only on this node.'
      }
    } catch (error) {
      this._notice = error.message
    } finally {
      this._busy = false
    }
  }

  async #remove(form) {
    if (!confirm(`Delete the form "${form.name}"? Its entries are kept.`)) return
    try {
      const result = await deleteForm(form.key)
      if (!result.ok) this._notice = 'That form could not be deleted.'
      await this.#load()
    } catch (error) {
      this._notice = error.message
    }
  }

  render() {
    if (this._forms === undefined) return html`<uui-loader></uui-loader>`
    return html`
      ${this._notice ? html`<uui-box><p>${this._notice}</p></uui-box>` : nothing}
      ${this._editing ? this.#editor() : this.#list()}
    `
  }

  #list() {
    return html`
      <uui-box headline="Forms">
        <p>
          A form is a file in <code>schema/forms/</code>. Editing one here writes that
          file, so the change can be reviewed in a pull request like any other type.
        </p>
        ${
          this._forms.length === 0
            ? html`<p>There are no forms yet.</p>`
            : html`
                <uui-table>
                  <uui-table-head>
                    <uui-table-head-cell>Name</uui-table-head-cell>
                    <uui-table-head-cell>Alias</uui-table-head-cell>
                    <uui-table-head-cell>Fields</uui-table-head-cell>
                    <uui-table-head-cell>Entries</uui-table-head-cell>
                    <uui-table-head-cell></uui-table-head-cell>
                  </uui-table-head>
                  ${repeat(
                    this._forms,
                    (form) => form.key,
                    (form) => html`
                      <uui-table-row>
                        <uui-table-cell>${form.name}</uui-table-cell>
                        <uui-table-cell><code>${form.alias}</code></uui-table-cell>
                        <uui-table-cell>${form.fieldCount}</uui-table-cell>
                        <uui-table-cell>${form.storeEntries ? 'stored' : 'not stored'}</uui-table-cell>
                        <uui-table-cell>
                          <uui-button look="secondary" label="Edit" @click=${() => this.#edit(form.key)}></uui-button>
                          <uui-button look="secondary" color="danger" label="Delete" @click=${() => this.#remove(form)}></uui-button>
                        </uui-table-cell>
                      </uui-table-row>
                    `,
                  )}
                </uui-table>
              `
        }
        <div class="actions">
          <uui-button look="primary" label="Add a form" @click=${() => this.#new()}></uui-button>
        </div>
      </uui-box>
    `
  }

  #editor() {
    const form = this._editing
    const text = (key, label, hint) => html`
      <uui-form-layout-item>
        <uui-label slot="label">${label}</uui-label>
        ${hint ? html`<span slot="description">${hint}</span>` : nothing}
        <uui-input
          .value=${form[key] ?? ''}
          @change=${(event) => {
            form[key] = event.target.value
            this.#touch()
          }}
        ></uui-input>
      </uui-form-layout-item>
    `
    return html`
      <uui-box headline=${form.alias ? `Form: ${form.name || form.alias}` : 'A new form'}>
        ${
          this._problems.length > 0
            ? html`<div class="problems" role="alert">
                <p>This form was not saved:</p>
                <ul>
                  ${this._problems.map((problem) => html`<li><code>${problem.path}</code> ${problem.message}</li>`)}
                </ul>
              </div>`
            : nothing
        }
        ${text('name', 'Name')}
        ${text('alias', 'Alias', 'Letters and numbers, starting with a letter. The file is named after it.')}
        ${text('messageOnSubmit', 'Message on submit')}
        ${text('submitLabel', 'Submit button')}
        <uui-form-layout-item>
          <uui-label slot="label">Store entries</uui-label>
          <uui-toggle
            .checked=${form.storeEntries !== false}
            @change=${(event) => {
              form.storeEntries = event.target.checked
              this.#touch()
            }}
          ></uui-toggle>
        </uui-form-layout-item>

        <h4>Fields</h4>
        <uui-table>
          <uui-table-head>
            <uui-table-head-cell>Caption</uui-table-head-cell>
            <uui-table-head-cell>Alias</uui-table-head-cell>
            <uui-table-head-cell>Type</uui-table-head-cell>
            <uui-table-head-cell>Choices</uui-table-head-cell>
            <uui-table-head-cell>Required</uui-table-head-cell>
            <uui-table-head-cell>Sensitive</uui-table-head-cell>
            <uui-table-head-cell></uui-table-head-cell>
          </uui-table-head>
          ${repeat(
            this.#fields,
            (_field, index) => index,
            (field, index) => html`
              <uui-table-row>
                <uui-table-cell>
                  <uui-input
                    .value=${field.caption ?? ''}
                    @change=${(event) => {
                      field.caption = event.target.value
                      this.#touch()
                    }}
                  ></uui-input>
                </uui-table-cell>
                <uui-table-cell>
                  <uui-input
                    .value=${field.alias ?? ''}
                    @change=${(event) => {
                      field.alias = event.target.value
                      this.#touch()
                    }}
                  ></uui-input>
                </uui-table-cell>
                <uui-table-cell>
                  <select
                    @change=${(event) => {
                      field.type = event.target.value
                      if (!CHOICE_TYPES.has(field.type)) field.values = []
                      this.#touch()
                    }}
                  >
                    ${FIELD_TYPES.map(
                      (type) =>
                        html`<option value=${type} ?selected=${type === field.type}>${type}</option>`,
                    )}
                  </select>
                </uui-table-cell>
                <uui-table-cell>
                  ${
                    CHOICE_TYPES.has(field.type)
                      ? html`<uui-input
                          placeholder="One, Two, Three"
                          .value=${(field.values ?? []).join(', ')}
                          @change=${(event) => {
                            field.values = event.target.value
                              .split(',')
                              .map((value) => value.trim())
                              .filter(Boolean)
                            this.#touch()
                          }}
                        ></uui-input>`
                      : nothing
                  }
                </uui-table-cell>
                <uui-table-cell>
                  <uui-toggle
                    .checked=${field.mandatory === true}
                    @change=${(event) => {
                      field.mandatory = event.target.checked
                      this.#touch()
                    }}
                  ></uui-toggle>
                </uui-table-cell>
                <uui-table-cell>
                  <uui-toggle
                    .checked=${field.sensitive === true}
                    @change=${(event) => {
                      field.sensitive = event.target.checked
                      this.#touch()
                    }}
                  ></uui-toggle>
                </uui-table-cell>
                <uui-table-cell>
                  <uui-button
                    look="secondary"
                    color="danger"
                    label="Remove"
                    @click=${() => {
                      this.#fields.splice(index, 1)
                      this.#touch()
                    }}
                  ></uui-button>
                </uui-table-cell>
              </uui-table-row>
            `,
          )}
        </uui-table>
        <div class="actions">
          <uui-button
            look="secondary"
            label="Add a field"
            @click=${() => {
              this.#fields.push({
                alias: '',
                type: 'shortAnswer',
                caption: '',
                mandatory: false,
                sensitive: false,
                values: [],
                accept: [],
              })
              this.#touch()
            }}
          ></uui-button>
          <uui-button look="primary" label="Save" ?disabled=${this._busy} @click=${() => this.#save()}></uui-button>
          <uui-button look="secondary" label="Cancel" @click=${() => {
            this._editing = undefined
            this._problems = []
          }}></uui-button>
        </div>
      </uui-box>
    `
  }

  static styles = css`
    :host {
      display: block;
      padding: var(--uui-size-layout-1, 24px);
    }
    p,
    ul {
      max-width: 70ch;
      line-height: 1.5;
    }
    h4 {
      margin-top: var(--uui-size-layout-1, 24px);
    }
    .actions {
      display: flex;
      gap: var(--uui-size-space-4, 12px);
      margin-top: var(--uui-size-layout-1, 24px);
    }
    .problems {
      border-left: 3px solid var(--uui-color-danger, #d42054);
      padding-left: var(--uui-size-space-4, 12px);
      margin-bottom: var(--uui-size-layout-1, 24px);
    }
    code {
      font-size: 0.9em;
    }
  `
}

customElements.define('bunbraco-forms-overview', BunbracoFormsOverviewElement)
