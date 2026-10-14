/**
 * The Audit log dashboard in Settings: who did what, when and from where,
 * newest first, filtered by person, kind of change, words and dates.
 * docs/audit-log.md.
 */
import { css, html, LitElement, nothing } from '@umbraco-cms/backoffice/external/lit'

const PAGE_SIZE = 50

const CATEGORIES = [
  ['', 'Everything'],
  ['content', 'Content'],
  ['media', 'Media'],
  ['member', 'Members'],
  ['schema', 'Types and templates'],
  ['settings', 'Settings'],
  ['user', 'Users'],
  ['permission', 'Permissions'],
  ['sign-in', 'Sign-ins'],
  ['system', 'System'],
]

const ACTIONS = {
  Create: 'Created',
  CreateAndPublish: 'Created and published',
  Save: 'Saved',
  SaveAndPublish: 'Saved and published',
  Publish: 'Published',
  PublishWithDescendants: 'Published with everything below it',
  Unpublish: 'Unpublished',
  Delete: 'Deleted',
  Move: 'Moved',
  Trash: 'Moved to the recycle bin',
  Restore: 'Restored from the recycle bin',
  EmptyRecycleBin: 'Emptied the recycle bin',
  Copy: 'Copied',
  Sort: 'Sorted',
  Rename: 'Renamed',
  Rollback: 'Rolled back',
  Revert: 'Reverted',
  PreventCleanup: 'Kept a version',
  AssignDomains: 'Changed domains',
  SetPublicAccess: 'Restricted access',
  AddPublicAccess: 'Restricted access',
  RemovePublicAccess: 'Removed access restrictions',
  SetNotifications: 'Changed notifications',
  Import: 'Imported',
  CreateTemplate: 'Created a template',
  ChangePassword: 'Changed password',
  ResetPassword: 'Reset password',
  ResetPasswordByLink: 'Reset password from an e-mailed link',
  Invite: 'Invited',
  ResendInvite: 'Resent the invitation',
  AcceptInvite: 'Accepted the invitation',
  Disable: 'Disabled',
  Enable: 'Enabled',
  Unlock: 'Unlocked',
  SetUserGroups: 'Changed groups',
  AddUsers: 'Added people',
  RemoveUsers: 'Removed people',
  SaveProfile: 'Updated their profile',
  SetAvatar: 'Changed the picture',
  RemoveAvatar: 'Removed the picture',
  EnableTwoFactor: 'Turned on two-factor sign-in',
  DisableTwoFactor: 'Turned off two-factor sign-in',
  AddClientCredentials: 'Added an API key',
  RemoveClientCredentials: 'Removed an API key',
  SignIn: 'Signed in',
  SignInFailed: 'Failed to sign in',
  LockedOut: 'Locked out',
  SignOut: 'Signed out',
  Rebuild: 'Rebuilt',
  Reload: 'Reloaded',
  Build: 'Built',
  Install: 'Installed',
  Uninstall: 'Uninstalled',
  Commit: 'Sent to source control',
  Sync: 'Applied the schema files',
  Purge: 'Purged',
  Upgrade: 'Upgraded the site',
  UpgradeFix: 'Prepared an upgrade',
  PauseEditing: 'Paused editing',
  ResumeEditing: 'Resumed editing',
  RunMigration: 'Ran a package update',
}

const ITEM_TYPES = {
  Document: 'Page',
  DocumentBlueprint: 'Document blueprint',
  DocumentType: 'Document type',
  DictionaryItem: 'Dictionary item',
  MediaType: 'Media type',
  MemberType: 'Member type',
  MemberGroup: 'Member group',
  DataType: 'Data type',
  PartialView: 'Partial view',
  UserGroup: 'User group',
  SeoSettings: 'Search and sharing settings',
}

const WORKSPACE = {
  Document: (key) => `section/content/workspace/document/edit/${key}`,
  Media: (key) => `section/media/workspace/media/edit/${key}`,
  Member: (key) => `section/member-management/workspace/member/edit/${key}`,
  User: (key) => `section/user-management/workspace/user/edit/${key}`,
}

