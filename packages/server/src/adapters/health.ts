/**
 * The diagnostics port: health checks for what actually goes wrong on a site,
 * the troubleshooting report and the upgrade check. docs/diagnostics.md.
 */
import type { DiagnosticsPort, HealthCheckGroup, HealthCheckResult } from '@crombolo/api-management'
import {
  compareStates,
  cromboloPlan,
  currentSchemaState,
  type Db,
  liveNodes,
  type NodeSchemaState,
  pendingMigrations,
} from '@crombolo/data'
import { BundleConfigurationError, bundleChainsFor, pendingBundleSteps } from '../bundle-tables.ts'
import { type CromboloConfig, describeDatabase, VERSION } from '../config.ts'
import { type EmailPort, emailAvailability } from '../email.ts'
import type { MediaStore } from '../media-store.ts'
import { backofficeVersion } from '../status.ts'

export const UPGRADE_PACKAGE = '@crombolo/crombolo'

/** How recently a node must have polled to count as part of the cluster. */
const LIVE_WITHIN_MS = 60_000

const CHECKS = {
  database: { id: '6f1d4a8e-0047-4c1a-9e7d-000000000001', name: 'Database connection' },
  migrations: { id: '6f1d4a8e-0047-4c1a-9e7d-000000000002', name: 'Database upgrades' },
  media: { id: '6f1d4a8e-0047-4c1a-9e7d-000000000003', name: 'Media storage' },
  email: { id: '6f1d4a8e-0047-4c1a-9e7d-000000000004', name: 'E-mail delivery' },
  nodes: { id: '6f1d4a8e-0047-4c1a-9e7d-000000000005', name: 'Servers' },
} as const

const GROUPS: HealthCheckGroup[] = [
  {
    name: 'Database',
    checks: [
      { ...CHECKS.database, description: 'Whether the database answers, and which one it is.' },
      {
        ...CHECKS.migrations,
        description: 'Whether the database is up to date with this release and its schema files.',
      },
    ],
  },
  {
    name: 'Media',
    checks: [{ ...CHECKS.media, description: 'Whether uploaded files can be written and read.' }],
  },
  {
    name: 'E-mail',
    checks: [{ ...CHECKS.email, description: 'Whether this site can send e-mail.' }],
  },
  {
    name: 'Servers',
    checks: [
      {
        ...CHECKS.nodes,
        description: 'The servers running this site, and whether they run the same release.',
      },
    ],
  },
]

export interface HealthCheckOptions {
  config: CromboloConfig
  db: Db
  media: MediaStore
  email?: EmailPort
  /** What this node deploys at; read from the database's own state when omitted. */
  nodeState?: NodeSchemaState
  fetch?: typeof fetch
  now?: () => Date
}

const result = (
  resultType: HealthCheckResult['resultType'],
  message: string,
): HealthCheckResult => ({ resultType, message })

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** `0.13.0` against `0.12.0`: which part moved, or None when the first is not newer. */
export function upgradeType(latest: string, current: string): 'None' | 'Patch' | 'Minor' | 'Major' {
  const parts = (value: string) =>
    (value.split('-')[0] ?? '').split('.').map((part) => Number(part) || 0)
  const [a, b] = [parts(latest), parts(current)]
  for (const [index, type] of (['Major', 'Minor', 'Patch'] as const).entries()) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference > 0) return type
    if (difference < 0) return 'None'
  }
  return 'None'
}

function ago(then: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000))
  return seconds < 2 ? 'just now' : `${seconds} seconds ago`
}

