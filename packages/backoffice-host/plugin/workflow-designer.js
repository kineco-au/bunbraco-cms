/**
 * The workflow designer (story 028): stages drawn on a canvas and connected by
 * arrows, each stage's approvers and send-back beside it, and the workflow's
 * own settings on a tab of their own. Saving writes `schema/workflows/<alias>.toml`; before it
 * does, the requests in flight that the change affects are named.
 *
 * An arrow that would close a loop is refused as it is drawn. The server holds
 * the file to the same rules on save, so this only spares a round trip.
 */
// For its side effect: registers `umb-input-document`, which the shell loads lazily.
import '@umbraco-cms/backoffice/document'
import { css, html, nothing, unsafeCSS } from '@umbraco-cms/backoffice/external/lit'
import { UmbLitElement } from '@umbraco-cms/backoffice/lit-element'
import { UMB_NOTIFICATION_CONTEXT } from '@umbraco-cms/backoffice/notification'
import { deleteWorkflow, listWorkflows, previewWorkflow, saveWorkflow } from './workflow-client.js'
import { ancestors, BOX, drawGraph, GRAPH_STYLES, layout, wouldLoop } from './workflow-graph.js'

const ON_EDIT = {
  withdraw: 'Saving withdraws the request; the editor sends it again',
  'approve-latest': 'Saving goes into the request; approvers approve the latest',
  lock: 'The page cannot be changed while it waits',
  'lock-after-first-approval': 'The page can be changed until someone approves',
}
const SELF = {
  refused: 'Someone else must approve it',
  allowed: 'They may approve it like anyone in the group',
  automatic: 'Their approval counts automatically where they are in the group',
}
const COMMENTS = {
  optional: 'Optional',
  'on-send-back': 'Required when sending back',
  always: 'Required with every decision',
}
const ON_CHANGE = {
  keep: 'They finish under the version they started with',
  restart: 'They start again under the new version',
  withdraw: 'They are withdrawn, and sent again',
}

const blank = () => ({
  alias: 'new-workflow',
  name: 'New workflow',
  appliesTo: { branches: [], contentTypes: [] },
  publishersMaySkip: true,
  onEdit: 'withdraw',
  selfApproval: 'refused',
  comments: 'optional',
  unpublish: false,
  onChange: 'keep',
  stages: [
    {
      alias: 'review',
      name: 'Review',
      approvers: [],
      required: 'one',
      next: [],
      sendBack: 'editor',
      position: { x: 0, y: 0 },
    },
  ],
})

const select = (label, value, options, onChange, disabled) => html`<uui-select
  label=${label}
  ?disabled=${disabled}
  .options=${Object.entries(options).map(([key, name]) => ({ name, value: key, selected: key === value }))}
  @change=${(e) => onChange(e.target.value)}
></uui-select>`

/** A labelled row, as every backoffice editor lays out a field. */
const property = (
  label,
  description,
  editor,
  orientation = 'horizontal',
) => html`<umb-property-layout
  orientation=${orientation}
  label=${label}
  description=${description ?? ''}
><div slot="editor">${editor}</div></umb-property-layout>`

export default class CromboloWorkflowDesignerElement extends UmbLitElement {
  static properties = {
    _list: { state: true },
    _editing: { state: true },
    _originalAlias: { state: true },
    _selected: { state: true },
    _connecting: { state: true },
    _problems: { state: true },
    _affected: { state: true },
    _message: { state: true },
    _tab: { state: true },
  }

  #drag
  #notifications

  constructor() {
    super()
    this.consumeContext(UMB_NOTIFICATION_CONTEXT, (context) => {
      this.#notifications = context
    })
  }

  connectedCallback() {
    super.connectedCallback()
    this.#load()
  }

