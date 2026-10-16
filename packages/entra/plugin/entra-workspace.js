/**
 * The Microsoft Entra screen, in Settings under Advanced (story 033).
 *
 * One card per Entra sign-in the site declares in code: for the backoffice, for
 * members, or both. Each field shows what is in force and says when it was
 * changed here rather than in code; saving changes only what differs, and
 * "Use the code's settings" removes every change. The client secret is never
 * shown: it can be replaced or removed, and the card says whether there is one.
 */
import '@umbraco-cms/backoffice/components'
import { css, html, nothing, repeat } from '@umbraco-cms/backoffice/external/lit'
import { UmbLitElement } from '@umbraco-cms/backoffice/lit-element'
import { UMB_NOTIFICATION_CONTEXT } from '@umbraco-cms/backoffice/notification'
import {
  listGroups,
  listProviders,
  resetProvider,
  saveProvider,
  testProvider,
} from './entra-client.js'

const AUDIENCE = { user: 'Backoffice users', member: 'Members' }

/** What a card edits, from a provider as the server describes it. */
const draftOf = (provider) => ({
  name: provider.name,
  tenantId: provider.tenantId ?? '',
  clientId: provider.clientId,
  clientSecret: '',
  autoCreate: provider.autoCreate,
  linkByEmail: provider.linkByEmail,
  emailsVerified: provider.emailsVerified,
  mappings: Object.entries(provider.groupMap).map(([claim, group]) => ({ claim, group })),
  defaultGroups: [...provider.defaultGroups],
})

export default class CromboloEntraWorkspaceElement extends UmbLitElement {
  static properties = {
    _providers: { state: true },
    _drafts: { state: true },
    _groups: { state: true },
    _canEdit: { state: true },
    _loading: { state: true },
    _problem: { state: true },
    _results: { state: true },
    _busy: { state: true },
  }

  #notifications

  constructor() {
    super()
    this._providers = []
    this._drafts = {}
    this._groups = { user: [], member: [] }
    this._canEdit = false
    this._loading = true
    this._problem = ''
    this._results = {}
    this._busy = ''
    this.consumeContext(UMB_NOTIFICATION_CONTEXT, (context) => {
      this.#notifications = context
    })
  }

  connectedCallback() {
    super.connectedCallback()
    this.#load()
  }

  async #load() {
    this._loading = true
    try {
      const result = await listProviders()
      this._providers = result.providers ?? []
      this._canEdit = Boolean(result.canEdit)
      this._drafts = Object.fromEntries(this._providers.map((p) => [this.#key(p), draftOf(p)]))
      const audiences = [...new Set(this._providers.map((p) => p.audience))]
      const groups = { user: [], member: [] }
      for (const audience of audiences) groups[audience] = (await listGroups(audience)).groups ?? []
      this._groups = groups
      this._problem = ''
    } catch (error) {
      this._problem = error instanceof Error ? error.message : String(error)
    } finally {
      this._loading = false
    }
  }

  #key(provider) {
    return `${provider.audience}:${provider.id}`
  }

  #change(provider, field, value) {
    const key = this.#key(provider)
    this._drafts = { ...this._drafts, [key]: { ...this._drafts[key], [field]: value } }
  }

  #setMapping(provider, index, field, value) {
    const draft = this._drafts[this.#key(provider)]
    const mappings = draft.mappings.map((m, i) => (i === index ? { ...m, [field]: value } : m))
    this.#change(provider, 'mappings', mappings)
  }

  /** Only what differs from what is in force goes to the server. */
  #changes(provider) {
    const draft = this._drafts[this.#key(provider)]
    const changes = {}
    for (const field of [
      'name',
      'tenantId',
      'clientId',
      'autoCreate',
      'linkByEmail',
      'emailsVerified',
    ])
      if (draft[field] !== (provider[field] ?? '')) changes[field] = draft[field]
    if (draft.clientSecret) changes.clientSecret = draft.clientSecret
    const map = Object.fromEntries(
      draft.mappings.filter((m) => m.claim.trim() && m.group).map((m) => [m.claim.trim(), m.group]),
    )
    if (JSON.stringify(map) !== JSON.stringify(provider.groupMap)) changes.groupMap = map
    if (JSON.stringify(draft.defaultGroups) !== JSON.stringify(provider.defaultGroups))
      changes.defaultGroups = draft.defaultGroups
    return changes
  }

