/**
 * Health checks, telemetry, profiling and the server's troubleshooting and
 * upgrade-check answers. Telemetry and profiling are gone — nothing is
 * collected or sent, and there is no profiler — so their endpoints answer 410.
 * docs/diagnostics.md.
 */
import { invalidSkipTake, notFound, problemDetails, problemResponse } from '@crombolo/core'
import type { DiagnosticsPort } from '../ports-diagnostics.ts'
import type { ManagementApiRouter } from '../router.ts'
import { paging } from './content-type.ts'

const badRequest = (title: string, detail: string) => problemDetails({ title, detail, status: 400 })

/** An operation for something this server has not got, and never will: 410, with why. */
const gone = (title: string, detail: string) => () =>
  problemResponse(problemDetails({ title, detail, status: 410 }))

const telemetryGone = gone(
  'Telemetry is not collected',
  'This site collects no telemetry and sends nothing anywhere.',
)
const profilingGone = gone(
  'There is no profiler',
  'This site has no profiler to read or switch on.',
)

export function registerTelemetryAndProfilingHandlers(router: ManagementApiRouter): void {
  router.handle('GetTelemetry', telemetryGone)
  router.handle('GetTelemetryLevel', telemetryGone)
  router.handle('PostTelemetryLevel', telemetryGone)
  router.handle('GetProfilingStatus', profilingGone)
  router.handle('PutProfilingStatus', profilingGone)
}

export function registerDiagnosticsHandlers(
  router: ManagementApiRouter,
  diagnostics: DiagnosticsPort,
): void {
  const groupNamed = (name: string) =>
    diagnostics.groups().find((group) => group.name.toLowerCase() === name.toLowerCase())
  const noGroup = () => problemResponse(notFound('The health check group could not be found'))

  router.handle('GetHealthCheckGroup', (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const groups = diagnostics.groups()
    return Response.json({
      total: groups.length,
      items: groups.slice(page.skip, page.skip + page.take).map(({ name }) => ({ name })),
    })
  })
  router.handle('GetHealthCheckGroupByName', (ctx) => {
    const group = groupNamed(String(ctx.params.name))
    return group ? Response.json(group) : noGroup()
  })
  router.handle('PostHealthCheckGroupByNameCheck', async (ctx) => {
    const group = groupNamed(String(ctx.params.name))
    const checks = group && (await diagnostics.run(group.name))
    return checks ? Response.json({ checks }) : noGroup()
  })
  // No check here offers an action: each one reports, and the fix is a change
  // to the site's configuration rather than something a button can do.
  router.handle('PostHealthCheckExecuteAction', () =>
    problemResponse(
      badRequest(
        'There is nothing to run',
        'These health checks report only; none offers an action.',
      ),
    ),
  )
  router.handle('GetServerTroubleshooting', async () =>
    Response.json(await diagnostics.troubleshooting()),
  )
  router.handle('GetServerUpgradeCheck', async () =>
    Response.json(await diagnostics.upgradeCheck()),
  )
}
