/**
 * The forms designer's workflow operations: adding, retyping and removing a
 * form's workflows, and what each built-in type asks for. Pure, so each is
 * tested on its own (tests/forms-designer-workflows.test.ts).
 *
 * Every operation returns a new form. A setting the designer draws no field for
 * (`cc`, `body`, `map` and the rest) is kept as the file has it.
 */

/**
 * The settings the designer offers for the built-in types, in the shape a
 * bundle's type declares them. `design` is the e-mail design picker.
 */
export const BUILT_IN_WORKFLOW_SETTINGS = {
  sendEmail: [
    {
      key: 'to',
      label: 'Send to',
      kind: 'text',
      required: true,
      description:
        'One or more addresses, separated by commas. An alias in braces, such as {email}, puts in that answer.',
    },
    { key: 'subject', label: 'Subject', kind: 'text', required: true },
    { key: 'reply-to', label: 'Reply to', kind: 'text' },
    {
      key: 'template',
      label: 'E-mail design',
      kind: 'design',
      description: 'Standard lists each question with its answer.',
    },
    { key: 'attach-uploads', label: 'Attach uploaded files', kind: 'boolean' },
    {
      key: 'include-sensitive',
      label: 'Include sensitive answers',
      kind: 'boolean',
      description: 'Left off, answers to fields marked sensitive are not sent.',
    },
  ],
  saveAsContent: [
    { key: 'content-type', label: 'Document type alias', kind: 'text', required: true },
    {
      key: 'parent',
      label: 'Create under',
      kind: 'text',
      required: true,
      description: "The parent page's key, or root for the top of the tree.",
    },
    { key: 'name-field', label: 'Name it from the field', kind: 'text' },
    { key: 'publish', label: 'Publish straight away', kind: 'boolean' },
  ],
  sendToUrl: [
    { key: 'url', label: 'Address', kind: 'text', required: true },
    {
      key: 'include-standard-fields',
      label: "Include the form's name and when it was sent",
      kind: 'boolean',
      defaultValue: true,
    },
  ],
}

/**
 * What a switch writes: nothing when it matches the default, so a flag that is
 * off by default is absent rather than `false`, and one on by default the reverse.
 */
export const switchValue = (setting, checked) =>
  checked === (setting.defaultValue === true) ? undefined : checked

/** The fields to draw for a workflow type: the built-in table, or what a bundle declares. */
export const workflowSettings = (type, info) =>
  BUILT_IN_WORKFLOW_SETTINGS[type] ?? info?.settings ?? []

/** A name no other workflow on the form has, from the type's label. */
export function uniqueWorkflowName(form, label) {
  const taken = new Set((form.workflows ?? []).map((workflow) => workflow.name.toLowerCase()))
  if (!taken.has(label.toLowerCase())) return label
  for (let n = 2; ; n++) if (!taken.has(`${label} ${n}`.toLowerCase())) return `${label} ${n}`
}

export function addWorkflow(form, type, label) {
  const workflow = {
    key: crypto.randomUUID(),
    type,
    name: uniqueWorkflowName(form, label),
    on: 'submit',
    settings: {},
  }
  return { ...form, workflows: [...(form.workflows ?? []), workflow] }
}

export function removeWorkflow(form, index) {
  return { ...form, workflows: form.workflows.filter((_, at) => at !== index) }
}

const replace = (form, index, change) => ({
  ...form,
  workflows: form.workflows.map((workflow, at) =>
    at === index ? { ...workflow, ...change(workflow) } : workflow,
  ),
})

/** A new type takes none of the old one's settings: they would be refused as unknown. */
export const setWorkflowType = (form, index, type) =>
  replace(form, index, () => ({ type, settings: {} }))

export const setWorkflowName = (form, index, name) => replace(form, index, () => ({ name }))

export const setWorkflowTrigger = (form, index, on) =>
  replace(form, index, () => ({ on: on === 'approve' ? 'approve' : 'submit' }))

/** An empty text or `undefined` removes the setting, so the file stays as short as it can. */
export const setWorkflowSetting = (form, index, key, value) =>
  replace(form, index, (workflow) => {
    const settings = { ...workflow.settings }
    if (value === undefined || value === '') delete settings[key]
    else settings[key] = value
    return { settings }
  })

/** Settings only the file sets, named as a person would say them when one is refused. */
const FILE_ONLY_LABELS = {
  body: 'Message text',
  cc: 'Copy to',
  bcc: 'Blind copy to',
  from: 'Send from',
}

/**
 * Where a problem the server found is, in words: "Tell the team: E-mail design"
 * for `workflow[0].settings.template`. A path elsewhere in the form is left as
 * it is.
 */
export function describeProblemPath(form, path, types = new Map()) {
  const found = /^workflow\[(\d+)\](?:\.settings(?:\.([\w-]+))?|\.(name|on))?/.exec(path ?? '')
  if (!found) return path
  const index = Number(found[1])
  const workflow = form.workflows?.[index]
  const name = workflow?.name || `Workflow ${index + 1}`
  if (found[3] === 'name') return `${name}: Name`
  if (found[3] === 'on') return `${name}: When it runs`
  if (!found[2]) return name
  const setting = workflowSettings(workflow?.type, types.get(workflow?.type)).find(
    (candidate) => candidate.key === found[2],
  )
  return `${name}: ${setting?.label ?? FILE_ONLY_LABELS[found[2]] ?? found[2]}`
}
