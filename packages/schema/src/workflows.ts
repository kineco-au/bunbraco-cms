/**
 * `schema/workflows/*.toml` — approval workflows (story 028). TOML in and out,
 * strict as the type parser is, and canonical on the way out so the designer
 * writes a file a person reads in a diff: `parseWorkflow(writeWorkflow(x))`
 * equals `x`. The graph rules are `@crombolo/core`'s. `docs/workflows.md`.
 */
import {
  type SchemaWorkflow,
  SEND_BACK_TO_EDITOR,
  type StageRequirement,
  WORKFLOW_COMMENTS,
  WORKFLOW_ON_CHANGE,
  WORKFLOW_ON_EDIT,
  WORKFLOW_SELF_APPROVAL,
  type WorkflowStage,
  workflowGraphProblems,
} from '@crombolo/core'
import type { SchemaProblem } from './model.ts'
import { type ParseResult, Reader, type Toml, toml } from './reader.ts'

const WORKFLOW_KEYS = [
  'key',
  'alias',
  'name',
  'applies-to',
  'publishers-may-skip',
  'on-edit',
  'self-approval',
  'comments',
  'unpublish',
  'on-change',
] as const
const APPLIES_KEYS = ['branches', 'content-types'] as const
const STAGE_KEYS = [
  'alias',
  'name',
  'approvers',
  'required',
  'next',
  'send-back',
  'position',
] as const
const POSITION_KEYS = ['x', 'y'] as const

function choice<T extends string>(
  r: Reader,
  t: Toml,
  key: string,
  path: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = r.str(t, key, path)
  if (value === undefined) return fallback
  if (!(allowed as readonly string[]).includes(value)) {
    r.problem(`${path}.${key}`, `expected one of ${allowed.join(', ')}`)
    return fallback
  }
  return value as T
}

function requirement(r: Reader, t: Toml, path: string): StageRequirement {
  const value = t.required
  if (value === undefined) return 'one'
  if (typeof value === 'number') return value
  if (value === 'one' || value === 'majority' || value === 'all') return value
  r.problem(`${path}.required`, 'expected one, majority, all, or a number')
  return 'one'
}

function stage(r: Reader, t: Toml, path: string): WorkflowStage {
  r.unknown(t, STAGE_KEYS, path)
  let position: WorkflowStage['position']
  if (t.position !== undefined) {
    const p = r.table(t.position, `${path}.position`)
    if (p) {
      r.unknown(p, POSITION_KEYS, `${path}.position`)
      position = {
        x: r.num(p, 'x', `${path}.position`) ?? 0,
        y: r.num(p, 'y', `${path}.position`) ?? 0,
      }
    }
  }
  return {
    alias: r.str(t, 'alias', path, true) ?? '',
    ...(r.str(t, 'name', path) !== undefined ? { name: r.str(t, 'name', path) } : {}),
    approvers: r.strs(t, 'approvers', path),
    required: requirement(r, t, path),
    next: r.strs(t, 'next', path),
    sendBack: r.str(t, 'send-back', path) ?? SEND_BACK_TO_EDITOR,
    ...(position ? { position } : {}),
  }
}

export function parseWorkflow(file: string, source: string): ParseResult<SchemaWorkflow> {
  const r = new Reader(file)
  const root = toml(source, r)
  if (!root) return { value: undefined, problems: r.problems }
  r.unknown(root, ['workflow', 'stage'], '')
  const t = r.table(root.workflow, 'workflow')
  if (!t) {
    r.problem('workflow', 'a [workflow] table is required')
    return { value: undefined, problems: r.problems }
  }
  const path = 'workflow'
  r.unknown(t, WORKFLOW_KEYS, path)
  let appliesTo = { branches: [] as string[], contentTypes: [] as string[] }
  if (t['applies-to'] !== undefined) {
    const a = r.table(t['applies-to'], `${path}.applies-to`)
    if (a) {
      r.unknown(a, APPLIES_KEYS, `${path}.applies-to`)
      appliesTo = {
        branches: r.strs(a, 'branches', `${path}.applies-to`).map((k) => k.toLowerCase()),
        contentTypes: r.strs(a, 'content-types', `${path}.applies-to`),
      }
    }
  }
  const value: SchemaWorkflow = {
    ...(r.str(t, 'key', path) !== undefined ? { key: r.str(t, 'key', path) } : {}),
    alias: r.str(t, 'alias', path, true) ?? '',
    name: r.str(t, 'name', path, true) ?? '',
    appliesTo,
    publishersMaySkip: r.bool(t, 'publishers-may-skip', path, true),
    onEdit: choice(r, t, 'on-edit', path, WORKFLOW_ON_EDIT, 'withdraw'),
    selfApproval: choice(r, t, 'self-approval', path, WORKFLOW_SELF_APPROVAL, 'refused'),
    comments: choice(r, t, 'comments', path, WORKFLOW_COMMENTS, 'optional'),
    unpublish: r.bool(t, 'unpublish', path, false),
    onChange: choice(r, t, 'on-change', path, WORKFLOW_ON_CHANGE, 'keep'),
    stages: r.tables(root.stage, 'stage').map((s, i) => stage(r, s, `stage[${i}]`)),
  }
  if (r.problems.length === 0)
    for (const problem of workflowGraphProblems(value)) r.problem(problem.path, problem.message)
  return { value: r.problems.length === 0 ? value : undefined, problems: r.problems }
}