const words = (name) =>
  name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase())
const actionLabel = (action) => ACTIONS[action] ?? words(action)
const itemType = (type) => ITEM_TYPES[type] ?? words(type.replace(/Folder$/, ' folder'))

function apiBase() {
  const base = document.querySelector('base')?.getAttribute('href') ?? '/umbraco/'
  return `${base.replace(/\/$/, '')}/crombolo/api/audit`
}

async function get(path, params) {
  const query = params ? `?${new URLSearchParams(params)}` : ''
  const response = await fetch(`${apiBase()}${path}${query}`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`The audit log could not be read (${response.status}).`)
  return response.json()
}

function fromWhere(entry) {
  if (entry.source === 'cli') return 'Command line'
  if (entry.source === 'job') return 'Scheduled'
  const forwarded = entry.forwardedFor?.split(',')[0]?.trim()
  return forwarded || entry.ipAddress || '—'
}

export default class CromboloAuditDashboardElement extends LitElement {
  static properties = {
    _page: { state: true },
    _users: { state: true },
    _error: { state: true },
    _filter: { state: true },
    _skip: { state: true },
  }

  constructor() {
    super()
    this._page = undefined
    this._users = []
    this._error = undefined
    this._filter = { user: '', category: '', text: '', since: '', until: '' }
    this._skip = 0
  }

  connectedCallback() {
    super.connectedCallback()
    get('/users')
      .then((users) => {
        this._users = users.items
      })
      .catch(() => {})
    this.#load()
  }

