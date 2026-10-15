/**
 * The workflow designer (story 028): stages drawn on a canvas and connected by
 * arrows, each stage's approvers and send-back beside it, and the workflow's
 * own settings above. Saving writes `schema/workflows/<alias>.toml`; before it
 * does, the requests in flight that the change affects are named.
 *
 * An arrow that would close a loop is refused as it is drawn. The server holds
 * the file to the same rules on save, so this only spares a round trip.
 */
// For its side effect: registers `umb-input-document`, which the shell loads lazily.
import '@umbraco-cms/backoffice/document'
import { css, html, nothing, unsafeCSS } from '@umbraco-cms/backoffice/external/lit'
import { UmbLitElement } from '@umbraco-cms/backoffice/lit-element'
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

const select = (
  value,
  options,
  onChange,
) => html`<select @change=${(e) => onChange(e.target.value)}>
  ${Object.entries(options).map(([key, label]) => html`<option value=${key} ?selected=${key === value}>${label}</option>`)}
</select>`

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
    _saved: { state: true },
  }

  #drag

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
  }

  #touch() {
    this._editing = { ...this._editing }
    this._affected = undefined
    this._saved = undefined
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
    this._saved = undefined
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
    this._saved = 'Saved.'
    this._originalAlias = this._editing.alias
    await this.#load()
  }

  async #delete() {
    if (
      !window.confirm(
        `Delete the workflow "${this._editing.name}"? Pages it covers will publish without approval.`,
      )
    )
      return
    const result = await deleteWorkflow(this._originalAlias)
    if (!result.ok) {
      this._message = result.message
      return
    }
    this._editing = undefined
    await this.#load()
  }

  render() {
    if (this._message && !this._list)
      return html`<umb-body-layout headline="Workflows"><uui-box>${this._message}</uui-box></umb-body-layout>`
    if (!this._list)
      return html`<umb-body-layout headline="Workflows"><uui-loader></uui-loader></umb-body-layout>`
    if (!this._editing) return this.#renderList()
    return this.#renderEditor()
  }

  #renderList() {
    const { items, editable } = this._list
    // The create button above the list, as the Created bundles view has it.
    return html`<umb-body-layout headline="Workflows">
      ${
        editable
          ? html`<uui-button class="create" look="primary" label="New workflow" @click=${() => this.#edit(blank())}>New workflow</uui-button>`
          : nothing
      }
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
              </uui-table-head>
              ${items.map(
                (w) => html`<uui-table-row>
                  <uui-table-cell><a href="#" @click=${(e) => {
                    e.preventDefault()
                    this.#edit(w)
                  }}>${w.name}</a></uui-table-cell>
                  <uui-table-cell>${[
                    w.appliesTo.branches.length ? `${w.appliesTo.branches.length} branch(es)` : '',
                    ...w.appliesTo.contentTypes,
                  ]
                    .filter(Boolean)
                    .join(', ')}</uui-table-cell>
                  <uui-table-cell>${w.stages.length}</uui-table-cell>
                </uui-table-row>`,
              )}
            </uui-table>`
      }
      </uui-box>
    </umb-body-layout>`
  }

  #renderEditor() {
    const w = this._editing
    const editable = this._list.editable
    const stage = this.#stage(this._selected)
    const leave = () => {
      this._editing = undefined
    }
    // Umbraco's own layout, so Save sits bottom right in the footer as it does
    // in every workspace, with Back beside it.
    return html`<umb-body-layout headline=${w.name || 'Workflow'}>
      <uui-box>
        ${
          editable
            ? html`<div class="toolbar">
                <uui-button look="secondary" label="Add a stage" @click=${() => this.#addStage()}>Add a stage</uui-button>
                <uui-button look=${this._connecting ? 'primary' : 'secondary'} label="Connect stages"
                  @click=${() => {
                    this._connecting = this._connecting ? undefined : true
                  }}
                >${this._connecting === true ? 'Click the stage to draw from' : this._connecting ? 'Now click the stage it leads to' : 'Connect stages'}</uui-button>
                ${
                  this._originalAlias &&
                  this._list.items.some((i) => i.alias === this._originalAlias)
                    ? html`<uui-button look="secondary" color="danger" label="Delete" @click=${() => this.#delete()}>Delete</uui-button>`
                    : nothing
                }
              </div>`
            : nothing
        }
        ${this._message ? html`<p class="message">${this._message}</p>` : nothing}
        ${this._problems ? html`<ul class="problems">${this._problems.map((p) => html`<li>${p.path ? html`<code>${p.path}</code> ` : nothing}${p.message}</li>`)}</ul>` : nothing}
        ${
          this._affected
            ? html`<div class="affected">
                <p>Saving changes the rules for ${this._affected.length} page(s) waiting for approval:</p>
                <ul>${this._affected.map((a) => html`<li>${a.page}: ${ON_CHANGE[a.outcome]}</li>`)}</ul>
                <uui-button look="primary" label="Save anyway" @click=${() => this.#save(true)}>Save anyway</uui-button>
              </div>`
            : nothing
        }
        <p class="hint">Arrows run left to right: the stages an arrow leads to wait for every stage with an arrow into them, and run side by side. Click an arrow to remove it.</p>
        <div class="canvas" @pointermove=${(e) => editable && this.#pointerMove(e)} @pointerup=${() => this.#pointerUp()} @pointerleave=${() => this.#pointerUp()}>
          ${drawGraph(w.stages, {
            selected: this._selected,
            onStage: (alias) => this.#onStage(alias),
            onArrow: (from, to) => editable && this.#onArrow(from, to),
            onPointerDown: (alias, event) => editable && this.#pointerDown(alias, event),
          })}
        </div>
      </uui-box>
      <div class="panels">
        ${stage ? this.#renderStage(stage, editable) : nothing}
        ${this.#renderSettings(w, editable)}
      </div>
      ${this._saved ? html`<span slot="footer-info" class="saved">${this._saved}</span>` : nothing}
      <uui-button slot="actions" look="secondary" label="Back to the list" @click=${leave}>Back to the list</uui-button>
      ${
        editable
          ? html`<uui-button slot="actions" look="primary" color="positive" label="Save" @click=${() => this.#save()}>Save</uui-button>`
          : nothing
      }
    </umb-body-layout>`
  }

  #renderStage(stage, editable) {
    const earlier = [...ancestors(this._editing.stages, stage.alias)]
    const requiredKind = typeof stage.required === 'number' ? 'number' : stage.required
    return html`<uui-box headline=${`Stage: ${stage.name || stage.alias}`}>
      <fieldset ?disabled=${!editable}>
        <label>Name <uui-input label="Name" .value=${stage.name ?? ''} @change=${(e) => {
          stage.name = e.target.value
          this.#touch()
        }}></uui-input></label>
        <label>Alias <uui-input label="Alias" .value=${stage.alias} @change=${(e) => this.#renameStage(stage, e.target.value)}></uui-input></label>
        <div class="field"><span>Approved by</span>
          ${this._list.groups.map(
            (g) =>
              html`<label class="check"><input type="checkbox" .checked=${stage.approvers.includes(g.alias)} @change=${(
                e,
              ) => {
                stage.approvers = e.target.checked
                  ? [...stage.approvers, g.alias]
                  : stage.approvers.filter((a) => a !== g.alias)
                this.#touch()
              }} /> ${g.name}</label>`,
          )}
        </div>
        <label>How many must approve
          ${select(
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
          )}
          ${
            typeof stage.required === 'number'
              ? html`<input type="number" min="1" .value=${String(stage.required)} @change=${(
                  e,
                ) => {
                  stage.required = Math.max(1, Number(e.target.value) || 1)
                  this.#touch()
                }} />`
              : nothing
          }
        </label>
        <label>Sending back goes to
          ${select(
            stage.sendBack,
            {
              editor: 'The editor (the request ends)',
              ...Object.fromEntries(earlier.map((a) => [a, `The ${a} stage`])),
            },
            (value) => {
              stage.sendBack = value
              this.#touch()
            },
          )}
        </label>
        ${
          editable && this._editing.stages.length > 1
            ? html`<uui-button look="secondary" color="danger" label="Remove stage" @click=${() => this.#removeStage(stage.alias)}>Remove this stage</uui-button>`
            : nothing
        }
      </fieldset>
    </uui-box>`
  }

  #renderSettings(w, editable) {
    return html`<uui-box headline="Settings">
      <fieldset ?disabled=${!editable}>
        <label>Name <uui-input label="Name" .value=${w.name} @change=${(e) => {
          w.name = e.target.value
          this.#touch()
        }}></uui-input></label>
        <label>Alias <uui-input label="Alias" .value=${w.alias} @change=${(e) => {
          w.alias = e.target.value.trim()
          this.#touch()
        }}></uui-input></label>
        <div class="field"><span>Covers the pages under</span>
          <umb-input-document
            .selection=${w.appliesTo.branches}
            @change=${(e) => {
              w.appliesTo.branches = [...(e.target.selection ?? [])]
              this.#touch()
            }}
          ></umb-input-document>
        </div>
        <div class="field"><span>And every page of these types</span>
          ${this._list.contentTypes.map(
            (t) =>
              html`<label class="check"><input type="checkbox" .checked=${w.appliesTo.contentTypes.includes(t.alias)} @change=${(
                e,
              ) => {
                w.appliesTo.contentTypes = e.target.checked
                  ? [...w.appliesTo.contentTypes, t.alias]
                  : w.appliesTo.contentTypes.filter((a) => a !== t.alias)
                this.#touch()
              }} /> ${t.name}</label>`,
          )}
        </div>
        <label class="check"><input type="checkbox" .checked=${w.publishersMaySkip} @change=${(
          e,
        ) => {
          w.publishersMaySkip = e.target.checked
          this.#touch()
        }} /> People who may publish can publish directly</label>
        <label class="check"><input type="checkbox" .checked=${w.unpublish} @change=${(e) => {
          w.unpublish = e.target.checked
          this.#touch()
        }} /> Taking a page down needs approval too</label>
        <label>When a waiting page is changed ${select(w.onEdit, ON_EDIT, (v) => {
          w.onEdit = v
          this.#touch()
        })}</label>
        <label>When the person who made the change could approve it ${select(
          w.selfApproval,
          SELF,
          (v) => {
            w.selfApproval = v
            this.#touch()
          },
        )}</label>
        <label>Comments ${select(w.comments, COMMENTS, (v) => {
          w.comments = v
          this.#touch()
        })}</label>
        <label>When this workflow changes, pages waiting on it ${select(
          w.onChange,
          ON_CHANGE,
          (v) => {
            w.onChange = v
            this.#touch()
          },
        )}</label>
      </fieldset>
    </uui-box>`
  }

  static styles = css`
    :host { display: block; height: 100%; }
    .create { margin-bottom: var(--uui-size-space-5); }
    .toolbar { display: flex; flex-wrap: wrap; gap: var(--uui-size-space-3); margin-bottom: var(--uui-size-space-4); }
    .canvas { overflow: auto; border: 1px dashed var(--uui-color-border); border-radius: 6px; padding: var(--uui-size-space-5); min-height: 200px; touch-action: none; }
    .panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--uui-size-space-5); margin-top: var(--uui-size-space-5); }
    fieldset { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--uui-size-space-4); }
    label, .field { display: flex; flex-direction: column; gap: var(--uui-size-space-2); }
    label.check { flex-direction: row; align-items: center; }
    .field > span { font-weight: 700; }
    .hint { opacity: 0.8; font-size: 0.9em; }
    .message { color: var(--uui-color-warning-emphasis, #9e7300); }
    .problems { color: var(--uui-color-danger); }
    .saved { color: var(--uui-color-positive-emphasis, #1f7a4f); }
    .affected { border: 1px solid var(--uui-color-warning); padding: var(--uui-size-space-4); border-radius: 6px; margin-bottom: var(--uui-size-space-4); }
    ${unsafeCSS(GRAPH_STYLES)}
  `
}

customElements.define('crombolo-workflow-designer', CromboloWorkflowDesignerElement)
