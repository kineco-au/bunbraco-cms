/**
 * The Welcome dashboard in the Content section. Its manifest declares
 * `overwrites: ['Umb.Dashboard.UmbracoNews']`, which takes the place of
 * Umbraco's news dashboard without mutating the registry while the backoffice
 * is rendering — the hazard the TSX entry point documents.
 */
// UmbLitElement, not plain LitElement: a dashboard is used as a controller host,
// and a plain element fails with `controllerHost.provideContext is not a function`.
import { css, html } from '@umbraco-cms/backoffice/external/lit'
import { UmbLitElement } from '@umbraco-cms/backoffice/lit-element'

const STEPS = [
  {
    title: 'Model the content',
    body: html`Open <strong>Settings → Document Types</strong> and describe a page: its
      properties, its tabs, and which types may sit beneath it. This is the same
      editor Umbraco ships, so anything you know about document types applies.`,
  },
  {
    title: 'Write a template',
    body: html`Templates are <strong>TSX</strong>, not Razor. A template is a file in
      <code>Views/</code> that default-exports a component and receives the page as
      <code>model</code>; <code>export const layout = 'alias'</code> names its master.
      The editor under Settings → Templates writes that shape for you.`,
  },
  {
    title: 'Create and publish',
    body: html`Back in <strong>Content</strong>, create a page from your document type, fill it
      in and publish. Publishing is per culture, and the published version is what the
      site renders — drafts stay invisible until you say otherwise.`,
  },
  {
    title: 'Keep the schema in the repository',
    body: html`Document types, data types and templates are also files:
      <code>schema/*.toml</code>. <code>bunbraco schema sync</code> writes changes made in
      the backoffice back out, and <code>bunbraco schema check</code> tells you whether a
      database matches. Schema travels through Git, not a database export.`,
  },
]

export default class BunbracoWelcomeDashboardElement extends UmbLitElement {
  render() {
    return html`
      <uui-box headline="Welcome to Bunbraco">
        <p class="lede">
          Bunbraco is a content management system that runs on
          <strong>Bun and TypeScript</strong>. It serves the real Umbraco backoffice you
          are looking at now and follows Umbraco's API contract, so the editing
          experience is Umbraco's — while the server, the templates and the schema are
          TypeScript, and the database is SQLite or Postgres.
        </p>
        <p class="lede">
          There is no .NET anywhere in it: templates are TSX rather than Razor, and a
          site's schema lives in TOML files beside its code.
        </p>
      </uui-box>

      <uui-box headline="Getting started">
        <ol>
          ${STEPS.map(
            (step) => html`<li>
              <h4>${step.title}</h4>
              <p>${step.body}</p>
            </li>`,
          )}
        </ol>
      </uui-box>

      <uui-box headline="Worth knowing">
        <ul>
          <li>
            The <strong>Settings</strong> section holds templates, partial views,
            stylesheets and scripts — all served from your site's folders.
          </li>
          <li>
            <strong>Upgrade</strong>, also under Settings, reports anything a version
            change needs from you before it will run.
          </li>
          <li>
            The log viewer under Settings reads the server's own structured logs, so a
            failed publish or a broken template is searchable rather than guessed at.
          </li>
        </ul>
      </uui-box>
    `
  }

  static styles = css`
    :host { display: block; padding: var(--uui-size-layout-1); }
    uui-box { margin-bottom: var(--uui-size-layout-1); }
    .lede { max-width: 70ch; line-height: 1.6; }
    ol { margin: 0; padding-left: var(--uui-size-layout-1); }
    ol li { margin-bottom: var(--uui-size-space-5); max-width: 70ch; }
    ol h4 { margin: 0 0 var(--uui-size-space-2); }
    ol p { margin: 0; line-height: 1.6; }
    ul { margin: 0; padding-left: var(--uui-size-layout-1); }
    ul li { margin-bottom: var(--uui-size-space-3); max-width: 70ch; line-height: 1.6; }
    code {
      background: var(--uui-color-surface-alt);
      padding: 0 var(--uui-size-space-1);
      border-radius: var(--uui-border-radius);
    }
  `
}

customElements.define('bunbraco-welcome-dashboard', BunbracoWelcomeDashboardElement)
