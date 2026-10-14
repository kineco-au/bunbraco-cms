import type { ResponseOf, Schemas } from '@crombolo/contracts'

export type HealthCheckResult = Schemas['HealthCheckResultResponseModel']

export interface HealthCheckGroup {
  name: string
  checks: Schemas['HealthCheckModel'][]
}

/** The health checks, troubleshooting report and upgrade check. docs/diagnostics.md. */
export interface DiagnosticsPort {
  groups(): HealthCheckGroup[]
  /** Runs every check in the group; undefined when there is no such group. */
  run(group: string): Promise<Schemas['HealthCheckWithResultPresentationModel'][] | undefined>
  troubleshooting(): Promise<ResponseOf<'GetServerTroubleshooting'>>
  upgradeCheck(): Promise<ResponseOf<'GetServerUpgradeCheck'>>
}