export function createDiagnosticsPort(options: HealthCheckOptions): DiagnosticsPort {
  const { config, db, media } = options
  const now = options.now ?? (() => new Date())
  const call = options.fetch ?? fetch
  let checked:
    | { at: number; answer: Awaited<ReturnType<DiagnosticsPort['upgradeCheck']>> }
    | undefined

  async function database(): Promise<HealthCheckResult[]> {
    const dialect = db.dialect.name === 'postgres' ? 'PostgreSQL' : 'SQLite'
    try {
      await db.query('SELECT 1 AS ok')
      return [result('Success', `${dialect} is answering (${describeDatabase(config)}).`)]
    } catch (error) {
      return [result('Error', `${dialect} is not answering: ${failure(error)}`)]
    }
  }

  async function migrations(): Promise<HealthCheckResult[]> {
    const results: HealthCheckResult[] = []
    try {
      const pending = await pendingMigrations(db, cromboloPlan)
      results.push(
        pending.length === 0
          ? result('Success', `The database is up to date with Crombolo ${VERSION}.`)
          : result(
              'Error',
              `${pending.length} database upgrade(s) for Crombolo ${VERSION} have not run yet: ${pending.map((m) => m.name).join(', ')}. Run \`crombolo upgrade\`.`,
            ),
      )
      for (const bundle of await pendingBundleSteps(db, bundleChainsFor(config)))
        if (bundle.pending.length > 0)
          results.push(
            result(
              'Error',
              `The bundle "${bundle.name}" has ${bundle.pending.length} upgrade step(s) that have not run yet. Run \`crombolo upgrade\`.`,
            ),
          )
      if (options.nodeState) {
        const state = await currentSchemaState(db)
        const difference = compareStates(options.nodeState, state)
        if (difference < 0)
          results.push(
            result(
              'Warning',
              `The database's schema is ${state.version} (revision ${state.revision}), newer than this server's ${options.nodeState.version} (revision ${options.nodeState.revision}): this server reads but refuses changes until it is replaced.`,
            ),
          )
        else if (difference > 0)
          results.push(
            result(
              'Warning',
              `This server's schema files are ${options.nodeState.version} (revision ${options.nodeState.revision}), ahead of the database's ${state.version} (revision ${state.revision}).`,
            ),
          )
      }
    } catch (error) {
      results.push(
        result(
          'Error',
          error instanceof BundleConfigurationError
            ? error.problems.join(' ')
            : `The upgrade state could not be read: ${failure(error)}`,
        ),
      )
    }
    return results
  }

  async function mediaStorage(): Promise<HealthCheckResult[]> {
    const key = `health-check/${crypto.randomUUID()}.txt`
    const written = new TextEncoder().encode('ok')
    try {
      await media.put(key, written, { contentType: 'text/plain' })
      const read = await media.get(key)
      const bytes = read ? await read.bytes() : undefined
      await media.delete(key)
      if (!bytes || new TextDecoder().decode(bytes) !== 'ok')
        return [result('Error', `A file written to ${media.description} could not be read back.`)]
      return [result('Success', `Files can be written to and read from ${media.description}.`)]
    } catch (error) {
      return [result('Error', `${media.description} could not be used: ${failure(error)}`)]
    }
  }

  function email(): HealthCheckResult[] {
    const availability = emailAvailability(options.email)
    if (availability.available)
      return [result('Success', `E-mail is sent through ${availability.description}.`)]
    const affects =
      availability.affects.length > 0
        ? ` Unavailable until it is: ${availability.affects.join(', ')}.`
        : ''
    return [
      result(
        availability.provider === 'log' ? 'Info' : 'Warning',
        `${availability.reason}${affects}`,
      ),
    ]
  }

  async function nodes(): Promise<HealthCheckResult[]> {
    const live = await liveNodes(db, { seenWithinMs: LIVE_WITHIN_MS })
    if (live.length === 0) return [result('Warning', 'No server has reported in the last minute.')]
    const at = now()
    const results = live.map((node) =>
      result(
        'Info',
        `${node.nodeId}${node.role ? ` (${node.role})` : ''} runs Crombolo ${node.cromboloVersion ?? 'of an unknown release'} with schema ${node.version ?? '?'} revision ${node.revision ?? '?'}, last seen ${ago(node.lastSeen, at)}.`,
      ),
    )
    const releases = new Set(live.map((node) => node.cromboloVersion ?? 'unknown'))
    const schemas = new Set(live.map((node) => `${node.version}/${node.revision}`))
    if (releases.size > 1)
      results.unshift(
        result(
          'Warning',
          `The servers run different releases (${[...releases].join(', ')}). That is expected only while an upgrade rolls out.`,
        ),
      )
    else if (schemas.size > 1)
      results.unshift(
        result(
          'Warning',
          'The servers deploy different schema files. That is expected only while a deploy rolls out.',
        ),
      )
    else
      results.unshift(
        result('Success', `${live.length} server(s) running Crombolo ${[...releases][0]}.`),
      )
    return results
  }

  const runners: Record<string, () => HealthCheckResult[] | Promise<HealthCheckResult[]>> = {
    [CHECKS.database.id]: database,
    [CHECKS.migrations.id]: migrations,
    [CHECKS.media.id]: mediaStorage,
    [CHECKS.email.id]: email,
    [CHECKS.nodes.id]: nodes,
  }

  return {
    groups: () => GROUPS,

    async run(name) {
      const group = GROUPS.find((candidate) => candidate.name === name)
      if (!group) return undefined
      return Promise.all(
        group.checks.map(async (check) => {
          try {
            return {
              id: check.id,
              results: await (runners[check.id] as () => Promise<HealthCheckResult[]>)(),
            }
          } catch (error) {
            return {
              id: check.id,
              results: [result('Error', `The check failed: ${failure(error)}`)],
            }
          }
        }),
      )
    },

    async troubleshooting() {
      const availability = emailAvailability(options.email)
      const state = options.nodeState
      const items: Array<[string, string | undefined]> = [
        ['Crombolo version', VERSION],
        ['Backoffice version', backofficeVersion()],
        ['Runtime', `Bun ${Bun.version}`],
        ['Operating system', `${process.platform} ${process.arch}`],
        ['Mode', config.development ? 'Development' : 'Production'],
        ['Server', `${config.nodeId} (${config.role})`],
        ['Database', db.dialect.name === 'postgres' ? 'PostgreSQL' : 'SQLite'],
        ['Database location', describeDatabase(config)],
        ['Schema', state ? `${state.version} revision ${state.revision}` : undefined],
        ['Upgrade policy', config.upgradePolicy],
        ['Media storage', media.description],
        [
          'E-mail',
          availability.available ? (availability.description ?? undefined) : 'Not configured',
        ],
        ['Log level', config.logLevel],
        ['Time zone', Intl.DateTimeFormat().resolvedOptions().timeZone],
        ['Server time', now().toISOString()],
      ]
      return {
        items: items
          .filter((item): item is [string, string] => item[1] !== undefined)
          .map(([name, data]) => ({ name, data })),
      }
    },

    async upgradeCheck() {
      if (config.versionCheckPeriod <= 0)
        return { type: 'None', comment: 'Checking for new releases is turned off.', url: '' }
      const periodMs = config.versionCheckPeriod * 86_400_000
      if (checked && now().getTime() - checked.at < periodMs) return checked.answer
      let answer: Awaited<ReturnType<DiagnosticsPort['upgradeCheck']>>
      try {
        const response = await call(
          `${config.npmRegistry.replace(/\/$/, '')}/${encodeURIComponent(UPGRADE_PACKAGE)}`,
          { headers: { accept: 'application/json' } },
        )
        if (!response.ok) throw new Error(`the registry answered ${response.status}`)
        const latest = ((await response.json()) as { 'dist-tags'?: { latest?: string } })[
          'dist-tags'
        ]?.latest
        if (!latest) throw new Error('the registry named no latest release')
        const type = upgradeType(latest, VERSION)
        answer =
          type === 'None'
            ? { type, comment: `Crombolo ${VERSION} is the latest release.`, url: '' }
            : {
                type,
                comment: `Crombolo ${latest} is available; this site runs ${VERSION}.`,
                url: `https://www.npmjs.com/package/${UPGRADE_PACKAGE}/v/${latest}`,
              }
      } catch (error) {
        // Not cached: an air-gapped site asks again next time rather than
        // being told nothing for a week.
        return {
          type: 'None',
          comment: `The package registry could not be reached to check for a newer release (${failure(error)}).`,
          url: '',
        }
      }
      checked = { at: now().getTime(), answer }
      return answer
    },
  }
}