  async #load() {
    const params = { skip: String(this._skip), take: String(PAGE_SIZE) }
    const { user, category, text, since, until } = this._filter
    if (user) params.user = user
    if (category) params.category = category
    if (text.trim()) params.text = text.trim()
    // Whole local days: "To" includes the day it names.
    if (since) params.since = new Date(`${since}T00:00:00`).toISOString()
    if (until)
      params.until = new Date(new Date(`${until}T00:00:00`).getTime() + 86_400_000).toISOString()
    try {
      this._page = await get('', params)
      this._error = undefined
    } catch (error) {
      this._error = error.message
    }
  }

  #set(field, value) {
    this._filter = { ...this._filter, [field]: value }
    this._skip = 0
    this.#load()
  }

  #go(skip) {
    this._skip = Math.max(0, skip)
    this.#load()
  }

  render() {
    return html`
      <uui-box headline="Audit log">
        <p class="intro">
          Every change made in the backoffice, every sign-in, and what the command line and
          scheduled publishing changed.
          ${
            this._page?.retentionDays
              ? html`Entries are kept for ${this._page.retentionDays} days.`
              : this._page
                ? html`Entries are kept until they are removed.`
                : nothing
          }
        </p>
        ${this.#renderFilters()}
        ${this.#renderBody()}
      </uui-box>
    `
  }

  #renderFilters() {
    const f = this._filter
    return html`
      <div class="filters">
        <label>
          Who
          <select .value=${f.user} @change=${(e) => this.#set('user', e.target.value)}>
            <option value="">Anyone</option>
            ${this._users.map((u) => html`<option value=${u.key}>${u.name || 'Unnamed'}</option>`)}
          </select>
        </label>
        <label>
          What
          <select .value=${f.category} @change=${(e) => this.#set('category', e.target.value)}>
            ${CATEGORIES.map(([value, label]) => html`<option value=${value}>${label}</option>`)}
          </select>
        </label>
        <label>
          Containing
          <uui-input
            label="Containing"
            placeholder="A name"
            .value=${f.text}
            @change=${(e) => this.#set('text', e.target.value)}
          ></uui-input>
        </label>
        <label>
          From
          <input type="date" .value=${f.since} @change=${(e) => this.#set('since', e.target.value)} />
        </label>
        <label>
          To
          <input type="date" .value=${f.until} @change=${(e) => this.#set('until', e.target.value)} />
        </label>
        <uui-button look="secondary" compact label="Refresh" @click=${() => this.#load()}>Refresh</uui-button>
      </div>
    `
  }

  #renderBody() {
    if (this._error) return html`<p class="error">${this._error}</p>`
    if (!this._page) return html`<uui-loader></uui-loader>`
    const { items, total } = this._page
    if (items.length === 0) return html`<p class="empty">Nothing matches.</p>`
    const last = Math.min(this._skip + items.length, total)
    return html`
      <uui-table>
        <uui-table-head>
          <uui-table-head-cell>When</uui-table-head-cell>
          <uui-table-head-cell>Who</uui-table-head-cell>
          <uui-table-head-cell>What</uui-table-head-cell>
          <uui-table-head-cell>Item</uui-table-head-cell>
          <uui-table-head-cell>From</uui-table-head-cell>
        </uui-table-head>
        ${items.map((entry) => this.#renderRow(entry))}
      </uui-table>
      <div class="pager">
        <span>${this._skip + 1}–${last} of ${total}</span>
        <uui-button
          compact
          look="secondary"
          label="Newer"
          ?disabled=${this._skip === 0}
          @click=${() => this.#go(this._skip - PAGE_SIZE)}
        >Newer</uui-button>
        <uui-button
          compact
          look="secondary"
          label="Older"
          ?disabled=${last >= total}
          @click=${() => this.#go(this._skip + PAGE_SIZE)}
        >Older</uui-button>
      </div>
    `
  }

  #renderRow(entry) {
    const when = new Date(entry.occurredAt)
    const failed = entry.action === 'SignInFailed' || entry.action === 'LockedOut'
    return html`<uui-table-row>
      <uui-table-cell title=${when.toISOString()}>${when.toLocaleString()}</uui-table-cell>
      <uui-table-cell>${entry.user?.name ?? (entry.source === 'job' ? 'Scheduled publishing' : 'Unknown')}</uui-table-cell>
      <uui-table-cell>
        ${failed ? html`<uui-tag color="danger">${actionLabel(entry.action)}</uui-tag>` : actionLabel(entry.action)}
        ${entry.detail && entry.source !== 'cli' ? html`<small>${entry.detail}</small>` : nothing}
      </uui-table-cell>
      <uui-table-cell>${this.#renderItem(entry)}</uui-table-cell>
      <uui-table-cell title=${entry.forwardedFor ? `Connected from ${entry.ipAddress ?? 'unknown'}` : ''}>
        ${fromWhere(entry)}
      </uui-table-cell>
    </uui-table-row>`
  }

  #renderItem(entry) {
    const item = entry.item
    if (!item) return nothing
    const label = item.name ?? item.key ?? ''
    const link = item.key && WORKSPACE[item.type]?.(item.key)
    const base = document.querySelector('base')?.getAttribute('href') ?? '/umbraco/'
    return html`
      <small>${itemType(item.type)}</small>
      ${link ? html`<a href=${`${base.replace(/\/$/, '')}/${link}`}>${label}</a>` : label}
    `
  }

  static styles = css`
    :host {
      display: block;
      padding: var(--uui-size-layout-1);
    }
    .intro {
      margin-top: 0;
      color: var(--uui-color-text-alt);
    }
    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: var(--uui-size-space-4);
      align-items: flex-end;
      margin-bottom: var(--uui-size-space-5);
    }
    .filters label {
      display: flex;
      flex-direction: column;
      gap: var(--uui-size-space-1);
      font-weight: 600;
    }
    select,
    input[type='date'] {
      font: inherit;
      padding: var(--uui-size-space-2);
      border: 1px solid var(--uui-color-border);
      border-radius: var(--uui-border-radius);
      background: var(--uui-color-surface);
      color: var(--uui-color-text);
    }
    uui-table-cell small {
      display: block;
      color: var(--uui-color-text-alt);
    }
    .pager {
      display: flex;
      gap: var(--uui-size-space-3);
      align-items: center;
      justify-content: flex-end;
      margin-top: var(--uui-size-space-4);
    }
    .empty,
    .error {
      color: var(--uui-color-text-alt);
    }
    .error {
      color: var(--uui-color-danger);
    }
  `
}

customElements.define('crombolo-audit-dashboard', CromboloAuditDashboardElement)
