/**
 * Approval workflows (story 028): a workflow is an acyclic graph of stages, each
 * approved by named user groups. Arrows out of a stage are followed in
 * parallel; a stage with several arrows in waits for all of them; when every
 * last stage has approved, the page is published. `docs/workflows.md`.
 *
 * The model and the graph rules are here, pure, so the schema check, the
 * engine and the designer agree on what a workflow means.
 */

/** How many of a stage's approvers must approve: one, a majority, all, or a number. */
export type StageRequirement = 'one' | 'majority' | 'all' | number

/** What saving a page does while it waits for approval. */
export type WorkflowOnEdit = 'withdraw' | 'approve-latest' | 'lock' | 'lock-after-first-approval'

/** Whether the person who made the change may approve it. */
export type WorkflowSelfApproval = 'refused' | 'allowed' | 'automatic'

/** When a decision needs a comment. */
export type WorkflowComments = 'optional' | 'on-send-back' | 'always'

/** What a request in flight does when its workflow changes. */
export type WorkflowOnChange = 'keep' | 'restart' | 'withdraw'

export const WORKFLOW_ON_EDIT: readonly WorkflowOnEdit[] = [
  'withdraw',
  'approve-latest',
  'lock',
  'lock-after-first-approval',
]
export const WORKFLOW_SELF_APPROVAL: readonly WorkflowSelfApproval[] = [
  'refused',
  'allowed',
  'automatic',
]
export const WORKFLOW_COMMENTS: readonly WorkflowComments[] = ['optional', 'on-send-back', 'always']
export const WORKFLOW_ON_CHANGE: readonly WorkflowOnChange[] = ['keep', 'restart', 'withdraw']

/** Where a send-back from a stage goes. */
export const SEND_BACK_TO_EDITOR = 'editor'

export interface WorkflowStage {
  alias: string
  name?: string
  /** User group aliases. */
  approvers: string[]
  required: StageRequirement
  /** Stage aliases that follow this one; empty for a last stage. */
  next: string[]
  /** `editor`, or the alias of an earlier stage on this one's path. */
  sendBack: string
  /** Where the designer drew it. */
  position?: { x: number; y: number }
}

export interface SchemaWorkflow {
  key?: string
  alias: string
  name: string
  appliesTo: { branches: string[]; contentTypes: string[] }
  publishersMaySkip: boolean
  onEdit: WorkflowOnEdit
  selfApproval: WorkflowSelfApproval
  comments: WorkflowComments
  unpublish: boolean
  onChange: WorkflowOnChange
  stages: WorkflowStage[]
}

const byAlias = (workflow: SchemaWorkflow) => new Map(workflow.stages.map((s) => [s.alias, s]))

/** The stages with no arrow in: a valid workflow has exactly one. Pure. */
export function startStages(workflow: SchemaWorkflow): string[] {
  const reached = new Set(workflow.stages.flatMap((s) => s.next))
  return workflow.stages.filter((s) => !reached.has(s.alias)).map((s) => s.alias)
}

/** The stages with an arrow into this one. Pure. */
export function incomingStages(workflow: SchemaWorkflow, alias: string): string[] {
  return workflow.stages.filter((s) => s.next.includes(alias)).map((s) => s.alias)
}

/** Every stage this one can be reached from. Pure. */
export function ancestorStages(workflow: SchemaWorkflow, alias: string): Set<string> {
  const found = new Set<string>()
  const visit = (at: string) => {
    for (const parent of incomingStages(workflow, at)) {
      if (found.has(parent)) continue
      found.add(parent)
      visit(parent)
    }
  }
  visit(alias)
  return found
}

/** Every stage reachable from this one, itself excluded. Pure. */
export function descendantStages(workflow: SchemaWorkflow, alias: string): Set<string> {
  const stages = byAlias(workflow)
  const found = new Set<string>()
  const visit = (at: string) => {
    for (const child of stages.get(at)?.next ?? []) {
      if (found.has(child)) continue
      found.add(child)
      visit(child)
    }
  }
  visit(alias)
  return found
}

/** Whether adding an arrow `from` → `to` would close a loop. Pure. */
export function wouldLoop(workflow: SchemaWorkflow, from: string, to: string): boolean {
  return from === to || descendantStages(workflow, to).has(from)
}

