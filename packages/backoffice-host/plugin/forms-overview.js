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
// For its side effect: registers `umb-input-document`, which the shell loads lazily.
import '@umbraco-cms/backoffice/document'
import { css, html, nothing, repeat } from '@umbraco-cms/backoffice/external/lit'
import { UmbLitElement } from '@umbraco-cms/backoffice/lit-element'
import { UMB_NOTIFICATION_CONTEXT } from '@umbraco-cms/backoffice/notification'
import {
  deleteForm,
  listForms,
  listFormTypes,
  previewChoices,
  readForm,
  saveForm,
} from './forms-client.js'
import {
  addGroup,
  addPage,
  groupHasFields,
  layoutRows,
  moveField,
  moveGroup,
  movePage,
  nudgeField,
  pageHasFields,
  removeGroup,
  removePage,
  setColumns,
  setGroupCaption,
  setPageCaption,
  withLayout,
} from './forms-layout.js'

/** What a preview depends on, so it survives a layout change that copies the field. */
const sourceKey = (source) => `${source.kind}|${source.parent}`

/** Where a choice field's options come from, as an editor would put it. */
const CHOICE_FROM = [
  { kind: '', label: 'Options typed here' },
  { kind: 'content', label: "A page's child pages" },
  { kind: 'dictionary', label: "A dictionary item's children" },
]

export default class CromboloFormsOverviewElement extends UmbLitElement {
  static properties = {
    _forms: { state: true },
    _editing: { state: true },
    _problems: { state: true },
    _notice: { state: true },
    _busy: { state: true },
    _choices: { state: true },
    _types: { state: true },
  }

  #notifications

  constructor() {
    super()
    this.consumeContext(UMB_NOTIFICATION_CONTEXT, (context) => {
      this.#notifications = context
    })
    this._forms = undefined
    this._editing = undefined
    this._problems = []
    this._notice = ''
    this._busy = false
    /** What each source currently offers, by field; shown under the field. */
    this._choices = new Map()
    /** Field types by name, as the server has them: built in and from bundles. */
    this._types = new Map()
  }

  connectedCallback() {
    super.connectedCallback()
    this.#load()
  }