  async #load() {
    const result = await listWorkflows()
    if (!result.ok) {
      this._message = result.message
      return
    }
    this._list = result
  }

  #edit(workflow) {
    const copy = structuredClone(workflow)
    // Every stage gets the place the canvas would draw it, so dragging starts from there.
    const positions = layout(copy.stages)
    for (const stage of copy.stages) stage.position = stage.position ?? positions.get(stage.alias)
    this._editing = copy
    this._originalAlias = workflow.alias
    this._selected = copy.stages[0]?.alias
    this._problems = undefined
    this._affected = undefined
    this._message = undefined
    this._tab = 'settings'
  }

  #touch() {
    this._editing = { ...this._editing }
    this._affected = undefined
  }

  #stage(alias) {
    return this._editing.stages.find((s) => s.alias === alias)
  }

  #addStage() {
    let n = this._editing.stages.length + 1
    while (this.#stage(`stage-${n}`)) n++
    const xs = this._editing.stages.map((s) => s.position?.x ?? 0)
    this._editing.stages.push({
      alias: `stage-${n}`,
      name: `Stage ${n}`,
      approvers: [],
      required: 'one',
      next: [],
      sendBack: 'editor',
      position: { x: Math.max(0, ...xs) + BOX.width + 80, y: 0 },
    })
    this._selected = `stage-${n}`
    this.#touch()
  }

  #removeStage(alias) {
    this._editing.stages = this._editing.stages
      .filter((s) => s.alias !== alias)
      .map((s) => ({
        ...s,
        next: s.next.filter((n) => n !== alias),
        sendBack: s.sendBack === alias ? 'editor' : s.sendBack,
      }))
    this._selected = this._editing.stages[0]?.alias
    this.#touch()
  }

  #renameStage(stage, alias) {
    const clean = alias.trim().replace(/[^A-Za-z0-9_-]/g, '-')
    if (!clean || this.#stage(clean)) return
    for (const other of this._editing.stages) {
      other.next = other.next.map((n) => (n === stage.alias ? clean : n))
      if (other.sendBack === stage.alias) other.sendBack = clean
    }
    stage.alias = clean
    this._selected = clean
    this.#touch()
  }

  #onStage(alias) {
    if (this.#drag?.moved) return
    if (!this._connecting) {
      this._selected = alias
      return
    }
    if (this._connecting === true) {
      this._connecting = alias
      return
    }
    const from = this._connecting
    this._connecting = undefined
    if (wouldLoop(this._editing.stages, from, alias)) {
      this._message = `An arrow from ${from} to ${alias} would make the stages loop, so it was not drawn.`
      return
    }
    const source = this.#stage(from)
    if (!source.next.includes(alias)) source.next = [...source.next, alias]
    this._message = undefined
    this.#touch()
  }

  #onArrow(from, to) {
    const source = this.#stage(from)
    source.next = source.next.filter((n) => n !== to)
    const target = this.#stage(to)
    if (
      target &&
      !ancestors(this._editing.stages, to).has(target.sendBack) &&
      target.sendBack !== 'editor'
    )
      target.sendBack = 'editor'
    this.#touch()
  }

  #pointerDown(alias, event) {
    if (this._connecting) return
    const stage = this.#stage(alias)
    this.#drag = {
      alias,
      startX: event.clientX,
      startY: event.clientY,
      from: { ...stage.position },
      moved: false,
    }
  }

  #pointerMove(event) {
    if (!this.#drag) return
    const stage = this.#stage(this.#drag.alias)
    const dx = event.clientX - this.#drag.startX
    const dy = event.clientY - this.#drag.startY
    if (Math.abs(dx) + Math.abs(dy) > 3) this.#drag.moved = true
    stage.position = {
      x: Math.max(0, Math.round(this.#drag.from.x + dx)),
      y: Math.max(0, Math.round(this.#drag.from.y + dy)),
    }
    this._editing = { ...this._editing }
  }

  #pointerUp() {
    const drag = this.#drag
    // The click that follows a drag selects nothing.
    setTimeout(() => {
      if (this.#drag === drag) this.#drag = undefined
    })
  }

  async #save(confirmed = false) {
    this._problems = undefined
    if (!confirmed) {
      const preview = await previewWorkflow(
        this._originalAlias ?? this._editing.alias,
        this._editing,
      )
      if (!preview.ok) {
        this._problems = preview.problems ?? [{ message: preview.message }]
        return
      }
      if (preview.affected.length > 0) {
        this._affected = preview.affected
        return
      }
    }
    const saved = await saveWorkflow(this._originalAlias ?? this._editing.alias, this._editing)
    if (!saved.ok) {
      this._problems = saved.problems ?? [{ message: saved.message }]
      return
    }
    this._affected = undefined
    // The green toast every workspace shows on a save.
    this.#notifications?.peek('positive', { data: { message: 'Workflow saved' } })
    this._originalAlias = this._editing.alias
    await this.#load()
  }

  /** From the list or the editor: the workflow by its name and the alias its file has. */
  async #delete(name, alias) {
    if (
      !window.confirm(
        `Delete the workflow "${name}"? Pages it covers will publish without approval.`,
      )
    )
      return
    const result = await deleteWorkflow(alias)
    if (!result.ok) {
      this._message = result.message
      return
    }
    this._editing = undefined
    await this.#load()
  }

  render() {
    if (this._message && !this._list)
      return html`<div class="list"><uui-box headline="Workflows">${this._message}</uui-box></div>`
    if (!this._list)
      return html`<div class="list"><uui-box headline="Workflows"><uui-loader></uui-loader></uui-box></div>`
    if (!this._editing) return this.#renderList()
    return this.#renderEditor()
  }

  #renderList() {
    const { items, editable } = this._list
    // The create button above the list, as the Created bundles view has it.
    return html`<div class="list">
      ${
        editable
          ? html`<uui-button class="create" color="default" look="outline" label="Create" @click=${() => this.#edit(blank())}>Create</uui-button>`
          : nothing
      }
      ${this._message ? html`<uui-box><p class="message">${this._message}</p></uui-box>` : nothing}
      <uui-box headline="Workflows">
      ${editable ? nothing : html`<p>Workflows are kept with the site's files, which cannot be changed on this server. Change them in the repository and deploy.</p>`}
      ${
        items.length === 0
          ? html`<p>No workflow yet: every page publishes as soon as someone who may publish does.</p>`
          : html`<uui-table>
              <uui-table-head>
                <uui-table-head-cell>Workflow</uui-table-head-cell>
                <uui-table-head-cell>Covers</uui-table-head-cell>
                <uui-table-head-cell>Stages</uui-table-head-cell>
                <uui-table-head-cell class="actions"></uui-table-head-cell>
              </uui-table-head>
              ${items.map(
                (w) => html`<uui-table-row>
                  <uui-table-cell>${w.name}</uui-table-cell>
                  <uui-table-cell>${[
                    w.appliesTo.branches.length ? `${w.appliesTo.branches.length} branch(es)` : '',
                    ...w.appliesTo.contentTypes,
                  ]
                    .filter(Boolean)
                    .join(', ')}</uui-table-cell>
                  <uui-table-cell>${w.stages.length}</uui-table-cell>
                  <uui-table-cell class="actions">
                    <uui-button look="secondary" label=${editable ? 'Edit' : 'View'} @click=${() => this.#edit(w)}></uui-button>
                    ${
                      editable
                        ? html`<uui-button look="secondary" color="danger" label="Delete" @click=${() => this.#delete(w.name, w.alias)}></uui-button>`
                        : nothing
                    }
                  </uui-table-cell>
                </uui-table-row>`,
              )}
            </uui-table>`
      }
      </uui-box>
    </div>`
  }

  #renderEditor() {
    const w = this._editing
    const editable = this._list.editable
    const leave = () => {
      this._editing = undefined
      this._message = undefined
      this._problems = undefined
    }
    const tab = (id, label, icon) => html`<uui-tab
      label=${label}
      ?active=${this._tab === id}
      @click=${() => {
        this._tab = id
      }}
    ><umb-icon slot="icon" name=${icon}></umb-icon>${label}</uui-tab>`
    // Umbraco's own layout, so Save sits bottom right in the footer as it does
    // in every workspace, with Back beside it, and the tabs top right.
    return html`<umb-body-layout headline=${w.name || 'Workflow'}>
      <uui-tab-group slot="navigation">
        ${tab('settings', 'Settings', 'icon-settings')}
        ${tab('stages', 'Stages', 'icon-mindmap')}
      </uui-tab-group>
      ${this._message ? html`<uui-box class="notice"><p class="message">${this._message}</p></uui-box>` : nothing}
      ${
        this._problems
          ? html`<uui-box class="notice" headline="Not saved"><ul class="problems">${this._problems.map((p) => html`<li>${p.path ? html`<code>${p.path}</code> ` : nothing}${p.message}</li>`)}</ul></uui-box>`
          : nothing
      }
      ${
        this._affected
          ? html`<uui-box class="notice affected" headline="Pages waiting for approval">
                <p>Saving changes the rules for ${this._affected.length} page(s) waiting for approval:</p>
                <ul>${this._affected.map((a) => html`<li>${a.page}: ${ON_CHANGE[a.outcome]}</li>`)}</ul>
                <uui-button look="primary" label="Save anyway" @click=${() => this.#save(true)}>Save anyway</uui-button>
              </uui-box>`
          : nothing
      }
      ${this._tab === 'stages' ? this.#renderStages(w, editable) : this.#renderSettings(w, editable)}
      ${
        this._problems
          ? html`<span slot="footer-info" class="not-saved">Not saved: ${this._problems.length} problem(s), listed above</span>`
          : nothing
      }
      <uui-button slot="actions" look="secondary" label="Back to the list" @click=${leave}>Back to the list</uui-button>
      ${
        editable
          ? html`<uui-button slot="actions" look="primary" color="positive" label="Save" @click=${() => this.#save()}>Save</uui-button>`
          : nothing
      }
    </umb-body-layout>`
  }

  #renderStages(w, editable) {
    const stage = this.#stage(this._selected)
    // One box, two columns: the graph, and the stage selected in it.
    return html`<uui-box headline="Stages">
        ${
          editable
            ? html`<div slot="header-actions" class="toolbar">
                <uui-button look="secondary" compact label="Add a stage" @click=${() => this.#addStage()}>Add a stage</uui-button>
                <uui-button look=${this._connecting ? 'primary' : 'secondary'} compact label="Connect stages"
                  @click=${() => {
                    this._connecting = this._connecting ? undefined : true
                  }}
                >${this._connecting === true ? 'Click the stage to draw from' : this._connecting ? 'Now click the stage it leads to' : 'Connect stages'}</uui-button>
              </div>`
            : nothing
        }
      <div class="stages">
      <div class="graph">
        <p class="hint">Arrows run left to right: the stages an arrow leads to wait for every stage with an arrow into them, and run side by side. Click an arrow to remove it.</p>
        <div class="canvas" @pointermove=${(e) => editable && this.#pointerMove(e)} @pointerup=${() => this.#pointerUp()} @pointerleave=${() => this.#pointerUp()}>
          ${drawGraph(w.stages, {
            selected: this._selected,
            onStage: (alias) => this.#onStage(alias),
            onArrow: (from, to) => editable && this.#onArrow(from, to),
            onPointerDown: (alias, event) => editable && this.#pointerDown(alias, event),
          })}
        </div>
      </div>
      <div class="stage">
        ${stage ? this.#renderStage(stage, editable) : html`<p class="hint">Select a stage to change it.</p>`}
      </div>
      </div>
    </uui-box>`
  }

  #renderStage(stage, editable) {
    const earlier = [...ancestors(this._editing.stages, stage.alias)]
    const requiredKind = typeof stage.required === 'number' ? 'number' : stage.required
    return html`<div class="stage-header">
        <h4>${stage.name || stage.alias}</h4>
      ${
        editable && this._editing.stages.length > 1
          ? html`<uui-button look="secondary" color="danger" compact label="Remove this stage" @click=${() => this.#removeStage(stage.alias)}>Remove</uui-button>`
          : nothing
      }
      </div>
      ${property(
        'Name',
        undefined,
        html`<uui-input label="Name" ?readonly=${!editable} .value=${stage.name ?? ''} @change=${(
          e,
        ) => {
          stage.name = e.target.value
          this.#touch()
        }}></uui-input>`,
        'vertical',
      )}
      ${property(
        'Alias',
        'How the stage is named in the file and in other stages',
        html`<uui-input label="Alias" ?readonly=${!editable} .value=${stage.alias} @change=${(e) => this.#renameStage(stage, e.target.value)}></uui-input>`,
        'vertical',
      )}
      ${property(
        'Approved by',
        'The user groups whose members decide this stage',
        html`<div class="checks">${this._list.groups.map(
          (g) =>
            html`<uui-checkbox label=${g.name} ?disabled=${!editable} ?checked=${stage.approvers.includes(g.alias)} @change=${(
              e,
            ) => {
              stage.approvers = e.target.checked
                ? [...stage.approvers, g.alias]
                : stage.approvers.filter((a) => a !== g.alias)
              this.#touch()
            }}>${g.name}</uui-checkbox>`,
        )}</div>`,
        'vertical',
      )}
      ${property(
        'How many must approve',
        undefined,
        html`${select(
          'How many must approve',
          requiredKind,
          {
            one: 'Any one of them',
            majority: 'A majority',
            all: 'All of them',
            number: 'A number of them',
          },
          (value) => {
            stage.required = value === 'number' ? 2 : value
            this.#touch()
          },
          !editable,
        )}
        ${
          typeof stage.required === 'number'
            ? html`<uui-input class="count" type="number" min="1" label="How many" ?readonly=${!editable} .value=${String(stage.required)} @change=${(
                e,
              ) => {
                stage.required = Math.max(1, Number(e.target.value) || 1)
                this.#touch()
              }}></uui-input>`
            : nothing
        }`,
        'vertical',
      )}
      ${property(
        'Sending back goes to',
        undefined,
        select(
          'Sending back goes to',
          stage.sendBack,
          {
            editor: 'The editor (the request ends)',
            ...Object.fromEntries(
              earlier.map((a) => [a, `The ${this.#stage(a)?.name || a} stage`]),
            ),
          },
          (value) => {
            stage.sendBack = value
            this.#touch()
          },
          !editable,
        ),
        'vertical',
      )}`
  }

  #renderSettings(w, editable) {
    const set = (key) => (value) => {
      w[key] = value
      this.#touch()
    }
    return html`<div class="settings">
      ${editable ? nothing : html`<uui-box class="notice"><p>Workflows are kept with the site's files, which cannot be changed on this server.</p></uui-box>`}
      <uui-box headline="Workflow">
        ${property(
          'Name',
          undefined,
          html`<uui-input label="Name" ?readonly=${!editable} .value=${w.name} @change=${(e) => set('name')(e.target.value)}></uui-input>`,
        )}
        ${property(
          'Alias',
          'The name of its file',
          html`<uui-input label="Alias" ?readonly=${!editable} .value=${w.alias} @change=${(e) => set('alias')(e.target.value.trim())}></uui-input>`,
        )}
        ${property(
          'Covers the pages under',
          'Each page and everything below it',
          html`<umb-input-document
            ?readonly=${!editable}
            .selection=${w.appliesTo.branches}
            @change=${(e) => {
              w.appliesTo.branches = [...(e.target.selection ?? [])]
              this.#touch()
            }}
          ></umb-input-document>`,
        )}
        ${property(
          'And every page of these types',
          'Wherever they are, unless a branch above is covered by another workflow',
          html`<div class="checks">${this._list.contentTypes.map(
            (t) =>
              html`<uui-checkbox label=${t.name} ?disabled=${!editable} ?checked=${w.appliesTo.contentTypes.includes(t.alias)} @change=${(
                e,
              ) => {
                w.appliesTo.contentTypes = e.target.checked
                  ? [...w.appliesTo.contentTypes, t.alias]
                  : w.appliesTo.contentTypes.filter((a) => a !== t.alias)
                this.#touch()
              }}>${t.name}</uui-checkbox>`,
          )}</div>`,
        )}
      </uui-box>
      <uui-box headline="Rules">
        ${property(
          'Publishers may skip it',
          'People who may publish a page publish it directly',
          html`<uui-toggle label="Publishers may skip it" ?disabled=${!editable} ?checked=${w.publishersMaySkip} @change=${(e) => set('publishersMaySkip')(e.target.checked)}></uui-toggle>`,
        )}
        ${property(
          'Unpublishing needs approval',
          'Taking a page down goes through the workflow too',
          html`<uui-toggle label="Unpublishing needs approval" ?disabled=${!editable} ?checked=${w.unpublish} @change=${(e) => set('unpublish')(e.target.checked)}></uui-toggle>`,
        )}
        ${property('When a waiting page is changed', undefined, select('When a waiting page is changed', w.onEdit, ON_EDIT, set('onEdit'), !editable))}
        ${property(
          'When the person who made the change could approve it',
          undefined,
          select('Self-approval', w.selfApproval, SELF, set('selfApproval'), !editable),
        )}
        ${property('Comments on a decision', undefined, select('Comments', w.comments, COMMENTS, set('comments'), !editable))}
        ${property(
          'When this workflow changes',
          'What happens to pages already waiting on it',
          select('When this workflow changes', w.onChange, ON_CHANGE, set('onChange'), !editable),
        )}
      </uui-box>
    </div>`
  }

  static styles = css`
    :host { display: block; height: 100%; container-type: inline-size; }
    .list { padding: var(--uui-size-layout-1); }
    .create { margin-bottom: var(--uui-size-space-5); }
    .actions { text-align: right; white-space: nowrap; }
    uui-tab-group { --uui-tab-divider: var(--uui-color-border); border-left: 1px solid var(--uui-color-border); border-right: 1px solid var(--uui-color-border); }
    .notice { margin-bottom: var(--uui-size-layout-1); }
    .toolbar { display: flex; flex-wrap: wrap; gap: var(--uui-size-space-3); }
    .stages { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 380px); gap: var(--uui-size-layout-1); }
    .stage { border-left: 1px solid var(--uui-color-border); padding-left: var(--uui-size-layout-1); }
    .stage-header { display: flex; align-items: center; justify-content: space-between; gap: var(--uui-size-space-3); margin-bottom: var(--uui-size-space-3); }
    .stage-header h4 { margin: 0; }
    @container (max-width: 640px) {
      .stages { grid-template-columns: minmax(0, 1fr); }
      .stage { border-left: 0; padding-left: 0; border-top: 1px solid var(--uui-color-border); padding-top: var(--uui-size-layout-1); }
    }
    .settings { display: flex; flex-direction: column; gap: var(--uui-size-layout-1); }
    .canvas { overflow: auto; border: 1px dashed var(--uui-color-border); border-radius: var(--uui-border-radius); padding: var(--uui-size-space-5); min-height: 240px; touch-action: none; }
    umb-property-layout:first-of-type { padding-top: 0; }
    uui-input, uui-select { width: 100%; }
    uui-input.count { margin-top: var(--uui-size-space-3); max-width: 8em; }
    .checks { display: flex; flex-direction: column; gap: var(--uui-size-space-2); }
    .hint { margin-top: 0; color: var(--uui-color-text-alt); }
    .message { margin: 0; color: var(--uui-color-warning-emphasis, #9e7300); }
    .problems { color: var(--uui-color-danger); margin: 0; }
    .not-saved { color: var(--uui-color-danger); }
    .affected { border: 1px solid var(--uui-color-warning); }
    ${unsafeCSS(GRAPH_STYLES)}
  `
}

customElements.define('crombolo-workflow-designer', CromboloWorkflowDesignerElement)
