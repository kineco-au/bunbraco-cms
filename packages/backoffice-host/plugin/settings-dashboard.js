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
import { css, html, nothing } from '@umbraco-cms/backoffice/external/lit'
import { UmbLitElement } from '@umbraco-cms/backoffice/lit-element'

/** Whether this site can send e-mail; the server answers with the reason. */
const emailStatus = async () => {
  const href = document.querySelector('base')?.getAttribute('href') ?? '/umbraco/'
  const response = await fetch(`${href.replace(/\/$/, '')}/bunbraco/api/email`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`email responded ${response.status}`)
  return response.json()
}

export default class BunbracoSettingsDashboardElement extends UmbLitElement {
  static properties = {
    _email: { state: true },
  }

  connectedCallback() {
    super.connectedCallback()
    // A failure here leaves the section out rather than the dashboard broken:
    // this is an explanation, not a control.
    emailStatus().then(
      (status) => {
        this._email = status
      },
      () => {},
    )
  }

  #email() {
    const status = this._email
    if (!status) return nothing
    if (status.available)
      return html`
        <uui-box headline="E-mail">
          <p>E-mail is sent through <strong>${status.provider}</strong>.</p>
        </uui-box>
      `
    return html`
      <uui-box headline="E-mail">
        <p>${status.reason}</p>
        ${
          status.affects.length > 0
            ? html`<p>Until one is configured, these are unavailable:</p>
                <ul>
                  ${status.affects.map((feature) => html`<li>${feature}</li>`)}
                </ul>`
            : nothing
        }
      </uui-box>
    `
  }

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
      ${this.#email()}
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
    uui-box + uui-box {
      margin-top: var(--uui-size-layout-1, 24px);
    }
    ul {
      max-width: 60ch;
      line-height: 1.5;
    }
  `
}

customElements.define('bunbraco-settings-dashboard', BunbracoSettingsDashboardElement)
