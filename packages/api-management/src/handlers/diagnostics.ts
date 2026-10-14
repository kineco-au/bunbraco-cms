/**
 * Health checks, telemetry, profiling and the server's troubleshooting and
 * upgrade-check answers. Telemetry and profiling are fixed: nothing is
 * collected or sent, and there is no profiler. docs/diagnostics.md.
 */
import { invalidSkipTake, notFound, problemDetails, problemResponse } from '@crombolo/core'
import type { DiagnosticsPort } from '../ports-diagnostics.ts'
import type { ManagementApiRouter } from '../router.ts'
import { paging } from './content-type.ts'
import { readBody } from './document.ts'

const TELEMETRY_LEVEL = 'Minimal'

const badRequest = (title: string, detail: string) => problemDetails({ title, detail, status: 400 })

export function registerTelemetryAndProfilingHandlers(router: ManagementApiRouter): void {
  router.handle('GetTelemetry', (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const items = [{ telemetryLevel: TELEMETRY_LEVEL }]
    return Response.json({
      total: items.length,
      items: items.slice(page.skip, page.skip + page.take),
    })
  })
  router.handle('GetTelemetryLevel', () => Response.json({ telemetryLevel: TELEMETRY_LEVEL }))
  router.handle('PostTelemetryLevel', async (ctx) => {
    const { telemetryLevel } = await readBody(ctx)
    if (telemetryLevel === TELEMETRY_LEVEL) return new Response(null, { status: 200 })
    return problemResponse(
      badRequest(
        'Telemetry cannot be raised',
        'This site collects no telemetry and sends nothing anywhere, so the level stays at Minimal.',
      ),
    )
  })
  router.handle('GetProfilingStatus', () => Response.json({ enabled: false }))
  router.handle('PutProfilingStatus', async (ctx) => {
    const { enabled } = await readBody(ctx)
    if (enabled === false) return new Response(null, { status: 200 })
    return problemResponse(
      badRequest('Profiling is not available', 'This site has no profiler to switch on.'),
    )
  })
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