  async #load() {
    try {
      const [forms, types] = await Promise.all([listForms(), listFormTypes()])
      this._forms = forms
      this._types = new Map(types.fields.map((info) => [info.type, info]))
    } catch (error) {
      this._forms = []
      this._notice = error.message
    }
  }

  async #edit(key) {
    this._problems = []
    this._notice = ''
    const detail = await readForm(key)
    this._editing = withLayout(detail.definition)
    this._choices = new Map()
    for (const field of this.#fields) if (field.source) this.#preview(field)
  }

  async #preview(field) {
    const source = field.source
    if (!source?.parent) {
      this.#touch()
      return
    }
    try {
      const result = await previewChoices(source)
      this._choices.set(sourceKey(source), result.ok ? result.body.options : [])
    } catch {
      this._choices.set(sourceKey(source), [])
    }
    this.#touch()
  }

  /** Clears what the old type kept, so a switched field carries no settings it no longer takes. */
  #changeType(field, type) {
    const before = this._types.get(field.type)
    for (const setting of before?.builtIn ? before.settings : []) delete field[setting.key]
    delete field.settings
    field.type = type
    if (!this._types.get(type)?.choices) {
      field.values = []
      delete field.source
    }
  }

  /**
   * One input per setting the type declares. A built-in type keeps them on the
   * field; a bundle's type keeps them in the field's own settings.
   */
  #settingsCell(field) {
    const info = this._types.get(field.type)
    if (!info || info.settings.length === 0) return nothing
    const read = (key) => (info.builtIn ? field[key] : field.settings?.[key])
    const write = (key, value) => {
      if (info.builtIn) {
        if (value === undefined) delete field[key]
        else field[key] = value
      } else {
        field.settings = { ...(field.settings ?? {}) }
        if (value === undefined) delete field.settings[key]
        else field.settings[key] = value
        if (Object.keys(field.settings).length === 0) delete field.settings
      }
      this.#touch()
    }
    return html`<div class="settings">
      ${info.settings.map((setting) => {
        const value = read(setting.key)
        const label = `${setting.label}${setting.required ? ' *' : ''}`
        if (setting.kind === 'boolean')
          return html`<uui-toggle
            label=${label}
            title=${setting.description ?? ''}
            .checked=${value === true}
            @change=${(event) => write(setting.key, event.target.checked || undefined)}
          ></uui-toggle>`
        return html`<label>
          <span>${label}</span>
          <uui-input
            title=${setting.description ?? ''}
            type=${setting.kind === 'number' ? 'number' : 'text'}
            .value=${value === undefined ? '' : setting.kind === 'list' ? value.join(', ') : String(value)}
            @change=${(event) => {
              const raw = event.target.value.trim()
              if (raw === '') return write(setting.key, undefined)
              if (setting.kind === 'number') return write(setting.key, Number(raw))
              if (setting.kind === 'list')
                return write(
                  setting.key,
                  raw
                    .split(',')
                    .map((item) => item.trim())
                    .filter(Boolean),
                )
              write(setting.key, raw)
            }}
          ></uui-input>
        </label>`
      })}
    </div>`
  }

  #choicesCell(field) {
    const kind = field.source?.kind ?? ''
    const offered = field.source?.parent ? this._choices.get(sourceKey(field.source)) : undefined
    const list =
      kind === ''
        ? html`<uui-input
            label="Options"
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
        : kind === 'content'
          ? html`<umb-input-document
              max="1"
              .selection=${field.source.parent ? [field.source.parent] : []}
              @change=${(event) => {
                field.source = { kind, parent: event.target.selection?.[0] ?? '' }
                this.#preview(field)
              }}
            ></umb-input-document>`
          : html`<uui-input
              label="Dictionary item"
              placeholder="The name of the parent item"
              .value=${field.source.parent ?? ''}
              @change=${(event) => {
                field.source = { kind, parent: event.target.value.trim() }
                this.#preview(field)
              }}
            ></uui-input>`
    return html`
      <select
        aria-label="Where the options come from"
        @change=${(event) => {
          const chosen = event.target.value
          if (chosen === '') delete field.source
          else {
            field.source = { kind: chosen, parent: '' }
            field.values = []
          }
          this.#touch()
        }}
      >
        ${CHOICE_FROM.map(
          (from) =>
            html`<option value=${from.kind} ?selected=${from.kind === kind}>${from.label}</option>`,
        )}
      </select>
      ${list}
      ${
        kind && offered
          ? html`<p class="offered">
              ${
                offered.length > 0
                  ? `Offers now: ${offered.map((option) => option.label).join(', ')}`
                  : 'Offers nothing yet.'
              }
            </p>`
          : nothing
      }
    `
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

  /** Every field, in order: for the previews, which a layout change does not touch. */
  get #fields() {
    return (this._editing?.pages ?? []).flatMap((page) =>
      page.groups.flatMap((group) => group.fields),
    )
  }

  /** Applies a layout operation from forms-layout.js to the form being edited. */
  #apply(operation, ...args) {
    this._editing = operation(this._editing, ...args)
  }

  #page(page, p) {
    const pages = this._editing.pages
    return html`<section class="page" aria-label=${page.caption || `Page ${p + 1}`}>
      <div class="bar">
        <uui-input
          label="Page title"
          placeholder=${`Page ${p + 1}`}
          .value=${page.caption ?? ''}
          @change=${(event) => this.#apply(setPageCaption, p, event.target.value)}
        ></uui-input>
        <uui-button compact look="secondary" label="Move page up" ?disabled=${p === 0}
          @click=${() => this.#apply(movePage, p, p - 1)}>↑</uui-button>
        <uui-button compact look="secondary" label="Move page down" ?disabled=${p === pages.length - 1}
          @click=${() => this.#apply(movePage, p, p + 1)}>↓</uui-button>
        <uui-button compact look="secondary" color="danger" label="Remove page" ?disabled=${pages.length === 1}
          @click=${() => {
            if (pageHasFields(page) && !confirm('Remove this page and the fields on it?')) return
            this.#apply(removePage, p)
          }}></uui-button>
      </div>
      ${page.groups.map((group, g) => this.#group(group, p, g, page.groups.length))}
      <uui-button look="secondary" label="Add a group" @click=${() => this.#apply(addGroup, p)}></uui-button>
    </section>`
  }

  #group(group, p, g, count) {
    return html`<div
      class="group"
      @dragover=${(event) => event.preventDefault()}
      @drop=${(event) => this.#drop(event, { page: p, group: g, index: group.fields.length })}
    >
      <div class="bar">
        <uui-input
          label="Group title"
          placeholder="Untitled group"
          .value=${group.caption ?? ''}
          @change=${(event) => this.#apply(setGroupCaption, p, g, event.target.value)}
        ></uui-input>
        <label class="columns">
          Columns
          <select @change=${(event) => this.#apply(setColumns, p, g, Number(event.target.value))}>
            ${[1, 2, 3, 4].map((n) => html`<option value=${n} ?selected=${n === group.columns}>${n}</option>`)}
          </select>
        </label>
        <uui-button compact look="secondary" label="Move group up" ?disabled=${g === 0}
          @click=${() => this.#apply(moveGroup, p, g, g - 1)}>↑</uui-button>
        <uui-button compact look="secondary" label="Move group down" ?disabled=${g === count - 1}
          @click=${() => this.#apply(moveGroup, p, g, g + 1)}>↓</uui-button>
        <uui-button compact look="secondary" color="danger" label="Remove group" ?disabled=${count === 1}
          @click=${() => {
            if (groupHasFields(group) && !confirm('Remove this group and its fields?')) return
            this.#apply(removeGroup, p, g)
          }}></uui-button>
      </div>
      ${
        group.fields.length > 0
          ? html`<div class="preview" style=${`grid-template-columns: repeat(${group.columns}, 1fr)`} aria-hidden="true">
              ${layoutRows(group)
                .flat()
                .map(
                  (field) => html`<span>${field.caption || field.alias || 'Untitled field'}</span>`,
                )}
            </div>`
          : nothing
      }
      ${this.#fieldsTable(group, p, g)}
      <uui-button
        look="secondary"
        label="Add a field"
        @click=${() => {
          group.fields.push({
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
    </div>`
  }

  #drop(event, to) {
    event.preventDefault()
    event.stopPropagation()
    const from = JSON.parse(event.dataTransfer?.getData('application/x-crombolo-field') || 'null')
    if (from) this.#apply(moveField, from, to)
  }

  #fieldsTable(group, p, g) {
    return html`<uui-table>
          <uui-table-head>
            <uui-table-head-cell>Order</uui-table-head-cell>
            <uui-table-head-cell>Caption</uui-table-head-cell>
            <uui-table-head-cell>Alias</uui-table-head-cell>
            <uui-table-head-cell>Type</uui-table-head-cell>
            <uui-table-head-cell>Choices</uui-table-head-cell>
            <uui-table-head-cell>Settings</uui-table-head-cell>
            <uui-table-head-cell>Required</uui-table-head-cell>
            <uui-table-head-cell>Sensitive</uui-table-head-cell>
            <uui-table-head-cell></uui-table-head-cell>
          </uui-table-head>
          ${repeat(
            group.fields,
            (_field, index) => index,
            (field, index) => html`
              <uui-table-row
                draggable="true"
                @dragstart=${(event) =>
                  event.dataTransfer?.setData(
                    'application/x-crombolo-field',
                    JSON.stringify({ page: p, group: g, index }),
                  )}
                @dragover=${(event) => event.preventDefault()}
                @drop=${(event) => this.#drop(event, { page: p, group: g, index })}
              >
                <uui-table-cell>
                  <uui-button compact look="secondary" label="Move field up"
                    @click=${() => this.#apply(nudgeField, { page: p, group: g, index }, -1)}>↑</uui-button>
                  <uui-button compact look="secondary" label="Move field down"
                    @click=${() => this.#apply(nudgeField, { page: p, group: g, index }, 1)}>↓</uui-button>
                </uui-table-cell>
                <uui-table-cell>
                  <uui-input
                    label="Caption"
                    .value=${field.caption ?? ''}
                    @change=${(event) => {
                      field.caption = event.target.value
                      this.#touch()
                    }}
                  ></uui-input>
                </uui-table-cell>
                <uui-table-cell>
                  <uui-input
                    label="Alias"
                    .value=${field.alias ?? ''}
                    @change=${(event) => {
                      field.alias = event.target.value
                      this.#touch()
                    }}
                  ></uui-input>
                </uui-table-cell>
                <uui-table-cell>
                  <select
                    aria-label="Type"
                    @change=${(event) => {
                      this.#changeType(field, event.target.value)
                      this.#touch()
                    }}
                  >
                    ${[...this._types.values()].map(
                      (info) =>
                        html`<option value=${info.type} ?selected=${info.type === field.type}>${info.label}</option>`,
                    )}
                  </select>
                </uui-table-cell>
                <uui-table-cell>
                  ${this._types.get(field.type)?.choices ? this.#choicesCell(field) : nothing}
                </uui-table-cell>
                <uui-table-cell>${this.#settingsCell(field)}</uui-table-cell>
                <uui-table-cell>
                  <uui-toggle
                    label="Required"
                    .checked=${field.mandatory === true}
                    @change=${(event) => {
                      field.mandatory = event.target.checked
                      this.#touch()
                    }}
                  ></uui-toggle>
                </uui-table-cell>
                <uui-table-cell>
                  <uui-toggle
                    label="Sensitive"
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
                      group.fields.splice(index, 1)
                      this.#touch()
                    }}
                  ></uui-button>
                </uui-table-cell>
              </uui-table-row>
            `,
          )}
        </uui-table>`
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
        // The green toast every workspace shows on a save.
        this.#notifications?.peek('positive', { data: { message: 'Form saved' } })
        this._editing = undefined
        await this.#load()
      } else {
        this._problems = result.body.problems ?? []
        if (result.body.status === 'readOnly' && this._problems.length === 0)
          this._problems = [
            { path: '', message: 'The schema directory is read-only on this node.' },
          ]
      }
    } catch (error) {
      this._problems = [{ path: '', message: error.message }]
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
    if (this._forms === undefined) return html`<div class="list"><uui-loader></uui-loader></div>`
    if (this._editing) return this.#editor()
    return html`<div class="list">
      ${this._notice ? html`<uui-box><p>${this._notice}</p></uui-box>` : nothing}
      ${this.#list()}
    </div>`
  }

  #list() {
    // The create button above the list, as the workflows list has it.
    return html`
      <uui-button class="create" color="default" look="outline" label="Create" @click=${() => this.#new()}></uui-button>
      <uui-box headline="Forms">
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
    const leave = () => {
      this._editing = undefined
      this._problems = []
    }
    // Umbraco's own layout, as the workflow designer has it: Save bottom right,
    // and what stopped a save listed just above it.
    return html`<umb-body-layout headline=${form.alias ? `Form: ${form.name || form.alias}` : 'A new form'}>
      <uui-box>
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
        ${
          form.pages.length > 1
            ? html`<uui-form-layout-item>
                <uui-label slot="label">Show one page at a time</uui-label>
                <span slot="description">Each page is checked before the next. Without JavaScript the pages show together.</span>
                <uui-toggle
                  .checked=${form.stepPages === true}
                  @change=${(event) => {
                    if (event.target.checked) form.stepPages = true
                    else delete form.stepPages
                    this.#touch()
                  }}
                ></uui-toggle>
              </uui-form-layout-item>
              ${text('nextLabel', 'Next button')}
              ${text('previousLabel', 'Back button')}`
            : nothing
        }

        <h4>Layout</h4>
        ${this._editing.pages.map((page, p) => this.#page(page, p))}
        <div class="actions">
          <uui-button look="secondary" label="Add a page" @click=${() => this.#apply(addPage)}></uui-button>
        </div>
      </uui-box>
      ${
        this._problems.length > 0
          ? html`<div class="problems" role="alert">
              <p>This form was not saved:</p>
              <ul>
                ${this._problems.map((problem) => html`<li>${problem.path ? html`<code>${problem.path}</code> ` : nothing}${problem.message}</li>`)}
              </ul>
            </div>`
          : nothing
      }
      ${
        this._problems.length > 0
          ? html`<span slot="footer-info" class="not-saved">Not saved: ${this._problems.length} problem(s), listed above</span>`
          : nothing
      }
      <uui-button slot="actions" look="secondary" label="Back to the list" @click=${leave}>Back to the list</uui-button>
      <uui-button slot="actions" look="primary" color="positive" label="Save" ?disabled=${this._busy} @click=${() => this.#save()}>Save</uui-button>
    </umb-body-layout>`
  }

  static styles = css`
    .page {
      border: 1px solid var(--uui-color-border, #ddd);
      border-radius: var(--uui-border-radius, 3px);
      padding: var(--uui-size-space-4, 12px);
      margin-bottom: var(--uui-size-space-4, 12px);
    }
    .group {
      border-left: 3px solid var(--uui-color-divider-emphasis, #ccc);
      padding: var(--uui-size-space-3, 9px) 0 var(--uui-size-space-3, 9px)
        var(--uui-size-space-4, 12px);
      margin: var(--uui-size-space-3, 9px) 0;
    }
    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--uui-size-space-2, 6px);
      margin-bottom: var(--uui-size-space-3, 9px);
    }
    .columns {
      display: inline-flex;
      align-items: center;
      gap: var(--uui-size-space-2, 6px);
    }
    .preview {
      display: grid;
      gap: var(--uui-size-space-2, 6px);
      margin-bottom: var(--uui-size-space-3, 9px);
    }
    .preview span {
      padding: var(--uui-size-space-2, 6px);
      background: var(--uui-color-surface-alt, #f3f3f5);
      border-radius: var(--uui-border-radius, 3px);
      font-size: 0.9em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    uui-table-row[draggable='true'] {
      cursor: grab;
    }
    .settings {
      display: grid;
      gap: var(--uui-size-space-2, 6px);
    }
    .settings label {
      display: grid;
      gap: 2px;
      font-size: 0.9em;
    }
    .offered {
      margin: var(--uui-size-space-2, 6px) 0 0;
      color: var(--uui-color-text-alt, #555);
      font-size: 0.9em;
    }
    :host {
      display: block;
      height: 100%;
    }
    .list {
      padding: var(--uui-size-layout-1, 24px);
    }
    .create {
      margin-bottom: var(--uui-size-space-5, 18px);
    }
    .not-saved {
      color: var(--uui-color-danger, #d42054);
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

customElements.define('crombolo-forms-overview', CromboloFormsOverviewElement)
