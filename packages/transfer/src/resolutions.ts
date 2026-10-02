/**
 * `resolutions.json`, beside the bundle it answers.
 *
 * A decision is committed with the bundle rather than retyped per environment,
 * for the reason `10-packaging-and-upgrades.md` gives for site-authored value
 * migrations: the same fix-up should not be worked out again in test and then
 * again in production, each time against more content.
 *
 * It holds resolutions **by node key**, so a path that means something
 * different in the next environment cannot change what was decided.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isResolution, type Resolution } from './check.ts'

export const RESOLUTIONS_FILE = 'resolutions.json'

export interface ResolutionsFile {
  /** The bundle these answers belong to; a mismatch is reported, not applied. */
  bundleId: string
  /** Where the bundle was placed, when it was re-rooted. */
  under?: string | null
  all?: Resolution | null
  byNode: Record<string, Resolution>
}

export function writeResolutions(file: ResolutionsFile): string {
  return `${JSON.stringify(
    {
      bundleId: file.bundleId,
      under: file.under ?? null,
      all: file.all ?? null,
      byNode: Object.fromEntries(
        Object.entries(file.byNode).sort(([a], [b]) => a.localeCompare(b)),
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

  const byNode: Record<string, Resolution> = {}
  const entries = typeof record.byNode === 'object' && record.byNode !== null ? record.byNode : {}
  for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
    if (typeof value === 'string' && isResolution(value)) byNode[key] = value
    else problems.push(`${RESOLUTIONS_FILE}: "${key}" has no usable resolution`)
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
