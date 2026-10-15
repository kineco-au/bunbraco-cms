/**
 * Story 028: an approval workflow is an acyclic graph of stages, kept as a
 * TOML file. The graph rules and the file format, without a database.
 */
import { describe, expect, test } from 'bun:test'
import {
  approvalsNeeded,
  descendantStages,
  type SchemaWorkflow,
  stagesNowWaiting,
  startStages,
  workflowComplete,
  workflowFor,
  workflowGraphProblems,
  wouldLoop,
} from '@crombolo/core'
import { parseWorkflow, validateWorkflows, workflowVersion, writeWorkflow } from '@crombolo/schema'

const SIGN_OFF: SchemaWorkflow = {
  key: '4f0c2a7e-0000-4000-8000-000000000001',
  alias: 'policy-sign-off',
  name: 'Policy sign-off',
  appliesTo: { branches: ['8a1e0000-0000-4000-8000-000000000001'], contentTypes: ['policy'] },
  publishersMaySkip: false,
  onEdit: 'withdraw',
  selfApproval: 'refused',
  comments: 'on-send-back',
  unpublish: true,
  onChange: 'keep',
  stages: [
    {
      alias: 'legal',
      name: 'Legal',
      approvers: ['legal'],
      required: 'one',
      next: ['brand', 'compliance'],
      sendBack: 'editor',
      position: { x: 0, y: 0 },
    },
    {
      alias: 'brand',
      approvers: ['marketing'],
      required: 'majority',
      next: ['final'],
      sendBack: 'legal',
    },
    {
      alias: 'compliance',
      approvers: ['compliance'],
      required: 'all',
      next: ['final'],
      sendBack: 'editor',
    },
    {
      alias: 'final',
      approvers: ['directors'],
      required: 2,
      next: [],
      sendBack: 'legal',
      position: { x: 480, y: 0 },
    },
  ],
}

const stage = (alias: string, next: string[], sendBack = 'editor') => ({
  alias,
  approvers: ['g'],
  required: 'one' as const,
  next,
  sendBack,
})
const graph = (stages: SchemaWorkflow['stages']): SchemaWorkflow => ({ ...SIGN_OFF, stages })

describe('the graph', () => {
  test('a sound graph has no problems, and one start', () => {
    expect(workflowGraphProblems(SIGN_OFF)).toEqual([])
    expect(startStages(SIGN_OFF)).toEqual(['legal'])
    expect([...descendantStages(SIGN_OFF, 'legal')].sort()).toEqual([
      'brand',
      'compliance',
      'final',
    ])
  })

  test('a loop is refused, and an arrow that would make one is caught before it is drawn', () => {
    const looped = graph([stage('a', ['b']), stage('b', ['c']), stage('c', ['a'])])
    expect(workflowGraphProblems(looped)[0]?.message).toContain('loop')
    expect(wouldLoop(SIGN_OFF, 'final', 'legal')).toBe(true)
    expect(wouldLoop(SIGN_OFF, 'legal', 'final')).toBe(false)
    expect(wouldLoop(SIGN_OFF, 'brand', 'brand')).toBe(true)
  })

  test('two starts, an unknown stage, a stage with no approvers', () => {
    expect(workflowGraphProblems(graph([stage('a', []), stage('b', [])]))[0]?.message).toContain(
      'starts at one stage',
    )
    expect(workflowGraphProblems(graph([stage('a', ['nope'])]))[0]?.message).toContain(
      'no stage "nope"',
    )
    expect(
      workflowGraphProblems(graph([{ ...stage('a', []), approvers: [] }]))[0]?.message,
    ).toContain('approver group')
  })

  test('a send-back goes to the editor or to a stage before this one, never after or beside it', () => {
    const sideways = graph([stage('a', ['b', 'c']), stage('b', [], 'c'), stage('c', [])])
    expect(workflowGraphProblems(sideways)[0]?.message).toContain('"b" can send back only')
  })

  test('parallel stages, then a join that waits for all of them', () => {
    expect(stagesNowWaiting(SIGN_OFF, new Set(['legal']), new Set(['legal'])).sort()).toEqual([
      'brand',
      'compliance',
    ])
    const reached = new Set(['legal', 'brand', 'compliance'])
    expect(stagesNowWaiting(SIGN_OFF, new Set(['legal', 'brand']), reached)).toEqual([])
    expect(stagesNowWaiting(SIGN_OFF, new Set(['legal', 'brand', 'compliance']), reached)).toEqual([
      'final',
    ])
    expect(workflowComplete(SIGN_OFF, new Set(['legal', 'brand', 'compliance']))).toBe(false)
    expect(workflowComplete(SIGN_OFF, new Set(['legal', 'brand', 'compliance', 'final']))).toBe(
      true,
    )
  })

  test('how many must approve, against how many the groups hold', () => {
    expect(approvalsNeeded('one', 5)).toBe(1)
    expect(approvalsNeeded('majority', 5)).toBe(3)
    expect(approvalsNeeded('majority', 4)).toBe(3)
    expect(approvalsNeeded('all', 4)).toBe(4)
    expect(approvalsNeeded(2, 5)).toBe(2)
    // More than the groups hold could never be met: the groups are the ceiling.
    expect(approvalsNeeded(3, 2)).toBe(2)
    expect(approvalsNeeded('all', 0)).toBe(1)
  })

  test('the nearest branch wins, then the content type', () => {
    const near = { ...SIGN_OFF, alias: 'near', appliesTo: { branches: ['b'], contentTypes: [] } }
    const far = { ...SIGN_OFF, alias: 'far', appliesTo: { branches: ['a'], contentTypes: [] } }
    const typed = {
      ...SIGN_OFF,
      alias: 'typed',
      appliesTo: { branches: [], contentTypes: ['policy'] },
    }
    const all = [typed, far, near]
    expect(workflowFor(all, ['a', 'b', 'c'], 'policy')?.alias).toBe('near')
    expect(workflowFor(all, ['a', 'x'], 'policy')?.alias).toBe('far')
    expect(workflowFor(all, ['z'], 'policy')?.alias).toBe('typed')
    expect(workflowFor(all, ['z'], 'article')).toBeUndefined()
  })
})