/** What is wrong with a workflow's graph, in words; empty when it is sound. Pure. */
export function workflowGraphProblems(
  workflow: SchemaWorkflow,
): Array<{ path: string; message: string }> {
  const problems: Array<{ path: string; message: string }> = []
  const seen = new Set<string>()
  workflow.stages.forEach((stage, i) => {
    if (seen.has(stage.alias))
      problems.push({ path: `stage[${i}].alias`, message: `"${stage.alias}" names two stages` })
    seen.add(stage.alias)
  })
  if (workflow.stages.length === 0)
    return [{ path: 'stage', message: 'a workflow needs at least one stage' }]
  workflow.stages.forEach((stage, i) => {
    for (const next of stage.next)
      if (!seen.has(next))
        problems.push({ path: `stage[${i}].next`, message: `there is no stage "${next}"` })
    if (stage.approvers.length === 0)
      problems.push({ path: `stage[${i}].approvers`, message: 'a stage needs an approver group' })
    if (
      typeof stage.required === 'number' &&
      (!Number.isInteger(stage.required) || stage.required < 1)
    )
      problems.push({ path: `stage[${i}].required`, message: 'a number of approvers is 1 or more' })
  })
  if (problems.length > 0) return problems

  // A loop first: the rest of the rules assume there is none.
  const state = new Map<string, 'visiting' | 'done'>()
  const stages = byAlias(workflow)
  let loop: string | undefined
  const visit = (alias: string): void => {
    if (loop) return
    state.set(alias, 'visiting')
    for (const next of stages.get(alias)?.next ?? []) {
      if (state.get(next) === 'visiting') loop = `${alias} → ${next}`
      else if (!state.has(next)) visit(next)
    }
    state.set(alias, 'done')
  }
  for (const stage of workflow.stages) if (!state.has(stage.alias)) visit(stage.alias)
  if (loop) return [{ path: 'stage', message: `the stages loop (${loop})` }]

  const starts = startStages(workflow)
  if (starts.length !== 1)
    problems.push({
      path: 'stage',
      message: `a workflow starts at one stage, and this one starts at ${starts.length}: ${starts.join(', ')}`,
    })
  workflow.stages.forEach((stage, i) => {
    if (stage.sendBack === SEND_BACK_TO_EDITOR) return
    if (!ancestorStages(workflow, stage.alias).has(stage.sendBack))
      problems.push({
        path: `stage[${i}].send-back`,
        message: `"${stage.alias}" can send back only to the editor or a stage before it, and "${stage.sendBack}" is not`,
      })
  })
  return problems
}

/** How many approvals a stage needs, given how many people its groups hold. Pure. */
export function approvalsNeeded(required: StageRequirement, members: number): number {
  const available = Math.max(members, 1)
  if (required === 'one') return 1
  if (required === 'all') return available
  if (required === 'majority') return Math.floor(available / 2) + 1
  // More than the groups hold could never be met; the groups are the ceiling.
  return Math.min(required, available)
}

/**
 * The stages that become waiting now that `approved` are done: every stage
 * whose arrows in all come from approved stages, not already reached. Pure.
 */
export function stagesNowWaiting(
  workflow: SchemaWorkflow,
  approved: ReadonlySet<string>,
  reached: ReadonlySet<string>,
): string[] {
  return workflow.stages
    .filter((stage) => !reached.has(stage.alias))
    .filter((stage) => {
      const from = incomingStages(workflow, stage.alias)
      return from.length > 0 && from.every((alias) => approved.has(alias))
    })
    .map((stage) => stage.alias)
}

/** Whether every last stage has approved, which publishes the page. Pure. */
export function workflowComplete(workflow: SchemaWorkflow, approved: ReadonlySet<string>): boolean {
  return workflow.stages.filter((s) => s.next.length === 0).every((s) => approved.has(s.alias))
}

/**
 * The workflow that covers a page: the nearest branch root among the page and
 * its ancestors (nearest first), and only then one naming its content type. Pure.
 */
export function workflowFor(
  workflows: readonly SchemaWorkflow[],
  chain: readonly string[],
  contentTypeAlias: string | undefined,
): SchemaWorkflow | undefined {
  const lower = (value: string) => value.toLowerCase()
  for (const key of [...chain].reverse()) {
    const found = workflows.find((w) => w.appliesTo.branches.some((b) => lower(b) === lower(key)))
    if (found) return found
  }
  if (!contentTypeAlias) return undefined
  return workflows.find((w) => w.appliesTo.contentTypes.includes(contentTypeAlias))
}
