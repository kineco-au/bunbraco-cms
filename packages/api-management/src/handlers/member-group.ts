/**
 * Member groups: the seven operations the contract declares for them — CRUD,
 * the item lookup pickers use, and a tree root. There is no children, ancestors
 * or siblings operation, because member groups are a flat list.
 */
import {
  invalidSkipTake,
  notFound,
  paged,
  parseSkipTake,
  problemDetails,
  problemResponse,
} from '@bunbraco/core'
import type { MemberGroupPort, MemberGroupStatus } from '../ports-members.ts'
import type { ManagementApiRouter, RequestContext } from '../router.ts'
import { created } from './content-type.ts'

const V1 = '/umbraco/management/api/v1'

const keysOf = (ctx: RequestContext) => ctx.url.searchParams.getAll('id')

function statusResponse(status: MemberGroupStatus): Response {
  if (status === 'ok') return new Response(null, { status: 200 })
  if (status === 'not-found')
    return problemResponse(notFound('The member group could not be found'))
  return problemResponse(
    problemDetails({
      title: 'Duplicate member group name',
      detail: 'Another member group already uses this name.',
      status: 400,
      operationStatus: 'DuplicateName',
    }),
  )
}

export function registerMemberGroupHandlers(
  router: ManagementApiRouter,
  groups: MemberGroupPort,
): void {
  const paging = (ctx: RequestContext) => parseSkipTake(ctx.url.searchParams)

  router.handle('GetMemberGroup', async (ctx) => {
    const page = paging(ctx)
    if (!page.ok) return problemResponse(invalidSkipTake())
    const result = await groups.list(page.value)
    return Response.json(paged(result.items, result.total))
  })

  router.handle('GetMemberGroupById', async (ctx) => {
    const group = await groups.byKey(ctx.params.id as string)
    // The contract gives this one a bare 404, with no problem details.
    if (!group) return new Response(null, { status: 404 })
    return Response.json(group)
  })

  router.handle('PostMemberGroup', async (ctx) => {
    const body = ((await ctx.request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return problemResponse(problemDetails({ title: 'A name is required', status: 400 }))
    const result = await groups.create({
      key: typeof body.id === 'string' && body.id ? body.id : undefined,
      name,
    })
    if (result.status !== 'ok' || !result.key) return statusResponse(result.status)
    return created(`${ctx.url.origin}${V1}/member-group/${result.key}`, result.key)
  })

  router.handle('PutMemberGroupById', async (ctx) => {
    const body = ((await ctx.request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return problemResponse(problemDetails({ title: 'A name is required', status: 400 }))
    return statusResponse(await groups.rename(ctx.params.id as string, name))
  })

  router.handle('DeleteMemberGroupById', async (ctx) =>
    statusResponse(await groups.remove(ctx.params.id as string)),
  )

  router.handle('GetItemMemberGroup', async (ctx) => Response.json(await groups.items(keysOf(ctx))))

  router.handle('GetTreeMemberGroupRoot', async (ctx) => {
    const page = paging(ctx)
    if (!page.ok) return problemResponse(invalidSkipTake())
    const result = await groups.tree(page.value)
    return Response.json(paged(result.items, result.total))
  })
}
