/**
 * Models Builder: the dashboard's state, whether the models are stale, and the
 * Generate button. A build that fails still answers 200, as Umbraco's does —
 * the client treats any other status as a failed request and never re-reads the
 * dashboard, which is the only place the error is shown.
 */
import type { ModelsBuilderPort } from '../ports-models-builder.ts'
import type { ManagementApiRouter } from '../router.ts'

export function registerModelsBuilderHandlers(
  router: ManagementApiRouter,
  models: ModelsBuilderPort,
): void {
  router.handle('GetModelsBuilderDashboard', async () => Response.json(await models.info()))

  router.handle('GetModelsBuilderStatus', async () =>
    Response.json({ status: await models.status() }),
  )

  router.handle('PostModelsBuilderBuild', async (ctx) => {
    const result = await models.build()
    ctx.notifications.push(
      result.ok
        ? { message: 'Models generated', category: 'Models Builder', type: 'Success' }
        : { message: 'Models could not be generated', category: 'Models Builder', type: 'Error' },
    )
    return new Response(null, { status: 200 })
  })
}