describe('the file', () => {
  test('round trips, and is canonical', () => {
    const text = writeWorkflow(SIGN_OFF)
    const parsed = parseWorkflow('schema/workflows/policy-sign-off.toml', text)
    expect(parsed.problems).toEqual([])
    expect(parsed.value).toEqual(SIGN_OFF)
    expect(writeWorkflow(parsed.value as SchemaWorkflow)).toBe(text)
  })

  test('is strict: an unknown key, a bad choice and a loop are each named', () => {
    const problems = (source: string) =>
      parseWorkflow('w.toml', source).problems.map((p) => `${p.path}: ${p.message}`)
    const base = writeWorkflow(SIGN_OFF)
    expect(problems(base.replace('unpublish = true', 'unpublish = true\nskip = 1'))[0]).toContain(
      'workflow.skip',
    )
    expect(problems(base.replace('on-edit = "withdraw"', 'on-edit = "sometimes"'))[0]).toContain(
      'workflow.on-edit',
    )
    expect(problems(base.replace('next = []', 'next = ["legal"]')).join(' ')).toContain('loop')
  })

  test('defaults are the cautious ones', () => {
    const parsed = parseWorkflow(
      'w.toml',
      '[workflow]\nalias = "x"\nname = "X"\n\n[[stage]]\nalias = "a"\napprovers = ["g"]\n',
    )
    expect(parsed.value).toMatchObject({
      publishersMaySkip: true,
      onEdit: 'withdraw',
      selfApproval: 'refused',
      comments: 'optional',
      unpublish: false,
      onChange: 'keep',
      stages: [{ required: 'one', next: [], sendBack: 'editor' }],
    })
  })

  test('moving a box on the canvas is not a new version; changing a rule is', () => {
    const moved = {
      ...SIGN_OFF,
      stages: SIGN_OFF.stages.map((s) => ({ ...s, position: { x: 9, y: 9 } })),
    }
    expect(workflowVersion(moved)).toBe(workflowVersion(SIGN_OFF))
    expect(workflowVersion({ ...SIGN_OFF, onEdit: 'lock' })).not.toBe(workflowVersion(SIGN_OFF))
  })

  test('two workflows may not claim the same branch or content type, or a type that is not there', () => {
    const other = { ...SIGN_OFF, alias: 'other', key: undefined }
    const messages = validateWorkflows([SIGN_OFF, other], new Set(['article'])).map(
      (p) => p.message,
    )
    expect(messages).toContain(
      'the branch 8a1e0000-0000-4000-8000-000000000001 is covered by "policy-sign-off" already',
    )
    expect(messages).toContain('the content type "policy" is covered by "policy-sign-off" already')
    expect(messages).toContain('there is no content type "policy"')
  })
})
