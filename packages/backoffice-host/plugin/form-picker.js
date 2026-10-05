/**
 * The Form Picker property editor.
 *
 * A form is a file in `schema/forms/`, so the list comes from the server rather
 * than from a tree of nodes: there is nothing in the database to browse. The
 * stored value is the form's key, which is what a render resolves back to the
 * definition.
 *
 * Shows the alias beside the name because a form is referred to by alias
 * everywhere else — in a view, in a workflow's settings, in a diff.
 */
import { css, html, nothing, repeat } from '@umbraco-cms/backoffice/external/lit'
import { UmbLitElement } from '@umbraco-cms/backoffice/lit-element'

const forms = async () => {
  const href = document.querySelector('base')?.getAttribute('href') ?? '/umbraco/'
  const response = await fetch(`${href.replace(/\/$/, '')}/bunbraco/api/forms`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`forms responded ${response.status}`)
  return (await response.json()).items ?? []
}

export default class BunbracoFormPickerElement extends UmbLitElement {
  static properties = {
    value: { type: String },
    _items: { state: true },
    _failed: { state: true },
  }

  constructor() {
    super()
    this.value = ''
    this._items = undefined
    this._failed = false
  }

  connectedCallback() {
    super.connectedCallback()
    forms().then(
      (items) => {
        this._items = items
      },
      () => {
        this._failed = true
      },
    )
  }

  /**
   * A plain `change` on the host, which is what `umb-property` listens for.
   *
   * `UmbPropertyValueChangeEvent` is deprecated upstream and is not exported by
   * the vendored client at all, so importing it would fail at runtime. The
   * inner select's own event is stopped so the host dispatches exactly one.
   */
  #pick(event) {
    event.stopPropagation()
    this.value = event.target.value || undefined
    this.dispatchEvent(new Event('change'))
  }

  render() {
    if (this._failed) return html`<uui-box><p>The list of forms could not be loaded.</p></uui-box>`
    if (this._items === undefined) return html`<uui-loader></uui-loader>`
    if (this._items.length === 0)
      return html`
        <p class="empty">
          This site has no forms. Add one as a TOML file in <code>schema/forms/</code>.
        </p>
      `
    return html`
      <uui-select
        .value=${this.value ?? ''}
        @change=${this.#pick}
        label="Form"
        placeholder="Choose a form"
      >
        <option value="">(none)</option>
        ${repeat(
          this._items,
          (form) => form.key,
          (form) => html`
            <option value=${form.key} ?selected=${form.key === this.value}>
              ${form.name} (${form.alias})
            </option>
          `,
        )}
      </uui-select>
      ${this.value ? html`<p class="detail">${this.#describe()}</p>` : nothing}
    `
  }

  #describe() {
    const form = this._items?.find((item) => item.key === this.value)
    if (!form) return 'This form is no longer in schema/forms/.'
    const fields = `${form.fieldCount} field${form.fieldCount === 1 ? '' : 's'}`
    const pages = `${form.pageCount} page${form.pageCount === 1 ? '' : 's'}`
    return `${fields} over ${pages}${form.storeEntries ? '' : '; entries are not stored'}`
  }

  static styles = css`
    :host {
      display: block;
    }
    .empty,
    .detail {
      color: var(--uui-color-text-alt, #666);
      font-size: var(--uui-type-small-size, 0.8rem);
      margin: var(--uui-size-space-2, 6px) 0 0;
    }
  `
}

customElements.define('bunbraco-form-picker', BunbracoFormPickerElement)
