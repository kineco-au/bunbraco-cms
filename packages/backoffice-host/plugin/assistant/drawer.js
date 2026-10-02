/**
 * The assistant's review surface: a near-fullscreen workspace with the proposals
 * on the left and the selected one open on the right, editable.
 *
 * It is laid out like an editor because that is the job. A proposal is a change
 * to code or to content, approving it is the only thing that reaches the CMS, and
 * a one-line summary is not enough to approve on. So: pick a change, read it,
 * change it if it is nearly right, then approve it.
 *
 * What the right pane shows follows what the change actually is, rather than one
 * shape for everything: a template is TSX in a code editor, a page is its property
 * values as markup, a type is the prepared request as JSON.
 *
 * Registered as a `headerApp`, whose manifest the server omits entirely when the
 * assistant is not configured.
 */
import { css, html, LitElement, nothing } from '@umbraco-cms/backoffice/external/lit'
import { approve, ask, change, changesets, diff, discard, edit, status } from './client.js'

/**
 * The language each kind of change is edited in. `tsx` is bunbraco's own, added
 * to the code editor by the `tsx-editors` entry point; plain `typescript` would
 * read a view's markup as a stream of syntax errors.
 */
const LANGUAGE = {
  template: 'tsx',
  'template-create': 'tsx',
}

const KIND_LABEL = {
  document: 'Page',
  'document-create': 'New page',
  'document-type': 'Document type',
  'document-type-create': 'New document type',
  'data-type': 'Data type',
  'data-type-create': 'New data type',
  template: 'Template',
  'template-create': 'New template',
}

export default class BunbracoAssistantDrawerElement extends LitElement {
  static properties = {
    _open: { state: true },
    _busy: { state: true },
    _turns: { state: true },
    _changes: { state: true },
    _selected: { state: true },
    _detail: { state: true },
    _review: { state: true },
    _dirty: { state: true },
    _status: { state: true },
    _error: { state: true },
    _split: { state: true },
  }

  constructor() {
    super()
    this._open = false
    this._busy = false
    this._turns = []
    this._changes = []
    this._selected = undefined
    this._detail = undefined
    this._review = undefined
    this._dirty = false
    this._status = undefined
    this._error = undefined
    // Percentage width of the left pane; dragged by the splitter.
    this._split = 32
    this._changesetKey = undefined
    this._history = []
    this._pending = undefined
    this._pendingText = undefined
  }

  /**
   * A field rather than a method: the window listener needs a stable bound
   * reference to add and remove, and a private method cannot be reassigned.
   */
  #onKey = (event) => {
    if (event.key === 'Escape' && this._open) this.#toggle()
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    window.removeEventListener('keydown', this.#onKey)
  }

  async #toggle() {
    this._open = !this._open
    if (this._open) {
      window.addEventListener('keydown', this.#onKey)
      await Promise.all([this.#refresh(), this.#readStatus()])
    } else {
      window.removeEventListener('keydown', this.#onKey)
    }
  }

  /**
   * Read on opening, so a signed-out AWS session is visible before anything is
   * typed rather than as a failed message afterwards.
   */
  async #readStatus(refresh = false) {
    try {
      this._status = await status(refresh)
    } catch (error) {
      this._status = { ok: false, detail: error.message }
    }
  }

  /**
   * Does not clear `_error`: a refused approval reports through it and then calls
   * this, so clearing here would wipe the message before it was read.
   *
   * Anything still awaiting review is listed however old it is, proposals raised
   * over MCP in another process included. Settled items are shown only for this
   * conversation, so the list does not grow for ever.
   */
  async #refresh() {
    try {
      const sets = await changesets()
      this._changes = sets
        .flatMap((set) =>
          set.changes.map((item) => ({ ...item, origin: set.origin, changeset: set.key })),
        )
        .filter((item) => item.status === 'proposed' || item.changeset === this._changesetKey)
      if (this._selected && !this._changes.some((item) => item.key === this._selected)) {
        await this.#select(undefined)
      }
    } catch (error) {
      this._error = error.message
    }
  }

  async #select(key) {
    this._selected = key
    this._detail = undefined
    this._review = undefined
    this._dirty = false
    this._pending = undefined
    this._pendingText = undefined
    if (!key) return
    try {
      const [detail, review] = await Promise.all([change(key), diff(key).catch(() => undefined)])
      this._detail = detail
      this._review = review
    } catch (error) {
      this._error = error.message
    }
  }

