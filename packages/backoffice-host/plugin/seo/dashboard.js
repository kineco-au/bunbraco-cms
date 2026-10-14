/**
 * Search & sharing, in Settings: the site-wide values every page falls back
 * to, the robots file, and the page shown for an address that does not exist.
 *
 * Each field starts from the site's configuration. A value saved here overrides
 * it, and "Use the default" removes the override, so the configuration applies
 * again; the label beside each field says which is in force.
 */
// For their side effects: these register `umb-input-document` and
// `umb-input-media`, which the shell otherwise loads lazily.
import '@umbraco-cms/backoffice/document'
import '@umbraco-cms/backoffice/media'
import { css, html, nothing } from '@umbraco-cms/backoffice/external/lit'
import { UmbLitElement } from '@umbraco-cms/backoffice/lit-element'
import { readSettings, saveSettings } from './client.js'

const SOURCES = {
  backoffice: 'Set here',
  config: 'From the site configuration',
  default: 'Default',
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default class CromboloSeoDashboardElement extends UmbLitElement {
  static properties = {
    _settings: { state: true },
    _draft: { state: true },
    _message: { state: true },
    _saving: { state: true },
  }

  constructor() {
    super()
    this._draft = {}
  }

  connectedCallback() {
    super.connectedCallback()
    this.#load()
  }

  async #load() {
    try {
      this._settings = await readSettings()
      this._draft = {}
    } catch (error) {
      this._message = error.message
    }
  }

  #value(field) {
    return field in this._draft ? this._draft[field] : this._settings.effective[field]
  }

  #set(field, value) {
    this._draft = { ...this._draft, [field]: value }
  }

  async #save(changes) {
    this._saving = true
    try {
      this._settings = await saveSettings(changes)
      this._draft = {}
      this._message = 'Saved.'
    } catch (error) {
      this._message = error.message
    } finally {
      this._saving = false
    }
  }

  #source(field) {
    const source = this._settings.sources[field]
    return html`
      <span class="source">
        <uui-tag look="secondary">${SOURCES[source]}</uui-tag>
        ${
          source === 'backoffice'
            ? html`<uui-button
                compact
                look="placeholder"
                label="Use the default"
                @click=${() => this.#save({ [field]: null })}
              ></uui-button>`
            : nothing
        }
      </span>
    `
  }

  #field(field, label, description, control) {
    return html`
      <div class="field">
        <div class="label">
          <strong>${label}</strong>
          ${this.#source(field)}
        </div>
        <small>${description}</small>
        ${control}
      </div>
    `
  }

  #toggle(field, label, description) {
    return this.#field(
      field,
      label,
      description,
      html`<uui-toggle
        .checked=${Boolean(this.#value(field))}
        label=${label}
        @change=${(event) => this.#set(field, event.target.checked)}
      ></uui-toggle>`,
    )
  }

  #text(field, label, description, placeholder = '') {
    return this.#field(
      field,
      label,
      description,
      html`<uui-input
        .value=${this.#value(field) ?? ''}
        label=${label}
        placeholder=${placeholder}
        @input=${(event) => this.#set(field, event.target.value)}
      ></uui-input>`,
    )
  }

  render() {
    if (!this._settings)
      return this._message
        ? html`<uui-box><p>${this._message}</p></uui-box>`
        : html`<uui-loader></uui-loader>`
    const image = this.#value('defaultImage')
    const notFound = this.#value('notFoundPage') ?? []
    const scoped = notFound.some((rule) => rule.host || rule.culture)
    return html`
      <uui-box headline="Search & sharing">
        ${this.#toggle(
          'indexable',
          'Let search engines list this site',
          'Turn off for a site that is not live yet, such as a staging copy.',
        )}
        ${this.#toggle(
          'sitemap',
          'Offer a list of pages to search engines',
          'Lists every published page at /sitemap.xml, except those hidden from it.',
        )}
        ${this.#text('siteName', 'Site name', 'Shown when a page is shared.')}
        ${this.#text(
          'titleSuffix',
          'Added to every page title',
          'For example " | Acme". Leave empty for none.',
        )}
        ${this.#field(
          'defaultImage',
          'Sharing image',
          'Used when a page without its own image is shared.',
          html`<umb-input-media
            max="1"
            .selection=${UUID.test(image ?? '') ? [image] : []}
            @change=${(event) => this.#set('defaultImage', event.target.selection?.[0] ?? '')}
          ></umb-input-media>`,
        )}
        ${this.#field(
          'notFoundPage',
          'Page for addresses that do not exist',
          scoped
            ? 'The site configuration chooses a page per address or language. Choosing one here uses it everywhere.'
            : 'Shown, with a "not found" status, when nothing else answers an address.',
          html`<umb-input-document
            max="1"
            .selection=${notFound[0]?.document && !scoped ? [notFound[0].document] : []}
            @change=${(event) => {
              const key = event.target.selection?.[0]
              this.#set('notFoundPage', key ? [{ document: key }] : [])
            }}
          ></umb-input-document>`,
        )}
        ${this.#field(
          'robotsTxt',
          'Instructions for search engines',
          'The rules in /robots.txt. The address of the page list is added for you.',
          html`<uui-textarea
            .value=${this.#value('robotsTxt') ?? ''}
            label="Instructions for search engines"
            @input=${(event) => this.#set('robotsTxt', event.target.value)}
          ></uui-textarea>`,
        )}
        <div class="actions">
          <uui-button
            look="primary"
            label="Save"
            ?disabled=${this._saving || Object.keys(this._draft).length === 0}
            @click=${() => this.#save(this._draft)}
          ></uui-button>
          ${this._message ? html`<span>${this._message}</span>` : nothing}
        </div>
      </uui-box>
    `
  }

  static styles = css`
    :host {
      display: block;
      padding: var(--uui-size-layout-1);
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: var(--uui-size-space-2);
      margin-bottom: var(--uui-size-layout-1);
    }
    .label {
      display: flex;
      align-items: center;
      gap: var(--uui-size-space-3);
    }
    .source {
      display: inline-flex;
      align-items: center;
      gap: var(--uui-size-space-2);
    }
    small {
      color: var(--uui-color-text-alt);
    }
    uui-textarea {
      --uui-textarea-min-height: 8em;
      font-family: monospace;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: var(--uui-size-space-4);
    }
  `
}

customElements.define('crombolo-seo-dashboard', CromboloSeoDashboardElement)
