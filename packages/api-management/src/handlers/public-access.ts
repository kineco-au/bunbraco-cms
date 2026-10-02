/**
 * Public access: which documents are protected, and by what.
 *
 * A rule names member groups **or** individual members, never both — Umbraco
 * calls the mixture ambiguous and refuses it, and so do we, because the two are
 * different intentions and the editor offers them as a choice.
 */
import { notFound, problemDetails, problemResponse } from '@bunbraco/core'
import type { PublicAccessPort, PublicAccessStatus } from '../ports-members.ts'
import type { ManagementApiRouter, RequestContext } from '../router.ts'
import { readBody } from './document.ts'

const refId = (value: unknown): string | null => {
  if (!value || typeof value !== 'object') return null
  const id = (value as Record<string, unknown>).id
  return typeof id === 'string' && id ? id : null
}

const names = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    : []

/** Umbraco's `PublicAccessOperationStatus`, as the problem details the client reads. */
function statusResponse(status: PublicAccessStatus, ok: () => Response): Response {
  switch (status) {
    case 'ok':
      return ok()
    case 'content-not-found':
      return problemResponse(notFound('The document could not be found'))
    case 'login-node-not-found':
      return problemResponse(notFound('The login page could not be found'))
    case 'error-node-not-found':
      return problemResponse(notFound('The error page could not be found'))
    default:
      return problemResponse(
        problemDetails({
          title: 'Entry not found',
          detail: 'The specified entry was not found.',
          status: 404,
        }),
      )
  }
}

export function registerPublicAccessHandlers(
  router: ManagementApiRouter,
  port: PublicAccessPort,
): void {
  router.handle('GetDocumentByIdPublicAccess', async (ctx) => {
    const result = await port.entry(
      ctx.params.id as string,
      ctx.url.searchParams.get('includeAncestors') === 'true',
    )
    if (result.status !== 'ok' || !result.entry)
      return statusResponse(result.status, () => new Response(null, { status: 404 }))
    return Response.json(result.entry)
  })

  const write = async (ctx: RequestContext, ok: () => Response) => {
    const body = await readBody(ctx)
    const login = refId(body.loginDocument)
    const error = refId(body.errorDocument)
    if (!login) return problemResponse(notFound('The login page could not be found'))
    if (!error) return problemResponse(notFound('The error page could not be found'))
    const memberGroupNames = names(body.memberGroupNames)
    const memberUserNames = names(body.memberUserNames)
    if (memberGroupNames.length === 0 && memberUserNames.length === 0)
      return problemResponse(
        problemDetails({
          title: 'No allowed entities given',
          detail: 'Both MemberGroups and Members were empty, thus no entities can be allowed.',
          status: 400,
        }),
      )
    if (memberGroupNames.length > 0 && memberUserNames.length > 0)
      return problemResponse(
        problemDetails({
          title: 'Ambiguous Rule',
          detail:
            'The specified rule is ambiguous, because both member groups and member names were given.',
          status: 400,
        }),
      )
    const status = await port.save(ctx.params.id as string, {
      loginDocumentKey: login,
      errorDocumentKey: error,
      memberGroupNames,
      memberUserNames,
    })
    return statusResponse(status, ok)
  }

  router.handle('PostDocumentByIdPublicAccess', (ctx) =>
    write(ctx, () => new Response(null, { status: 201 })),
  )
  router.handle('PutDocumentByIdPublicAccess', (ctx) =>
    write(ctx, () => new Response(null, { status: 200 })),
  )

  router.handle('DeleteDocumentByIdPublicAccess', async (ctx) =>
    statusResponse(
      await port.remove(ctx.params.id as string),
      () => new Response(null, { status: 200 }),
    ),
  )
}