  async #submit(event) {
    event.preventDefault()
    const input = this.renderRoot.querySelector('textarea.prompt')
    const message = input?.value?.trim()
    if (!message || this._busy) return
    input.value = ''
    this._turns = [...this._turns, { role: 'user', text: message }]
    this._busy = true
    this._error = undefined
    try {
      const answer = await ask(message, {
        changesetKey: this._changesetKey,
        history: this._history,
        viewing: this.#viewing(),
      })
      this._changesetKey = answer.changesetKey
      this._history = answer.history ?? []
      this._turns = [...this._turns, { role: 'assistant', text: answer.text }]
      await this.#refresh()
      // Open the first thing it proposed, so the work is in front of you.
      const first = this._changes.find((item) => item.status === 'proposed')
      if (first && !this._selected) await this.#select(first.key)
    } catch (error) {
      this._error = error.message
    } finally {
      this._busy = false
    }
  }

  /** A hint for the model about where the user is, taken from the address bar. */
  #viewing() {
    const match = /\/section\/([^/]+)/.exec(window.location.pathname)
    return match ? `the ${match[1]} section (${window.location.pathname})` : undefined
  }

  async #settle(item, action) {
    this._busy = true
    this._error = undefined
    try {
      await (action === 'approve' ? approve(item.key) : discard(item.key))
    } catch (error) {
      this._error = error.message
    } finally {
      this._busy = false
      await this.#refresh()
      if (this._selected === item.key) await this.#select(item.key)
    }
  }

  /** Saves the edited body back to the proposal, and re-reads what it now says. */
  async #save(body) {
    if (body === undefined) return
    this._busy = true
    this._error = undefined
    try {
      await edit(this._selected, body)
      this._dirty = false
      await this.#refresh()
      await this.#select(this._selected)
    } catch (error) {
      this._error = error.message
    } finally {
      this._busy = false
    }
  }

  #startDrag(event) {
    event.preventDefault()
    const panel = this.renderRoot.querySelector('.panes')
    if (!panel) return
    const move = (moved) => {
      const bounds = panel.getBoundingClientRect()
      const percent = ((moved.clientX - bounds.left) / bounds.width) * 100
      // Neither pane is allowed to collapse to nothing.
      this._split = Math.min(60, Math.max(18, percent))
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  render() {
    return html`
      <uui-button
        class="launcher"
        look="primary"
        compact
        label="Assistant"
        title="Ask the assistant to draft content and schema changes for you to approve"
        @click=${() => this.#toggle()}
      >
        <umb-icon name="icon-wand"></umb-icon>
      </uui-button>
      ${this._open ? this.#renderWorkspace() : nothing}
    `
  }

  #renderWorkspace() {
    const awaiting = this._changes.filter((item) => item.status === 'proposed')
    return html`
      <div class="scrim" @click=${() => this.#toggle()}></div>
      <section class="workspace" role="dialog" aria-label="Assistant">
        <header>
          <strong>Assistant</strong>
          <span class="overview">${this.#overview(awaiting)}</span>
          <uui-button compact look="default" label="Close" @click=${() => this.#toggle()}>
            <umb-icon name="icon-delete"></umb-icon>
          </uui-button>
        </header>

        ${this.#renderStatus()}
        ${this._error ? html`<p class="error bar">${this._error}</p>` : nothing}

        <div class="panes">
          <div class="left" style="width: ${this._split}%">${this.#renderList(awaiting)}</div>
          <div
            class="splitter"
            role="separator"
            aria-orientation="vertical"
            @pointerdown=${(event) => this.#startDrag(event)}
          ></div>
          <div class="right">${this.#renderDetail()}</div>
        </div>
      </section>
    `
  }

  /**
   * The explanatory text: what the assistant said it was doing, and what is
   * actually waiting. The prose is the useful half; the count keeps it honest.
   */
  #overview(awaiting) {
    const said = [...this._turns].reverse().find((turn) => turn.role === 'assistant')?.text
    if (awaiting.length === 0) {
      return said ?? 'Nothing is waiting for you. Ask for a change and it will appear here.'
    }
    const kinds = new Map()
    for (const item of awaiting) {
      const label = KIND_LABEL[item.kind] ?? item.kind
      kinds.set(label, (kinds.get(label) ?? 0) + 1)
    }
    const parts = [...kinds].map(([label, count]) => `${count} ${label.toLowerCase()}`)
    const counted = `${awaiting.length} proposal${awaiting.length === 1 ? '' : 's'} waiting — ${parts.join(', ')}. Nothing has changed yet.`
    return said ? `${said} · ${counted}` : counted
  }

  #renderList(awaiting) {
    return html`
      <div class="list">
        ${
          this._changes.length === 0
            ? html`<p class="hint">
                Proposals appear here. Approving one is the only thing that changes the CMS.
              </p>`
            : html`<ul>
                ${this._changes.map((item) => this.#renderListItem(item))}
              </ul>`
        }
        ${awaiting.length > 1 ? html`<p class="hint">Each is approved on its own.</p>` : nothing}
      </div>

      <div class="conversation">
        ${this._turns.map((turn) => html`<div class="turn ${turn.role}">${turn.text}</div>`)}
        ${this._busy ? html`<div class="turn assistant">Thinking…</div>` : nothing}
      </div>

      <form @submit=${(event) => this.#submit(event)}>
        <textarea
          class="prompt"
          rows="4"
          placeholder="Draft a landing page about…"
          @keydown=${(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) this.#submit(event)
          }}
        ></textarea>
        <uui-button type="submit" look="primary" label="Send" .disabled=${this._busy}></uui-button>
      </form>
    `
  }

  #renderListItem(item) {
    const blocked = item.problems?.length > 0
    return html`<li>
      <button
        class="entry ${item.key === this._selected ? 'selected' : ''} ${item.status}"
        @click=${() => this.#select(item.key)}
      >
        <span class="kind">${KIND_LABEL[item.kind] ?? item.kind}</span>
        <span class="summary">${item.summary}</span>
        <span class="tags">
          ${
            item.status !== 'proposed'
              ? html`<uui-tag look="secondary">${item.status}</uui-tag>`
              : nothing
          }
          ${item.origin === 'mcp' ? html`<uui-tag look="secondary">MCP</uui-tag>` : nothing}
          ${blocked ? html`<uui-tag color="danger" look="secondary">blocked</uui-tag>` : nothing}
        </span>
      </button>
    </li>`
  }

  #renderDetail() {
    if (!this._selected) {
      return html`<div class="empty">
        <p>Select a proposal to read it, change it, or approve it.</p>
      </div>`
    }
    if (!this._detail) return html`<div class="empty"><p>Loading…</p></div>`

    const item = this._detail
    const settled = item.status !== 'proposed'
    const blocked = item.problems?.length > 0
    return html`
      <div class="detail">
        <div class="detail-head">
          <div>
            <strong>${item.summary}</strong>
            <p class="effect">${item.effect}</p>
          </div>
          <div class="actions">
            ${
              settled
                ? html`<uui-tag look="secondary">${item.status}</uui-tag>`
                : html`
                    <uui-button
                      look="primary"
                      color="positive"
                      label="Approve"
                      .disabled=${this._busy || blocked || this._dirty}
                      @click=${() => this.#settle(item, 'approve')}
                    ></uui-button>
                    <uui-button
                      look="secondary"
                      label="Discard"
                      .disabled=${this._busy}
                      @click=${() => this.#settle(item, 'discard')}
                    ></uui-button>
                  `
            }
          </div>
        </div>

        ${
          blocked
            ? html`<ul class="problems">
                ${item.problems.map((problem) => html`<li>${problem.message}</li>`)}
              </ul>`
            : nothing
        }
        ${
          this._review?.stale
            ? html`<p class="error bar">
                This changed after it was proposed. Ask for it again rather than approving it.
              </p>`
            : nothing
        }
        ${this._dirty ? html`<p class="hint bar">Edited — save before approving.</p>` : nothing}

        ${this.#renderDescription()}
        ${this.#renderEditor(item)}
      </div>
    `
  }

  /**
   * What the proposal does, in words. The parts a person cannot edit — which type
   * a page is, which parent it sits under — are still theirs to review, and the
   * prepared request was never a readable way to show them.
   */
  #renderDescription() {
    const lines = this._review?.lines
    if (!lines?.length) return nothing
    return html`<div class="described">
      <ul>
        ${lines.map((line) => html`<li>${line}</li>`)}
      </ul>
      ${
        this._review?.editable
          ? html`<p class="hint">You can change ${this._review.editable}; the rest is fixed.</p>`
          : html`<p class="hint">Nothing here is editable \u2014 approve it or discard it.</p>`
      }
    </div>`
  }

  #renderEditor(item) {
    // Settled: the description above already says what it did, and the prepared
    // request is not something to read. Templates and files are still worth
    // showing, because the text is the change.
    if (item.status !== 'proposed') {
      if (item.kind.startsWith('template')) {
        return html`<pre class="readonly">${item.body?.content ?? ''}</pre>`
      }
      if (typeof item.body?.toml === 'string') {
        return html`<pre class="readonly">${item.body.toml}</pre>`
      }
      return nothing
    }
    if (item.kind.startsWith('template')) return this.#renderTemplateEditor(item)
    if (item.kind.startsWith('document-type') || item.kind.startsWith('data-type')) {
      return this.#renderTomlEditor(item)
    }
    return this.#renderValuesEditor(item)
  }

  /** A template is TSX, so it gets a code editor and the file's own language. */
  #renderTemplateEditor(item) {
    const source = typeof item.body?.content === 'string' ? item.body.content : ''
    return html`
      <div class="editor">
        <umb-code-editor
          language=${LANGUAGE[item.kind] ?? 'tsx'}
          .code=${source}
          @input=${(event) => {
            // Only the field this kind is edited through; the server refuses the rest.
            this._pending = { content: event.target.code ?? event.target.value }
            this._dirty = true
          }}
        ></umb-code-editor>
      </div>
      ${this.#renderSave(() => this._pending)}
    `
  }

  /** A page is its property values; each one is markup, so each gets an editor. */
  #renderValuesEditor(item) {
    const values = Array.isArray(item.body?.values) ? item.body.values : []
    if (values.length === 0) {
      return html`<p class="hint pad">This proposal sets no property values.</p>`
    }
    return html`
      <div class="values">
        ${values.map(
          (value, index) => html`<label class="value">
            <span>
              ${value.alias}${value.culture ? html` <small>${value.culture}</small>` : nothing}
            </span>
            <textarea
              rows="6"
              .value=${
                typeof value.value === 'string' ? value.value : JSON.stringify(value.value ?? '')
              }
              @input=${(event) => this.#editValue(item, index, event.target.value)}
            ></textarea>
          </label>`,
        )}
      </div>
      ${this.#renderSave(() => this._pending)}
    `
  }

  #editValue(item, index, next) {
    const values = (this._pending?.values ?? item.body.values).map((value, at) =>
      at === index ? { ...value, value: next } : value,
    )
    this._pending = { values }
    this._dirty = true
  }

  /**
   * A type is a TOML file, and that file is what gets committed — so the file is
   * what is shown and edited, aliases and all, rather than a request body of keys.
   *
   * `ini` rather than a TOML mode: Umbraco's editor has no TOML language, and
   * ini's highlighting of `[table]` headers and `key = value` is right for it.
   */
  #renderTomlEditor(item) {
    // A proposal raised before types were files has a request body and no TOML.
    // Showing it as an empty editor would invite someone to approve nothing, so it
    // is shown as what it is and says to ask again.
    if (typeof item.body?.toml !== 'string') {
      return html`
        <p class="hint pad">
          This was proposed before types were files, so there is no file to show or edit.
          Discard it and ask again.
        </p>
      `
    }
    const toml = item.body.toml
    return html`
      <p class="hint pad">${item.body?.file ?? 'schema file'}</p>
      <div class="editor">
        <umb-code-editor
          language="ini"
          .code=${toml}
          @input=${(event) => {
            this._pending = { toml: event.target.code ?? event.target.value }
            this._dirty = true
          }}
        ></umb-code-editor>
      </div>
      ${this.#renderSave(() => this._pending)}
    `
  }

  #renderSave(collect) {
    return html`<div class="save">
      <uui-button
        look="secondary"
        label="Save changes"
        .disabled=${this._busy || !this._dirty}
        @click=${() => this.#save(collect())}
      ></uui-button>
      <span class="hint">Saving re-checks it. Approving is still separate.</span>
    </div>`
  }

  /** Only says anything when something is wrong, or when a session is running out. */
  #renderStatus() {
    const state = this._status
    if (!state || (state.ok && !state.expires)) return nothing
    if (state.ok) {
      return html`<p class="hint bar">
        ${state.detail}. Session expires ${new Date(state.expires).toLocaleTimeString()}.
      </p>`
    }
    return html`<div class="unavailable bar">
      <strong>The assistant cannot reach its model.</strong>
      <p>${state.detail}</p>
      ${state.remedy ? html`<p class="remedy">${state.remedy}</p>` : nothing}
      ${
        // Asking again is a real call to the model, so the server allows it only
        // to whoever could act on the answer. No button for anyone else: one that
        // quietly changes nothing is worse than none.
        state.canRefresh === false
          ? nothing
          : html`<uui-button
              look="secondary"
              label="Re-check"
              .disabled=${this._busy}
              @click=${() => this.#readStatus(true)}
            ></uui-button>`
      }
    </div>`
  }

  static styles = css`
    :host {
      display: flex;
      align-items: center;
    }
    /**
     * As Umbraco's own header apps are built (UmbHeaderAppButtonElement): an
     * \`umb-icon\`, because that is what resolves a registry icon name — \`uui-icon\`
     * renders an empty box for one — and \`look="primary"\` with the background
     * overridden, which is what gives contrast against the dark header.
     */
    .launcher {
      font-size: 18px;
      --uui-button-background-color: transparent;
      --uui-button-background-color-hover: var(--uui-color-emphasis);
    }
    .scrim {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
      z-index: 9998;
    }
    .workspace {
      position: fixed;
      inset: 4vh 3vw;
      display: flex;
      flex-direction: column;
      background: var(--uui-color-surface, #fff);
      border-radius: var(--uui-border-radius, 3px);
      box-shadow: var(--uui-shadow-depth-5, 0 20px 60px rgba(0, 0, 0, 0.35));
      z-index: 9999;
      overflow: hidden;
    }
    header {
      display: flex;
      align-items: center;
      gap: var(--uui-size-space-4, 12px);
      padding: var(--uui-size-space-3, 9px) var(--uui-size-space-4, 12px);
      border-bottom: 1px solid var(--uui-color-border, #d8d7d9);
    }
    header .overview {
      flex: 1;
      font-size: var(--uui-type-small-size, 12px);
      color: var(--uui-color-text-alt, #515054);
    }
    .bar {
      margin: 0;
      padding: var(--uui-size-space-2, 6px) var(--uui-size-space-4, 12px);
      font-size: var(--uui-type-small-size, 12px);
      border-bottom: 1px solid var(--uui-color-border, #d8d7d9);
    }
    .pad {
      padding: var(--uui-size-space-4, 12px);
    }
    .panes {
      flex: 1;
      display: flex;
      min-height: 0;
    }
    .left {
      display: flex;
      flex-direction: column;
      min-width: 0;
      border-right: 1px solid var(--uui-color-border, #d8d7d9);
    }
    .splitter {
      width: 6px;
      cursor: col-resize;
      background: var(--uui-color-divider, #f3f3f5);
      flex: none;
    }
    .splitter:hover {
      background: var(--uui-color-emphasis, #d8d7d9);
    }
    .right {
      flex: 1;
      min-width: 0;
      display: flex;
      overflow: auto;
    }
    .list {
      flex: 1;
      overflow: auto;
      padding: var(--uui-size-space-3, 9px);
      min-height: 0;
    }
    .list ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--uui-size-space-2, 6px);
    }
    .entry {
      width: 100%;
      text-align: left;
      font: inherit;
      cursor: pointer;
      background: none;
      padding: var(--uui-size-space-3, 9px);
      border: 1px solid var(--uui-color-border, #d8d7d9);
      border-radius: var(--uui-border-radius, 3px);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .entry:hover {
      border-color: var(--uui-color-emphasis, #a1a1a1);
    }
    .entry.selected {
      border-color: var(--uui-color-selected, #3544b1);
      background: var(--uui-color-surface-alt, #f3f3f5);
    }
    .entry.applied,
    .entry.discarded {
      opacity: 0.55;
    }
    .entry .kind {
      font-size: var(--uui-type-small-size, 12px);
      color: var(--uui-color-text-alt, #515054);
    }
    .entry .summary {
      font-weight: bold;
      overflow-wrap: anywhere;
    }
    .entry .tags {
      display: flex;
      gap: 4px;
    }
    .conversation {
      max-height: 34%;
      overflow: auto;
      padding: var(--uui-size-space-3, 9px);
      border-top: 1px solid var(--uui-color-border, #d8d7d9);
      display: flex;
      flex-direction: column;
      gap: var(--uui-size-space-2, 6px);
    }
    .turn {
      padding: var(--uui-size-space-2, 6px) var(--uui-size-space-3, 9px);
      border-radius: var(--uui-border-radius, 3px);
      white-space: pre-wrap;
      font-size: var(--uui-type-small-size, 12px);
    }
    .turn.user {
      background: var(--uui-color-surface-alt, #f3f3f5);
    }
    .turn.assistant {
      background: var(--uui-color-divider, #f3f3f5);
    }
    form {
      display: flex;
      flex-direction: column;
      gap: var(--uui-size-space-2, 6px);
      padding: var(--uui-size-space-3, 9px);
      border-top: 1px solid var(--uui-color-border, #d8d7d9);
    }
    textarea {
      font: inherit;
      padding: var(--uui-size-space-2, 6px);
      border: 1px solid var(--uui-color-border, #d8d7d9);
      border-radius: var(--uui-border-radius, 3px);
      resize: vertical;
    }
    .detail,
    .empty {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
    }
    .empty {
      align-items: center;
      justify-content: center;
      color: var(--uui-color-text-alt, #515054);
    }
    .detail-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--uui-size-space-4, 12px);
      padding: var(--uui-size-space-4, 12px);
      border-bottom: 1px solid var(--uui-color-border, #d8d7d9);
    }
    .actions {
      display: flex;
      gap: var(--uui-size-space-2, 6px);
      flex: none;
    }
    .effect,
    .hint {
      margin: 4px 0 0;
      font-size: var(--uui-type-small-size, 12px);
      color: var(--uui-color-text-alt, #515054);
    }
    .editor {
      flex: 1;
      min-height: 320px;
      display: flex;
    }
    umb-code-editor {
      flex: 1;
      min-height: 320px;
    }
    .values {
      flex: 1;
      overflow: auto;
      padding: var(--uui-size-space-4, 12px);
      display: flex;
      flex-direction: column;
      gap: var(--uui-size-space-3, 9px);
    }
    .value {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .value span {
      font-weight: bold;
      font-size: var(--uui-type-small-size, 12px);
    }
    .described {
      padding: var(--uui-size-space-4, 12px);
      border-bottom: 1px solid var(--uui-color-border, #d8d7d9);
    }
    .described ul {
      margin: 0;
      padding-left: 1.1rem;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .described li {
      font-size: var(--uui-type-small-size, 12px);
    }
    .readonly {
      flex: 1;
      margin: 0;
      padding: var(--uui-size-space-4, 12px);
      overflow: auto;
      background: var(--uui-color-surface-alt, #f3f3f5);
      white-space: pre-wrap;
    }
    .save {
      display: flex;
      align-items: center;
      gap: var(--uui-size-space-3, 9px);
      padding: var(--uui-size-space-3, 9px) var(--uui-size-space-4, 12px);
      border-top: 1px solid var(--uui-color-border, #d8d7d9);
    }
    .problems {
      margin: 0;
      padding: var(--uui-size-space-3, 9px) var(--uui-size-space-4, 12px)
        var(--uui-size-space-3, 9px) calc(var(--uui-size-space-4, 12px) + 16px);
      color: var(--uui-color-danger, #d42054);
      font-size: var(--uui-type-small-size, 12px);
    }
    .error {
      color: var(--uui-color-danger, #d42054);
    }
    .unavailable {
      border-bottom: 1px solid var(--uui-color-danger, #d42054);
    }
    .unavailable p {
      margin: var(--uui-size-space-2, 6px) 0;
    }
    .unavailable .remedy {
      font-family: var(--uui-font-monospace, monospace);
      overflow-wrap: anywhere;
    }
  `
}

customElements.define('bunbraco-assistant-drawer', BunbracoAssistantDrawerElement)
