/**
 * Story 091: the forms designer's workflow operations, which are pure, and the
 * file what they produce writes to.
 */
import { describe, expect, test } from 'bun:test'
import { parseForm, writeForm } from '@crombolo/schema'
import {
  addWorkflow,
  BUILT_IN_WORKFLOW_SETTINGS,
  describeProblemPath,
  removeWorkflow,
  setWorkflowName,
  setWorkflowSetting,
  setWorkflowTrigger,
  setWorkflowType,
  switchValue,
  uniqueWorkflowName,
  workflowSettings,
} from '../packages/backoffice-host/plugin/forms-workflows.js'

const base = () => ({
  alias: 'contactUs',
  name: 'Contact us',
  storeEntries: true,
  requiresApproval: false,
  honeypot: true,
  pages: [
    {
      groups: [
        {
          columns: 1,
          fields: [
            {
              alias: 'email',
              type: 'email',
              caption: 'Email',
              mandatory: false,
              sensitive: false,
              values: [],
              accept: [],
            },
          ],
        },
      ],
    },
  ],
  workflows: [] as {
    key?: string
    type: string
    name: string
    on: string
    settings: Record<string, unknown>
  }[],
})

describe('the workflow operations', () => {
  test('adding names each workflow uniquely, and leaves the form it was given alone', () => {
    const empty = base()
    const one = addWorkflow(empty, 'sendEmail', 'Send an e-mail')
    const two = addWorkflow(one, 'sendEmail', 'Send an e-mail')
    expect(empty.workflows).toEqual([])
    expect(two.workflows.map((workflow: { name: string }) => workflow.name)).toEqual([
      'Send an e-mail',
      'Send an e-mail 2',
    ])
    expect(two.workflows[0]).toMatchObject({ type: 'sendEmail', on: 'submit', settings: {} })
    expect(uniqueWorkflowName(two, 'send an e-mail')).toBe('send an e-mail 3')
  })

  test('a setting is written, and an empty one removed', () => {
    let form = addWorkflow(base(), 'sendEmail', 'Tell the team')
    form = setWorkflowSetting(form, 0, 'to', 'team@example.com')
    form = setWorkflowSetting(form, 0, 'template', 'emails/receipt')
    form = setWorkflowSetting(form, 0, 'template', '')
    form = setWorkflowSetting(form, 0, 'include-sensitive', true)
    expect(form.workflows[0]?.settings).toEqual({
      to: 'team@example.com',
      'include-sensitive': true,
    })
  })

  test('a switch writes nothing when it matches its default', () => {
    const offByDefault = { key: 'include-sensitive', kind: 'boolean' }
    const onByDefault = { key: 'include-standard-fields', kind: 'boolean', defaultValue: true }
    expect(switchValue(offByDefault, true)).toBe(true)
    expect(switchValue(offByDefault, false)).toBeUndefined()
    expect(switchValue(onByDefault, true)).toBeUndefined()
    expect(switchValue(onByDefault, false)).toBe(false)
  })

  test('changing the type drops the old settings; name, trigger and removal do what they say', () => {
    let form = addWorkflow(base(), 'sendEmail', 'Tell the team')
    form = setWorkflowSetting(form, 0, 'to', 'team@example.com')
    form = setWorkflowType(form, 0, 'sendToUrl')
    expect(form.workflows[0]).toMatchObject({ type: 'sendToUrl', settings: {} })
    form = setWorkflowName(form, 0, 'Tell the CRM')
    form = setWorkflowTrigger(form, 0, 'approve')
    expect(form.workflows[0]).toMatchObject({ name: 'Tell the CRM', on: 'approve' })
    expect(setWorkflowTrigger(form, 0, 'whenever').workflows[0]?.on).toBe('submit')
    expect(removeWorkflow(form, 0).workflows).toEqual([])
  })

  test('a setting the designer has no field for is kept as the file has it', () => {
    const form = base()
    form.workflows = [
      { type: 'sendEmail', name: 'w', on: 'submit', settings: { to: 'a@b.com', cc: 'c@d.com' } },
    ]
    expect(setWorkflowSetting(form, 0, 'subject', 'Hi').workflows[0]?.settings).toEqual({
      to: 'a@b.com',
      cc: 'c@d.com',
      subject: 'Hi',
    })
  })

  test('what Send email offers, and what a bundle type declares', () => {
    expect(BUILT_IN_WORKFLOW_SETTINGS.sendEmail.map((setting) => setting.key)).toEqual([
      'to',
      'subject',
      'reply-to',
      'template',
      'attach-uploads',
      'include-sensitive',
    ])
    const declared = [{ key: 'list', label: 'List', kind: 'text' }]
    expect(workflowSettings('crmHandoff', { settings: declared })).toBe(declared)
    expect(workflowSettings('crmHandoff', undefined)).toEqual([])
  })

  test('the file a designed workflow writes parses back strictly', () => {
    let form = addWorkflow(base(), 'sendEmail', 'Tell the team')
    for (const [key, value] of [
      ['to', 'team@example.com'],
      ['subject', 'New enquiry from {email}'],
      ['template', 'emails/receipt'],
      ['include-sensitive', true],
    ] as const)
      form = setWorkflowSetting(form, 0, key, value)
    const written = writeForm(form as never)
    expect(written).toContain('template = "emails/receipt"')
    const parsed = parseForm('schema/forms/contact-us.toml', written)
    expect(parsed.problems).toEqual([])
    expect(parsed.value?.workflows[0]?.settings).toEqual({
      to: 'team@example.com',
      subject: 'New enquiry from {email}',
      template: 'emails/receipt',
      'include-sensitive': true,
    })
  })
})

describe('where a problem is, in words', () => {
  const form = (() => {
    let made = addWorkflow(base(), 'sendEmail', 'Tell the team')
    made = addWorkflow(made, 'crmHandoff', 'Hand off')
    return made
  })()
  const types = new Map([['crmHandoff', { settings: [{ key: 'list', label: 'Mailing list' }] }]])

  test('a workflow setting is named by the workflow and the field the designer shows', () => {
    expect(describeProblemPath(form, 'workflow[0].settings.template')).toBe(
      'Tell the team: E-mail design',
    )
    expect(describeProblemPath(form, 'workflow[1].settings.list', types)).toBe(
      'Hand off: Mailing list',
    )
    expect(describeProblemPath(form, 'workflow[0].settings.body')).toBe(
      'Tell the team: Message text',
    )
    expect(describeProblemPath(form, 'workflow[0].name')).toBe('Tell the team: Name')
    expect(describeProblemPath(form, 'workflow[0].on')).toBe('Tell the team: When it runs')
    expect(describeProblemPath(form, 'workflow[1].settings')).toBe('Hand off')
  })

  test('anything else is left as the server wrote it', () => {
    expect(describeProblemPath(form, 'page.group.field[0].alias')).toBe('page.group.field[0].alias')
    expect(describeProblemPath(form, '')).toBe('')
  })
})
