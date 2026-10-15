/**
 * `resolutions.json`, beside the bundle it answers.
 *
 * A decision is committed with the bundle rather than retyped per environment,
 * for the reason `packaging-and-upgrades.md` gives for site-authored value
 * migrations: the same fix-up should not be worked out again in test and then
 * again in production, each time against more content.
 *
 * It holds resolutions **by node key**, so a path that means something
 * different in the next environment cannot change what was decided. Each node's
 * answers are `"*"` for the whole node and `"<alias>"` or `"<alias>@<culture>"`
 * for one property.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isResolution,
  type NodeResolutions,
  nodeResolutionProblems,
  type Resolution,
  WHOLE_NODE,
} from './check.ts'

export const RESOLUTIONS_FILE = 'resolutions.json'

export interface ResolutionsFile {
  /** The bundle these answers belong to; a mismatch is reported, not applied. */
  bundleId: string
  /** Where the bundle was placed, when it was re-rooted. */
  under?: string | null
  all?: Resolution | null
  byNode: Record<string, NodeResolutions>
}

/**
 * `--resolve` values into answers by node: `<key>=<choice>` answers the node,
 * `<key>/<alias>[@<culture>]=<choice>` one property. Pure; problems are named.
 */
export function parseResolveFlags(pairs: readonly string[]): {
  byNode: Record<string, NodeResolutions>
  problems: string[]
} {
  const byNode: Record<string, Record<string, Resolution>> = {}
  const problems: string[] = []
  for (const pair of pairs) {
    const eq = pair.lastIndexOf('=')
    if (eq < 0) {
      problems.push(`--resolve wants <key>=<choice> or <key>/<property>=<choice>, not "${pair}"`)
      continue
    }
    const target = pair.slice(0, eq)
    const choice = pair.slice(eq + 1)
    const slash = target.indexOf('/')
    const key = slash < 0 ? target : target.slice(0, slash)
    const handle = slash < 0 ? WHOLE_NODE : target.slice(slash + 1)
    const found = nodeResolutionProblems(key, { [handle]: choice })
    if (found.length > 0 || !handle) {
      problems.push(...(found.length > 0 ? found : [`--resolve "${pair}" names no property`]))
      continue
    }
    byNode[key] = { ...(byNode[key] ?? {}), [handle]: choice as Resolution }
  }
  return { byNode, problems }
}

/** Answers laid over others, node by node and property by property. Pure. */
export function mergeResolutions(
  under: Readonly<Record<string, NodeResolutions>>,
  over: Readonly<Record<string, NodeResolutions>>,
): Record<string, NodeResolutions> {
  const out: Record<string, NodeResolutions> = { ...under }
  for (const [key, answers] of Object.entries(over)) out[key] = { ...(out[key] ?? {}), ...answers }
  return out
}

export function writeResolutions(file: ResolutionsFile): string {
  return `${JSON.stringify(
    {
      bundleId: file.bundleId,
      under: file.under ?? null,
      all: file.all ?? null,
      byNode: Object.fromEntries(
        Object.entries(file.byNode)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, answers]) => [
            key,
            Object.fromEntries(Object.entries(answers).sort(([a], [b]) => a.localeCompare(b))),
          ]),
      ),
    },
    null,
    2,
  )}\n`
}

export interface LoadedResolutions {
  file: ResolutionsFile | undefined
  problems: string[]
}

/** Reads `resolutions.json` from a bundle directory, if it has one. */
export function loadResolutions(dir: string, bundleId: string): LoadedResolutions {
  const path = join(dir, RESOLUTIONS_FILE)
  if (!existsSync(path)) return { file: undefined, problems: [] }
  const problems: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return {
      file: undefined,
      problems: [`${RESOLUTIONS_FILE}: not JSON: ${(error as Error).message}`],
    }
  }
  if (typeof raw !== 'object' || raw === null)
    return { file: undefined, problems: [`${RESOLUTIONS_FILE}: not an object`] }
  const record = raw as Record<string, unknown>

  // Answers to a different bundle are not answers to this one. Silently
  // applying them would be worse than ignoring them.
  const found = typeof record.bundleId === 'string' ? record.bundleId : ''
  if (found && found !== bundleId)
    problems.push(`${RESOLUTIONS_FILE}: answers bundle ${found}, not ${bundleId} — ignoring it`)

  const byNode: Record<string, NodeResolutions> = {}
  const entries = typeof record.byNode === 'object' && record.byNode !== null ? record.byNode : {}
  for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      problems.push(
        `${RESOLUTIONS_FILE}: "${key}" must map "*" or a property to a resolution, as { "*": "take-bundle" }`,
      )
      continue
    }
    const found = nodeResolutionProblems(key, value as Record<string, unknown>)
    if (found.length > 0)
      problems.push(...found.map((message) => `${RESOLUTIONS_FILE}: ${message}`))
    else byNode[key] = value as Record<string, Resolution>
  }
  const all = typeof record.all === 'string' && isResolution(record.all) ? record.all : null

  if (found && found !== bundleId) return { file: undefined, problems }
  return {
    file: {
      bundleId: found || bundleId,
      under: typeof record.under === 'string' ? record.under : null,
      all,
      byNode,
    },
    problems,
  }
}