  async #run(provider, label, action) {
    this._busy = this.#key(provider)
    try {
      const result = await action()
      if (result.ok === false) {
        this.#notifications?.peek('danger', { data: { message: result.message } })
        return
      }
      this.#notifications?.peek('positive', { data: { message: label } })
      await this.#load()
    } catch (error) {
      this.#notifications?.peek('danger', {
        data: { message: error instanceof Error ? error.message : String(error) },
      })
    } finally {
      this._busy = ''
    }
  }

  #save(provider) {
    const changes = this.#changes(provider)
    if (Object.keys(changes).length === 0) return
    return this.#run(provider, 'Entra settings saved', () => saveProvider(provider, changes))
  }

  #removeSecret(provider) {
    return this.#run(provider, 'Client secret removed', () =>
      saveProvider(provider, { clientSecret: null }),
    )
  }

  #reset(provider) {
    return this.#run(provider, "Using the code's settings again", () => resetProvider(provider))
  }

  async #test(provider) {
    this._busy = this.#key(provider)
    try {
      const result = await testProvider(provider)
      this._results = { ...this._results, [this.#key(provider)]: result }
    } finally {
      this._busy = ''
    }
  }

  render() {
    return html`<umb-body-layout headline="Microsoft Entra">
      ${this._problem ? html`<uui-box><p class="problem">${this._problem}</p></uui-box>` : nothing}
      ${this._loading ? html`<uui-loader></uui-loader>` : this.#body()}
    </umb-body-layout>`
  }

  #body() {
    if (this._providers.length === 0)
      return html`<uui-box headline="No Entra sign-in">
        <p>
          This site declares no Microsoft Entra sign-in. Add one with <code>entra()</code> in
          <code>crombolo.config.ts</code>, under <code>backofficeIdentityProviders</code> or
          <code>memberIdentityProviders</code>; its settings can then be changed here.
        </p>
      </uui-box>`
    return html`
      ${
        this._canEdit
          ? nothing
          : html`<uui-box><p>Only an administrator can change how people sign in.</p></uui-box>`
      }
      ${repeat(
        this._providers,
        (p) => this.#key(p),
        (p) => this.#card(p),
      )}
    `
  }

  #label(provider, field, text) {
    return html`${text}${
      provider.overridden.includes(field)
        ? html` <uui-tag look="secondary" color="warning">Changed here</uui-tag>`
        : nothing
    }`
  }

  #card(provider) {
    const draft = this._drafts[this.#key(provider)]
    const groups = this._groups[provider.audience] ?? []
    const disabled = !this._canEdit
    const result = this._results[this.#key(provider)]
    const busy = this._busy === this.#key(provider)
    return html`<uui-box headline=${`${AUDIENCE[provider.audience]} — ${provider.name}`}>
      <div slot="header-actions" class="actions">
        <uui-button look="secondary" label="Test connection" ?disabled=${busy}
          @click=${() => this.#test(provider)}>Test connection</uui-button>
        ${
          this._canEdit && provider.overridden.length > 0
            ? html`<uui-button look="secondary" color="danger" label="Use the code's settings"
                ?disabled=${busy} @click=${() => this.#reset(provider)}>Use the code's settings</uui-button>`
            : nothing
        }
      </div>
      ${result ? html`<p class=${result.ok ? 'ok' : 'problem'}>${result.message}</p>` : nothing}
      <umb-property-layout label="Redirect URL" description="Register this with the app in Entra">
        <code slot="editor">${window.location.origin}${provider.callbackPath}</code>
      </umb-property-layout>
      <umb-property-layout .label=${this.#label(provider, 'name', 'Button text')}>
        <uui-input slot="editor" label="Button text" ?readonly=${disabled} .value=${draft.name}
          @change=${(e) => this.#change(provider, 'name', e.target.value)}></uui-input>
      </umb-property-layout>
      <umb-property-layout .label=${this.#label(provider, 'tenantId', 'Tenant ID')}>
        <uui-input slot="editor" label="Tenant ID" ?readonly=${disabled} .value=${draft.tenantId}
          @change=${(e) => this.#change(provider, 'tenantId', e.target.value)}></uui-input>
      </umb-property-layout>
      <umb-property-layout .label=${this.#label(provider, 'clientId', 'Application (client) ID')}>
        <uui-input slot="editor" label="Client ID" ?readonly=${disabled} .value=${draft.clientId}
          @change=${(e) => this.#change(provider, 'clientId', e.target.value)}></uui-input>
      </umb-property-layout>
      <umb-property-layout .label=${this.#label(provider, 'clientSecret', 'Client secret')}
        description=${provider.hasClientSecret ? 'A secret is set. Enter a new one to replace it.' : 'No secret is set.'}>
        <div slot="editor" class="row">
          <uui-input type="password" label="Client secret" autocomplete="off" ?readonly=${disabled}
            .value=${draft.clientSecret} placeholder=${provider.hasClientSecret ? '••••••••' : ''}
            @change=${(e) => this.#change(provider, 'clientSecret', e.target.value)}></uui-input>
          ${
            this._canEdit && provider.overridden.includes('clientSecret')
              ? html`<uui-button look="secondary" label="Remove the secret kept here"
                  @click=${() => this.#removeSecret(provider)}>Remove</uui-button>`
              : nothing
          }
        </div>
      </umb-property-layout>
      <umb-property-layout .label=${this.#label(provider, 'autoCreate', 'Create accounts')}
        description="Create an account for someone signing in for the first time">
        <uui-toggle slot="editor" label="Create accounts" ?disabled=${disabled} ?checked=${draft.autoCreate}
          @change=${(e) => this.#change(provider, 'autoCreate', e.target.checked)}></uui-toggle>
      </umb-property-layout>
      <umb-property-layout .label=${this.#label(provider, 'linkByEmail', 'Link by email')}
        description="Link a first sign-in to an existing account with the same, verified, email">
        <uui-toggle slot="editor" label="Link by email" ?disabled=${disabled} ?checked=${draft.linkByEmail}
          @change=${(e) => this.#change(provider, 'linkByEmail', e.target.checked)}></uui-toggle>
      </umb-property-layout>
      <umb-property-layout .label=${this.#label(provider, 'emailsVerified', 'Trust emails')}
        description="Treat every email from this tenant as verified. Entra sends no verification claim.">
        <uui-toggle slot="editor" label="Trust emails" ?disabled=${disabled} ?checked=${draft.emailsVerified}
          @change=${(e) => this.#change(provider, 'emailsVerified', e.target.checked)}></uui-toggle>
      </umb-property-layout>
      <umb-property-layout .label=${this.#label(provider, 'groupMap', 'Group mappings')}
        description="An Entra group's object ID, and the group here its members join. Made to match on every sign-in.">
        <div slot="editor" class="mappings">
          ${draft.mappings.map(
            (m, i) => html`<div class="row">
              <uui-input label="Entra group object ID" placeholder="Entra group object ID" ?readonly=${disabled}
                .value=${m.claim} @change=${(e) => this.#setMapping(provider, i, 'claim', e.target.value)}></uui-input>
              <uui-select label="Group here" ?disabled=${disabled}
                .options=${[{ name: 'Choose a group', value: '', selected: !m.group }, ...groups.map((g) => ({ name: g.name, value: g.value, selected: g.value === m.group }))]}
                @change=${(e) => this.#setMapping(provider, i, 'group', e.target.value)}></uui-select>
              ${
                disabled
                  ? nothing
                  : html`<uui-button look="secondary" label="Remove mapping" compact
                      @click=${() =>
                        this.#change(
                          provider,
                          'mappings',
                          draft.mappings.filter((_, j) => j !== i),
                        )}>Remove</uui-button>`
              }
            </div>`,
          )}
          ${
            disabled
              ? nothing
              : html`<uui-button look="secondary" label="Add a mapping" compact
                  @click=${() => this.#change(provider, 'mappings', [...draft.mappings, { claim: '', group: '' }])}>Add a mapping</uui-button>`
          }
        </div>
      </umb-property-layout>
      <umb-property-layout .label=${this.#label(provider, 'defaultGroups', 'Default groups')}
        description="Groups a new account joins">
        <div slot="editor" class="checks">
          ${groups.map(
            (g) => html`<uui-checkbox label=${g.name} ?disabled=${disabled}
              ?checked=${draft.defaultGroups.includes(g.value)}
              @change=${(e) =>
                this.#change(
                  provider,
                  'defaultGroups',
                  e.target.checked
                    ? [...draft.defaultGroups, g.value]
                    : draft.defaultGroups.filter((v) => v !== g.value),
                )}>${g.name}</uui-checkbox>`,
          )}
        </div>
      </umb-property-layout>
      ${
        this._canEdit
          ? html`<div class="save">
              <uui-button look="primary" color="positive" label="Save" ?disabled=${busy || Object.keys(this.#changes(provider)).length === 0}
                @click=${() => this.#save(provider)}>Save</uui-button>
            </div>`
          : nothing
      }
    </uui-box>`
  }

  static styles = css`
    :host { display: block; height: 100%; }
    uui-box { margin-bottom: var(--uui-size-layout-1); }
    .actions { display: flex; gap: var(--uui-size-space-3); }
    .row { display: flex; gap: var(--uui-size-space-3); align-items: center; }
    .row uui-input { flex: 1; }
    .mappings, .checks { display: flex; flex-direction: column; gap: var(--uui-size-space-3); }
    uui-input, uui-select { width: 100%; }
    .save { display: flex; justify-content: flex-end; margin-top: var(--uui-size-space-5); }
    .ok { color: var(--uui-color-positive); }
    .problem { color: var(--uui-color-danger); }
    code { word-break: break-all; }
  `
}

customElements.define('crombolo-entra-workspace', CromboloEntraWorkspaceElement)
