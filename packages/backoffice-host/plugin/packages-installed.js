/**
 * The Installed view, in place of Umbraco's.
 *
 * Its manifest declares `overwrites: ['Umb.SectionView.Packages.Installed']`.
 * Umbraco's view is built around package migrations — it lists installed
 * packages so that pending C# migrations can be run. Nothing carries those here
 * (`docs/17-packages.md`), so the view would be a list of nothing with a button
 * that cannot apply.
 *
 * What it lists instead is the site's declared `bunbraco` dependencies, which is
 * what "installed" means here, and where each one came from.
 */
import { css, html, nothing, repeat } from '@umbraco-cms/backoffice/external/lit'
import { UmbLitElement } from '@umbraco-cms/backoffice/lit-element'
import { listInstalled, uninstallPackage } from './packages-client.js'

export default class BunbracoPackagesInstalledElement extends UmbLitElement {
  static properties = {
    _items: { state: true },
    _loading: { state: true },
    _busy: { state: true },
    _notice: { state: true },
  }

  constructor() {
    super()
    this._items = []
    this._loading = true
    this._busy = ''
    this._notice = ''
  }

  connectedCallback() {
    super.connectedCallback()
    this.#load()
  }

  async #load() {
    this._loading = true
    try {
      this._items = (await listInstalled()).items ?? []
    } catch (error) {
      this._notice = error instanceof Error ? error.message : String(error)
    } finally {
      this._loading = false
    }
  }

  async #uninstall(item) {
    this._busy = item.packageName
    try {
      const outcome = await uninstallPackage(item.packageName)
      this._notice = outcome.message ?? ''
      if (outcome.ok) await this.#load()
    } catch (error) {
      this._notice = error instanceof Error ? error.message : String(error)
    } finally {
      this._busy = ''
    }
  }

  render() {
    if (this._loading) return html`<div id="loader"><uui-loader></uui-loader></div>`

    return html`
      ${this._notice ? html`<div id="notice">${this._notice}</div>` : nothing}
      ${
        this._items.length === 0
          ? html`
            <uui-box headline="No extensions installed">
              <p>
                Backoffice extensions are this site's npm dependencies. Install one from the
                Packages tab, or with <code>bun add</code> in the site directory — a dependency
                that declares a <code>bunbraco</code> field appears here.
              </p>
            </uui-box>
          `
          : html`
            <uui-box headline="Installed extensions">
              <uui-table>
                <uui-table-head>
                  <uui-table-head-cell>Name</uui-table-head-cell>
                  <uui-table-head-cell>Package</uui-table-head-cell>
                  <uui-table-head-cell>Version</uui-table-head-cell>
                  <uui-table-head-cell>Extensions</uui-table-head-cell>
                  <uui-table-head-cell></uui-table-head-cell>
                </uui-table-head>
                ${repeat(
                  this._items,
                  (item) => item.packageName,
                  (item) => html`
                    <uui-table-row>
                      <uui-table-cell>${item.name}</uui-table-cell>
                      <uui-table-cell><code>${item.packageName}</code></uui-table-cell>
                      <uui-table-cell>${item.version}</uui-table-cell>
                      <uui-table-cell>${item.extensionCount}</uui-table-cell>
                      <uui-table-cell>
                        <uui-button
                          look="secondary"
                          color="danger"
                          label="Uninstall"
                          .state=${this._busy === item.packageName ? 'waiting' : undefined}
                          @click=${() => this.#uninstall(item)}></uui-button>
                      </uui-table-cell>
                    </uui-table-row>
                  `,
                )}
              </uui-table>
              <p class="note">
                An install writes this site's <code>package.json</code> and
                <code>bun.lock</code>. Commit both to keep it across deployments.
              </p>
            </uui-box>
          `
      }
    `
  }

  static styles = css`
    :host {
      display: block;
      padding: var(--uui-size-layout-1, 24px);
    }
    #loader {
      display: flex;
      justify-content: center;
      padding: var(--uui-size-layout-3, 48px);
    }
    #notice {
      margin-bottom: var(--uui-size-space-4, 12px);
      padding: var(--uui-size-space-4, 12px);
      border-left: 3px solid var(--uui-color-positive, #2bc37c);
      background: var(--uui-color-surface-alt, #f3f3f5);
    }
    p {
      max-width: 60ch;
      line-height: 1.5;
    }
    .note {
      margin-top: var(--uui-size-space-5, 18px);
      opacity: 0.8;
      font-size: 0.9em;
    }
  `
}

customElements.define('bunbraco-packages-installed', BunbracoPackagesInstalledElement)
