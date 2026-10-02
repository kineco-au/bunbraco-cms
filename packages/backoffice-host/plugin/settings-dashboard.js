/**
 * The Settings dashboard, in place of Umbraco's.
 *
 * Its manifest declares `overwrites: ['Umb.Dashboard.SettingsWelcome']`, the same
 * way the Welcome dashboard takes the place of the news one. What it replaces is
 * marketing for Umbraco's own training and consultancy — accurate for Umbraco and
 * misleading here, and not the sort of thing to fix by renaming, since the
 * services it points at are real and are not this project's.
 *
 * What it says instead is the thing a person in Settings actually needs to know:
 * that types are files, and that changing one here writes that file.
 */
// UmbLitElement, not plain LitElement: a dashboard is used as a controller host,
// and a plain element fails with `controllerHost.provideContext is not a function`.
import { css, html } from '@umbraco-cms/backoffice/external/lit'
import { UmbLitElement } from '@umbraco-cms/backoffice/lit-element'

export default class BunbracoSettingsDashboardElement extends UmbLitElement {
  render() {
    return html`
      <uui-box headline="Settings">
        <p>
          Document types, data types and languages are <strong>files</strong>, in
          <code>schema/</code>, written as TOML. The database is a view of them: what you change
          here is written to the file, and the file is what a deploy and every other node reads.
        </p>
        <p>
          That is why a type can be reviewed in a pull request, and why a schema change carries a
          version — a change that converts existing content is a major, and the backoffice moves
          the number for you.
        </p>
        <p class="links">
          <a href="https://github.com/kineco-au/bunbraco-cms#schema-as-code" target="_blank" rel="noopener">
            Schema as code
          </a>
          <a href="https://github.com/kineco-au/bunbraco-cms#schema-in-shared-storage" target="_blank" rel="noopener">
            Schema in shared storage
          </a>
          <a href="https://github.com/kineco-au/bunbraco-cms/issues" target="_blank" rel="noopener">
            Report an issue
          </a>
        </p>
      </uui-box>
    `
  }

  static styles = css`
    :host {
      display: block;
      padding: var(--uui-size-layout-1, 24px);
    }
    p {
      max-width: 60ch;
      line-height: 1.5;
    }
    .links {
      display: flex;
      gap: var(--uui-size-space-5, 18px);
      flex-wrap: wrap;
    }
  `
}

customElements.define('bunbraco-settings-dashboard', BunbracoSettingsDashboardElement)
