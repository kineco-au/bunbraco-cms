/**
 * A workflow's stages drawn as boxes and arrows (story 028): read-only on a
 * page's Workflow tab, and the canvas the designer edits. The graph rules here
 * mirror `@crombolo/core`'s, which the server applies again on save.
 */
import { svg } from '@umbraco-cms/backoffice/external/lit'

export const BOX = { width: 160, height: 56 }

/** Every stage reachable from `alias`. */
export function descendants(stages, alias) {
  const byAlias = new Map(stages.map((s) => [s.alias, s]))
  const found = new Set()
  const visit = (at) => {
    for (const next of byAlias.get(at)?.next ?? []) {
      if (found.has(next)) continue
      found.add(next)
      visit(next)
    }
  }
  visit(alias)
  return found
}

/** Every stage `alias` can be reached from: where it may send back to. */
export function ancestors(stages, alias) {
  const found = new Set()
  const visit = (at) => {
    for (const parent of stages.filter((s) => s.next.includes(at))) {
      if (found.has(parent.alias)) continue
      found.add(parent.alias)
      visit(parent.alias)
    }
  }
  visit(alias)
  return found
}

export const wouldLoop = (stages, from, to) => from === to || descendants(stages, to).has(from)

/** A position for every stage: its own, or one laid out by depth. */
export function layout(stages) {
  const depth = new Map()
  const starts = stages.filter((s) => !stages.some((o) => o.next.includes(s.alias)))
  const walk = (stage, d) => {
    if ((depth.get(stage.alias) ?? -1) >= d) return
    depth.set(stage.alias, d)
    for (const next of stage.next) {
      const child = stages.find((s) => s.alias === next)
      if (child) walk(child, d + 1)
    }
  }
  for (const start of starts) walk(start, 0)
  const rows = new Map()
  return new Map(
    stages.map((stage) => {
      if (stage.position) return [stage.alias, stage.position]
      const d = depth.get(stage.alias) ?? 0
      const row = rows.get(d) ?? 0
      rows.set(d, row + 1)
      return [stage.alias, { x: d * (BOX.width + 80), y: row * (BOX.height + 40) }]
    }),
  )
}

const STATE_FILL = {
  approved: 'var(--uui-color-positive-standalone, #2bc37c)',
  waiting: 'var(--uui-color-warning-standalone, #f0ac00)',
  discarded: 'var(--uui-color-disabled, #ccc)',
}

/**
 * The arrows and boxes as SVG. `states` colours each stage by where a request
 * stands; `selected` outlines one; the callbacks make it a canvas.
 */
export function drawGraph(stages, options = {}) {
  const positions = layout(stages)
  const at = (alias) => positions.get(alias) ?? { x: 0, y: 0 }
  const arrows = stages.flatMap((stage) =>
    stage.next.map((next) => {
      const a = at(stage.alias)
      const b = at(next)
      const x1 = a.x + BOX.width
      const y1 = a.y + BOX.height / 2
      const x2 = b.x
      const y2 = b.y + BOX.height / 2
      const mid = (x1 + x2) / 2
      return svg`<path
        class="arrow"
        d="M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2 - 6} ${y2}"
        marker-end="url(#crombolo-arrowhead)"
        @click=${(event) => options.onArrow?.(stage.alias, next, event)}
      ><title>${stage.alias} → ${next}</title></path>`
    }),
  )
  const boxes = stages.map((stage) => {
    const p = at(stage.alias)
    const state = options.states?.[stage.alias]
    return svg`<g
      class="stage ${options.selected === stage.alias ? 'selected' : ''}"
      transform="translate(${p.x}, ${p.y})"
      @pointerdown=${(event) => options.onPointerDown?.(stage.alias, event)}
      @click=${(event) => options.onStage?.(stage.alias, event)}
    >
      <rect width=${BOX.width} height=${BOX.height} rx="6" fill=${STATE_FILL[state] ?? 'var(--uui-color-surface, #fff)'}></rect>
      <text x="10" y="22" class="name">${stage.name || stage.alias}</text>
      <text x="10" y="42" class="detail">${stage.approvers.join(', ') || 'no approvers'}</text>
    </g>`
  })
  const width = Math.max(...[...positions.values()].map((p) => p.x + BOX.width), 0) + 40
  const height = Math.max(...[...positions.values()].map((p) => p.y + BOX.height), 0) + 40
  return svg`<svg class="graph" width=${Math.max(width, 320)} height=${Math.max(height, 120)}>
    <defs>
      <marker id="crombolo-arrowhead" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
        <path d="M0,0 L8,4 L0,8 z" fill="currentColor"></path>
      </marker>
    </defs>
    ${arrows}
    ${boxes}
  </svg>`
}

export const GRAPH_STYLES = `
  .graph { color: var(--uui-color-text, #1b264f); overflow: visible; }
  .graph .arrow { fill: none; stroke: currentColor; stroke-width: 1.5; cursor: pointer; }
  .graph .arrow:hover { stroke: var(--uui-color-danger, #d42054); }
  .graph .stage rect { stroke: var(--uui-color-border, #d8d7d9); stroke-width: 1; }
  .graph .stage.selected rect { stroke: var(--uui-color-interactive, #3544b1); stroke-width: 2; }
  .graph .stage { cursor: grab; }
  .graph .name { font-weight: 700; font-size: 13px; }
  .graph .detail { font-size: 11px; opacity: 0.8; }
`