const str = (value: string) => JSON.stringify(value)
const list = (values: readonly string[]) => `[${values.map(str).join(', ')}]`

/** A workflow as canonical TOML: a fixed key order, defaults written out. */
export function writeWorkflow(workflow: SchemaWorkflow): string {
  const out = ['[workflow]']
  if (workflow.key) out.push(`key = ${str(workflow.key)}`)
  out.push(`alias = ${str(workflow.alias)}`, `name = ${str(workflow.name)}`)
  out.push(
    `applies-to = { branches = ${list(workflow.appliesTo.branches)}, content-types = ${list(workflow.appliesTo.contentTypes)} }`,
    `publishers-may-skip = ${workflow.publishersMaySkip}`,
    `on-edit = ${str(workflow.onEdit)}`,
    `self-approval = ${str(workflow.selfApproval)}`,
    `comments = ${str(workflow.comments)}`,
    `unpublish = ${workflow.unpublish}`,
    `on-change = ${str(workflow.onChange)}`,
  )
  for (const s of workflow.stages) {
    out.push('', '[[stage]]', `alias = ${str(s.alias)}`)
    if (s.name !== undefined) out.push(`name = ${str(s.name)}`)
    out.push(
      `approvers = ${list(s.approvers)}`,
      `required = ${typeof s.required === 'number' ? s.required : str(s.required)}`,
      `next = ${list(s.next)}`,
      `send-back = ${str(s.sendBack)}`,
    )
    if (s.position) out.push(`position = { x = ${s.position.x}, y = ${s.position.y} }`)
  }
  return `${out.join('\n')}\n`
}

/**
 * What the set of workflows gets wrong together: two with the same alias, or
 * two claiming the same branch or content type, or naming a content type the
 * schema does not have. Pure.
 */
export function validateWorkflows(
  workflows: readonly SchemaWorkflow[],
  contentTypeAliases: ReadonlySet<string>,
): SchemaProblem[] {
  const problems: SchemaProblem[] = []
  const file = (w: SchemaWorkflow) => `schema/workflows/${w.alias}.toml`
  const aliases = new Map<string, string>()
  const branches = new Map<string, string>()
  const types = new Map<string, string>()
  for (const w of workflows) {
    if (aliases.has(w.alias))
      problems.push({
        file: file(w),
        path: 'workflow.alias',
        message: `two workflows are called "${w.alias}"`,
      })
    aliases.set(w.alias, w.alias)
    for (const branch of w.appliesTo.branches) {
      const other = branches.get(branch)
      if (other)
        problems.push({
          file: file(w),
          path: 'workflow.applies-to.branches',
          message: `the branch ${branch} is covered by "${other}" already`,
        })
      branches.set(branch, w.alias)
    }
    for (const type of w.appliesTo.contentTypes) {
      const other = types.get(type)
      if (other)
        problems.push({
          file: file(w),
          path: 'workflow.applies-to.content-types',
          message: `the content type "${type}" is covered by "${other}" already`,
        })
      types.set(type, w.alias)
      if (!contentTypeAliases.has(type))
        problems.push({
          file: file(w),
          path: 'workflow.applies-to.content-types',
          message: `there is no content type "${type}"`,
        })
    }
  }
  return problems
}

/**
 * A workflow's version: a hash of its canonical file, which a request remembers.
 * Where the designer drew a stage is left out, so moving a box is not a change. Pure.
 */
export function workflowVersion(workflow: SchemaWorkflow): string {
  const meaning = {
    ...workflow,
    stages: workflow.stages.map(({ position: _position, ...stage }) => stage),
  }
  return new Bun.CryptoHasher('sha256').update(writeWorkflow(meaning)).digest('hex').slice(0, 16)
}
