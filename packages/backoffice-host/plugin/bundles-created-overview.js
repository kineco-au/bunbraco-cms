/**
 * The list of bundles that have been defined, inside the Created view.
 *
 * Reads through `UmbPackageRepository` rather than this plugin's own endpoints:
 * the definitions are the Management API's nine `package` operations, which are
 * contract-fixed and bearer-authenticated, and the repository already carries
 * the client's token. The plugin's `/crombolo/api/bundles` routes are a
 * different thing — installed npm bundles, on the session cookie — and one of
 * them is used here too: every bundle downloads as an npm package, and the name
 * and version it is packed under are not part of Umbraco's definition.
 */

import { css, html, nothing, repeat } from '@umbraco-cms/backoffice/external/lit'
import { UmbLitElement } from '@umbraco-cms/backoffice/lit-element'
import { umbConfirmModal } from '@umbraco-cms/backoffice/modal'
import { UmbPackageRepository } from '@umbraco-cms/backoffice/package'
import { readCreatedPackage, saveCreatedPackage } from './bundles-client.js'

const TAKE = 10

/** Where the builder lives, which is Umbraco's route and not ours to rename. */
export const BUILDER_PATH = 'section/packages/view/created/package-builder'

export default class CromboloBundlesCreatedOverviewElement extends UmbLitElement {
  static properties = {
    _items: { state: true },
    _loading: { state: true },
    _total: { state: true },
    _page: { state: true },
    _packages: { state: true },
    _editing: { state: true },
    _draft: { state: true },
    _problem: { state: true },
  }

  #repository = new UmbPackageRepository(this)

  constructor() {
    super()
    this._items = []
    this._loading = true
    this._total = 0
    this._page = 1
    this._packages = {}
    this._editing = ''
    this._draft = { name: '', version: '' }
    this._problem = ''
  }

  connectedCallback() {
    super.connectedCallback()
    this.#load()
  }

  async #load() {
    this._loading = true
    const skip = this._page * TAKE - TAKE
    const data = await this.#repository.getCreatedPackages({ skip, take: TAKE })
    this._items = data?.items ?? []
    this._total = data?.total ?? 0
    this._loading = false
    const packages = {}
    await Promise.all(
      this._items
        .filter((item) => item.unique)
        .map(async (item) => {
          packages[item.unique] = await readCreatedPackage(item.unique).catch(() => undefined)
        }),
    )
    this._packages = packages
  }

  #edit(item) {
    const pkg = this._packages[item.unique]
    this._editing = item.unique
    this._problem = ''
    this._draft = {
      name: pkg?.set?.name ? pkg.name : '',
      version: pkg?.set?.version ? pkg.version : '',
    }
  }

  async #save() {
    const outcome = await saveCreatedPackage(this._editing, this._draft)
    if (!outcome.ok) {
      this._problem = outcome.message ?? 'Those details could not be saved.'
      return
    }
    this._packages = { ...this._packages, [this._editing]: outcome.package }
    this._editing = ''
  }

  #renderEditor(item) {
    if (this._editing !== item.unique) return nothing
    const pkg = this._packages[item.unique]
    return html`
      <div class="package-editor">
        <p>
          This bundle downloads as the npm package <code>${pkg?.name}@${pkg?.version}</code>.
          Leave a field empty to go back to the name taken from the bundle's own name, and
          version 1.0.0.
        </p>
        <uui-input
          label="Package name"
          placeholder=${pkg?.name ?? ''}
          .value=${this._draft.name}
          @input=${(event) => (this._draft = { ...this._draft, name: event.target.value })}></uui-input>
        <uui-input
          label="Version"
          placeholder="1.0.0"
          .value=${this._draft.version}
          @input=${(event) => (this._draft = { ...this._draft, version: event.target.value })}></uui-input>
        ${this._problem ? html`<p class="problem">${this._problem}</p>` : nothing}
        <uui-button look="primary" label="Save" @click=${() => this.#save()}></uui-button>
        <uui-button label="Cancel" @click=${() => (this._editing = '')}></uui-button>
      </div>
    `
  }

  #detail(item) {
    const pkg = this._packages[item.unique]
    return pkg ? `${pkg.name}@${pkg.version}` : ''
  }

  #onPageChange(event) {
    const current = event.target.current
    if (current === this._page) return
    this._page = current
    this.#load()
  }

  async #remove(item) {
    if (!item.unique) return
    await umbConfirmModal(this, {
      color: 'danger',
      headline: `Remove ${item.name}?`,
      content: 'Are you sure you want to delete this bundle?',
      confirmLabel: '#general_delete',
    })
    if (!(await this.#repository.deleteCreatedPackage(item.unique))) return
    this._items = this._items.filter((other) => other.unique !== item.unique)
    this._total = Math.max(0, this._total - 1)
  }

  #open(item) {
    if (!item.unique) return
    window.history.pushState({}, '', `${BUILDER_PATH}/edit/${item.unique}`)
  }

  #renderPagination() {
    const pages = Math.ceil(this._total / TAKE)
    if (pages <= 1) return nothing
    return html`
      <div id="pages">
        <uui-pagination
          .total=${pages}
          .current=${this._page}
          @change=${this.#onPageChange}></uui-pagination>
      </div>
    `
  }

  render() {
    // The button stays put while the list loads, as it does upstream: it is the
    // only way to reach the builder, and a loader that hides it makes the view
    // look empty on every page change.
    return html`
      <uui-button
        look="primary"
        href=${`${BUILDER_PATH}/create`}
        label=${this.localize.term('packager_createPackage')}></uui-button>
      ${
        this._loading
          ? html`<div id="loader"><uui-loader></uui-loader></div>`
          : this._items.length === 0
            ? html`<h2 id="empty">${this.localize.term('packager_noPackagesCreated')}</h2>`
            : html`
            <uui-box headline="Created bundles" style="--uui-box-default-padding:0;">
              <uui-ref-list>
                ${repeat(
                  this._items,
                  (item) => item.unique,
                  (item) => html`
                    <uui-ref-node
                      name=${item.name}
                      detail=${this.#detail(item)}
                      @open=${() => this.#open(item)}>
                      <uui-action-bar slot="actions">
                        <uui-button
                          @click=${() => this.#edit(item)}
                          label="Package details"></uui-button>
                        <uui-button
                          @click=${() => this.#remove(item)}
                          label=${this.localize.term('general_delete')}></uui-button>
                      </uui-action-bar>
                    </uui-ref-node>
                    ${this.#renderEditor(item)}
                  `,
                )}
              </uui-ref-list>
            </uui-box>
          `
      }
      ${this.#renderPagination()}
    `
  }

  static styles = css`
    :host {
      display: block;
      padding: var(--uui-size-layout-1);
    }
    uui-box {
      margin: var(--uui-size-space-5) 0;
      padding-bottom: var(--uui-size-space-1);
    }
    #loader,
    #pages {
      display: flex;
      justify-content: center;
    }
    #empty {
      text-align: center;
      opacity: 0.6;
    }
    .package-editor {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--uui-size-space-3);
      padding: var(--uui-size-space-4) var(--uui-size-space-5);
      background: var(--uui-color-surface-alt);
    }
    .package-editor p {
      flex-basis: 100%;
      margin: 0;
    }
    .problem {
      color: var(--uui-color-danger);
    }
  `
}

customElements.define('crombolo-bundles-created-overview', CromboloBundlesCreatedOverviewElement)
