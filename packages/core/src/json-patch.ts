/**
 * JSON Patch with Umbraco's filter segments: `replace`, `add` and `remove` over
 * paths like `/values[alias=title,culture=null,segment=null]/value`. Operations
 * apply in order to a copy; any failure fails the lot. docs/api-contract.md.
 */

export interface PatchOperation {
  op: string
  path: string
  value?: unknown
}

export type PatchResult = { ok: true; value: unknown } | { ok: false; reason: string }

type Step =
  | { kind: 'key'; key: string }
  | { kind: 'append' }
  | { kind: 'filter'; conditions: Array<[string, string | null]> }

class PatchError extends Error {}

const unescapeSegment = (segment: string) => segment.replace(/~1/g, '/').replace(/~0/g, '~')

function parseFilter(body: string, path: string): Step {
  const conditions = body.split(',').map((pair): [string, string | null] => {
    const at = pair.indexOf('=')
    if (at <= 0) throw new PatchError(`The filter "[${body}]" in "${path}" needs key=value pairs.`)
    const value = unescapeSegment(pair.slice(at + 1))
    return [unescapeSegment(pair.slice(0, at)), value.toLowerCase() === 'null' ? null : value]
  })
  return { kind: 'filter', conditions }
}

export function parsePatchPath(path: string): Step[] {
  if (!path.startsWith('/') || path.length < 2)
    throw new PatchError(`"${path}" is not a path: it must start with "/" and name something.`)
  const steps: Step[] = []
  for (const segment of path.slice(1).split('/')) {
    const open = segment.indexOf('[')
    if (open === -1) {
      steps.push(
        segment === '-' ? { kind: 'append' } : { kind: 'key', key: unescapeSegment(segment) },
      )
      continue
    }
    if (!segment.endsWith(']')) throw new PatchError(`The filter in "${path}" is not closed.`)
    if (open > 0) steps.push({ kind: 'key', key: unescapeSegment(segment.slice(0, open)) })
    steps.push(parseFilter(segment.slice(open + 1, -1), path))
  }
  steps.forEach((step, index) => {
    if (step.kind === 'append' && index !== steps.length - 1)
      throw new PatchError(`"-" may only end a path, in "${path}".`)
  })
  return steps
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function matchIndex(array: unknown[], step: Extract<Step, { kind: 'filter' }>, path: string) {
  const index = array.findIndex(
    (element) =>
      isRecord(element) &&
      step.conditions.every(([key, value]) =>
        value === null
          ? element[key] === undefined || element[key] === null
          : element[key] === value,
      ),
  )
  if (index === -1) throw new PatchError(`Nothing in the list matches the filter in "${path}".`)
  return index
}

function arrayIndex(array: unknown[], key: string, path: string, allowEnd: boolean): number {
  if (!/^(0|[1-9]\d*)$/.test(key))
    throw new PatchError(`"${key}" is not a list position, in "${path}".`)
  const index = Number(key)
  if (index > array.length || (!allowEnd && index === array.length))
    throw new PatchError(`Position ${index} is past the end of the list, in "${path}".`)
  return index
}

function child(container: unknown, step: Step, path: string): unknown {
  if (Array.isArray(container)) {
    if (step.kind === 'filter') return container[matchIndex(container, step, path)]
    if (step.kind === 'key') return container[arrayIndex(container, step.key, path, false)]
  } else if (isRecord(container) && step.kind === 'key') {
    if (!(step.key in container)) throw new PatchError(`There is no "${step.key}" in "${path}".`)
    return container[step.key]
  }
  throw new PatchError(`"${path}" does not lead anywhere in the document.`)
}

function applyOne(root: unknown, operation: PatchOperation): unknown {
  const { op, path } = operation
  if (op !== 'replace' && op !== 'add' && op !== 'remove')
    throw new PatchError(
      `"${op}" is not an operation this endpoint supports: use replace, add or remove.`,
    )
  if (op !== 'remove' && !('value' in operation))
    throw new PatchError(`"${op}" at "${path}" needs a value.`)
  const steps = parsePatchPath(path)
  const last = steps[steps.length - 1] as Step
  if (last.kind === 'append' && op !== 'add')
    throw new PatchError(`"-" appends, so only add may use it, in "${path}".`)
  let parent = root
  for (const step of steps.slice(0, -1)) parent = child(parent, step, path)

  if (Array.isArray(parent)) {
    const index =
      last.kind === 'append'
        ? parent.length
        : last.kind === 'filter'
          ? matchIndex(parent, last, path)
          : arrayIndex(parent, last.key, path, op === 'add')
    if (op === 'remove') parent.splice(index, 1)
    else if (op === 'add' && last.kind !== 'filter') parent.splice(index, 0, operation.value)
    else parent[index] = operation.value
    return root
  }
  if (isRecord(parent) && last.kind === 'key') {
    if (op === 'remove') {
      if (!(last.key in parent))
        throw new PatchError(`There is no "${last.key}" to remove, in "${path}".`)
      delete parent[last.key]
    } else parent[last.key] = operation.value
    return root
  }
  throw new PatchError(`"${path}" does not lead anywhere in the document.`)
}

export function applyJsonPatch(
  document: unknown,
  operations: readonly PatchOperation[],
): PatchResult {
  try {
    let value = structuredClone(document)
    for (const operation of operations) value = applyOne(value, operation)
    return { ok: true, value }
  } catch (error) {
    if (error instanceof PatchError) return { ok: false, reason: error.message }
    throw error
  }
}
