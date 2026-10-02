/**
 * The log viewer: levels, level counts, message templates, the log itself and
 * saved searches, with Umbraco's defaults — the last day when either date is
 * missing, 100 per page, newest first — and its size check before any read.
 */
import {
  invalidSkipTake,
  notFound,
  paged,
  parseSkipTake,
  problemDetails,
  problemResponse,
} from '@bunbraco/core'
import type { LogLevelName, LogRange, LogViewerPort } from '../ports-logs.ts'
import type { ManagementApiRouter, RequestContext } from '../router.ts'

const LEVELS: readonly LogLevelName[] = [
  'Verbose',
  'Debug',
  'Information',
  'Warning',
  'Error',
  'Fatal',
]

const tooLarge = () =>
  problemResponse(
    problemDetails({
      title: 'Cancelled due to log file size',
      detail: 'The log file size for the requested date range prevented the operation.',
      status: 400,
      operationStatus: 'CancelledByLogsSizeValidation',
    }),
  )

function dateParam(ctx: RequestContext, name: string): Date | null {
  const value = ctx.url.searchParams.get(name)
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const rangeOf = (ctx: RequestContext): LogRange => ({
  start: dateParam(ctx, 'startDate'),
  end: dateParam(ctx, 'endDate'),
})

function page<T>(ctx: RequestContext, items: readonly T[]): Response {
  const parsed = parseSkipTake(ctx.url.searchParams)
  if (!parsed.ok) return problemResponse(invalidSkipTake())
  const { skip, take } = parsed.value
  return Response.json(paged(items.slice(skip, skip + take), items.length))
}

export function registerLogViewerHandlers(router: ManagementApiRouter, logs: LogViewerPort): void {
  router.handle('GetLogViewerLevel', (ctx) => page(ctx, logs.loggers()))

  router.handle('GetLogViewerValidateLogsSize', async (ctx) =>
    (await logs.canView(rangeOf(ctx))) ? new Response(null, { status: 200 }) : tooLarge(),
  )

  router.handle('GetLogViewerLevelCount', async (ctx) => {
    const range = rangeOf(ctx)
    if (!(await logs.canView(range))) return tooLarge()
    return Response.json(await logs.levelCounts(range))
  })

  router.handle('GetLogViewerMessageTemplate', async (ctx) => {
    const range = rangeOf(ctx)
    if (!(await logs.canView(range))) return tooLarge()
    return page(ctx, await logs.templates(range))
  })

  router.handle('GetLogViewerLog', async (ctx) => {
    const range = rangeOf(ctx)
    if (!(await logs.canView(range))) return tooLarge()
    const q = ctx.url.searchParams
    const levels = q
      .getAll('logLevel')
      .filter((l): l is LogLevelName => LEVELS.includes(l as LogLevelName))
    const entries = await logs.logs(range, {
      filter: q.get('filterExpression'),
      levels,
      direction: q.get('orderDirection') === 'Ascending' ? 'Ascending' : 'Descending',
    })
    return page(ctx, entries)
  })

  router.handle('GetLogViewerSavedSearch', async (ctx) => page(ctx, await logs.savedSearches()))

  router.handle('GetLogViewerSavedSearchByName', async (ctx) => {
    const found = await logs.savedSearch(ctx.params.name as string)
    if (!found) return problemResponse(notFound('The saved search could not be found'))
    return Response.json(found)
  })

  router.handle('PostLogViewerSavedSearch', async (ctx) => {
    const body = ((await ctx.request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const query = typeof body.query === 'string' ? body.query : ''
    if (!name) return problemResponse(problemDetails({ title: 'A name is required', status: 400 }))
    if ((await logs.saveSearch(name, query)) === 'duplicate')
      return problemResponse(
        problemDetails({
          title: 'Duplicate log search name',
          detail: 'Another log search already exists with the same name.',
          status: 400,
          operationStatus: 'DuplicateLogSearch',
        }),
      )
    return new Response(null, {
      status: 201,
      headers: {
        location: `${ctx.url.origin}/umbraco/management/api/v1/log-viewer/saved-search/${encodeURIComponent(name)}`,
        'umb-generated-resource': name,
      },
    })
  })

  router.handle('DeleteLogViewerSavedSearchByName', async (ctx) =>
    (await logs.deleteSearch(ctx.params.name as string))
      ? new Response(null, { status: 200 })
      : problemResponse(notFound('The saved search could not be found')),
  )
}
