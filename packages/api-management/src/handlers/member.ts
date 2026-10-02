/**
 * The Members section: the collection, the editor, and the lookups member
 * pickers use.
 *
 * Members are not a tree — the contract gives them no `tree/member` operations —
 * so the collection is `filter/member`, which is Umbraco's own member filter with
 * the same columns and the same default order (username, ascending).
 */
import {
  type DocumentValue,
  invalidSkipTake,
  notFound,
  paged,
  problemDetails,
  problemResponse,
} from '@bunbraco/core'
import type { PortFailure } from '../ports-content.ts'
import type { MemberPort, SaveMember } from '../ports-members.ts'
import type { ManagementApiRouter, Principal, RequestContext } from '../router.ts'
import { created, paging } from './content-type.ts'
import { readBody, validationProblem } from './document.ts'

const V1 = '/umbraco/management/api/v1'

const refId = (value: unknown): string | null => {
  if (!value || typeof value !== 'object') return null
  const id = (value as Record<string, unknown>).id
  return typeof id === 'string' && id ? id : null
}

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined

function readValues(body: Record<string, unknown>): DocumentValue[] {
  if (!Array.isArray(body.values)) return []
  return (body.values as Array<Record<string, unknown>>).map((value) => ({
    alias: String(value.alias ?? ''),
    culture: (value.culture as string | null) ?? null,
    segment: (value.segment as string | null) ?? null,
    value: value.value,
  }))
}

function readVariants(body: Record<string, unknown>) {
  if (!Array.isArray(body.variants)) return []
  return (body.variants as Array<Record<string, unknown>>).map((variant) => ({
    culture: (variant.culture as string | null) ?? null,
    segment: (variant.segment as string | null) ?? null,
    name: String(variant.name ?? ''),
  }))
}

/**
 * A member save request. Create carries `password` and `memberType`; update
 * carries `newPassword` with `oldPassword` and neither of the other two, since
 * a member's type never changes.
 */
export function toSaveMember(key: string, body: Record<string, unknown>): SaveMember {
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : null
  return {
    key,
    memberTypeKey: refId(body.memberType) ?? '',
    email: typeof body.email === 'string' ? body.email.trim() : '',
    username: typeof body.username === 'string' ? body.username.trim() : '',
    password: typeof body.password === 'string' ? body.password : newPassword,
    oldPassword: typeof body.oldPassword === 'string' ? body.oldPassword : null,
    isApproved: body.isApproved !== false,
    isLockedOut: body.isLockedOut === true,
    isTwoFactorEnabled: body.isTwoFactorEnabled === true,
    groupKeys: strings(body.groups),
    values: readValues(body),
    variants: readVariants(body),
  }
}

const failed = (title: string, result: PortFailure) =>
  problemResponse(problemDetails({ title, status: result.status ?? 400, detail: result.reason }))

const missing = () => problemResponse(notFound('The member could not be found'))

/** Required fields the contract declares but does not constrain. */
function missingFields(input: SaveMember, forCreate: boolean): string | undefined {
  if (!input.email) return 'An e-mail address is required'
  if (!input.username) return 'A username is required'
  if (input.variants.length === 0 || !input.variants[0]?.name) return 'A name is required'
  if (forCreate && !input.memberTypeKey) return 'A member type is required'
  if (forCreate && !input.password) return 'A password is required'
  return undefined
}

export function registerMemberHandlers(router: ManagementApiRouter, port: MemberPort): void {
  const viewer = (ctx: RequestContext) => ctx.principal as Principal
  const done = (ctx: RequestContext, message?: string) => {
    if (message) ctx.notifications.push({ message, category: 'Member', type: 'Success' })
    return new Response(null, { status: 200 })
  }

  const checked = async (input: SaveMember, forCreate: boolean) => {
    const problem = missingFields(input, forCreate)
    if (problem) return problemResponse(problemDetails({ title: problem, status: 400 }))
    const errors = await port.validate(input)
    if (errors.length > 0) return problemResponse(validationProblem(errors, input.values))
    return undefined
  }

  router.handle('GetMemberById', async (ctx) => {
    const member = await port.byKey(ctx.params.id as string, viewer(ctx))
    return member ? Response.json(member) : missing()
  })

  router.handle('PostMemberValidate', async (ctx) => {
    const input = toSaveMember(crypto.randomUUID(), await readBody(ctx))
    return (await checked(input, true)) ?? done(ctx)
  })

  router.handle('PutMemberByIdValidate', async (ctx) => {
    const key = ctx.params.id as string
    if (!(await port.byKey(key, viewer(ctx)))) return missing()
    return (await checked(toSaveMember(key, await readBody(ctx)), false)) ?? done(ctx)
  })

  router.handle('PostMember', async (ctx) => {
    const body = await readBody(ctx)
    const key = typeof body.id === 'string' && body.id ? body.id : crypto.randomUUID()
    const input = toSaveMember(key, body)
    const invalid = await checked(input, true)
    if (invalid) return invalid
    const result = await port.create(input, viewer(ctx))
    if (!result.ok) return failed('Could not create the member', result)
    return created(`${ctx.url.origin}${V1}/member/${result.key}`, result.key)
  })

  router.handle('PutMemberById', async (ctx) => {
    const key = ctx.params.id as string
    if (!(await port.byKey(key, viewer(ctx)))) return missing()
    const input = toSaveMember(key, await readBody(ctx))
    const invalid = await checked(input, false)
    if (invalid) return invalid
    const result = await port.update(key, input, viewer(ctx))
    return result.ok ? done(ctx) : failed('Could not save the member', result)
  })

  router.handle('DeleteMemberById', async (ctx) =>
    (await port.remove(ctx.params.id as string)) ? done(ctx) : missing(),
  )

  router.handle('GetFilterMember', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const query = ctx.url.searchParams
    const flag = (name: string) => {
      const value = query.get(name)
      return value === null ? undefined : value === 'true'
    }
    const result = await port.filter(
      {
        ...page,
        memberTypeKey: query.get('memberTypeId'),
        memberGroupName: query.get('memberGroupName'),
        isApproved: flag('isApproved'),
        isLockedOut: flag('isLockedOut'),
        filter: query.get('filter') ?? undefined,
        orderBy: query.get('orderBy') ?? undefined,
        orderDirection: query.get('orderDirection') === 'Descending' ? 'Descending' : 'Ascending',
      },
      viewer(ctx),
    )
    return Response.json(paged(result.items, result.total))
  })

  router.handle('GetItemMember', async (ctx) =>
    Response.json(await port.items(ctx.url.searchParams.getAll('id'))),
  )

  // A member has no ancestors: the list is always empty, but the picker asks.
  router.handle('GetItemMemberAncestors', (ctx) =>
    Response.json(ctx.url.searchParams.getAll('id').map((id) => ({ id, ancestors: [] }))),
  )

  router.handle('GetItemMemberSearch', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const result = await port.search(ctx.url.searchParams.get('query') ?? '', {
      ...page,
      allowedMemberTypeKeys: ctx.url.searchParams.getAll('allowedMemberTypes'),
    })
    return Response.json(paged(result.items, result.total))
  })
}
