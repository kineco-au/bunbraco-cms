/**
 * Dynamic roots: a content picker's start node, resolved from the document being
 * edited by an origin and a list of steps.
 */
import { problemDetails, problemResponse } from '@crombolo/core'
import type { DynamicRootPort } from '../ports.ts'
import type { ManagementApiRouter } from '../router.ts'
import { readBody } from './document.ts'

export const DYNAMIC_ROOT_STEP_ALIASES = [
  'NearestAncestorOrSelf',
  'FurthestAncestorOrSelf',
  'NearestDescendantOrSelf',
  'FurthestDescendantOrSelf',
]

const EMPTY_GUID = '00000000-0000-0000-0000-000000000000'

const keyOf = (value: unknown): string | null => {
  const id = (value as { id?: unknown } | null | undefined)?.id ?? value
  return typeof id === 'string' && id !== '' && id !== EMPTY_GUID ? id : null
}

export function registerDynamicRootHandlers(
  router: ManagementApiRouter,
  port: DynamicRootPort,
): void {
  router.handle('GetDynamicRootSteps', () => Response.json(DYNAMIC_ROOT_STEP_ALIASES))
  router.handle('PostDynamicRootQuery', async (ctx) => {
    const body = await readBody(ctx)
    const context = body.context as { id?: unknown; parent?: unknown } | undefined
    const query = body.query as
      | { origin?: { alias?: unknown; id?: unknown }; steps?: unknown }
      | undefined
    if (!context || typeof query?.origin?.alias !== 'string')
      return problemResponse(
        problemDetails({
          title: 'Invalid dynamic root query',
          detail: 'A query needs a context and an origin.',
          status: 400,
        }),
      )
    const steps = Array.isArray(query.steps) ? query.steps : []
    const roots = await port.resolve({
      currentKey: keyOf(context.id),
      parentKey: keyOf(context.parent),
      origin: { alias: query.origin.alias, key: keyOf(query.origin.id) },
      steps: steps.map((step) => {
        const { alias, documentTypeIds } = (step ?? {}) as {
          alias?: unknown
          documentTypeIds?: unknown
        }
        return {
          alias: String(alias ?? ''),
          documentTypeKeys: Array.isArray(documentTypeIds)
            ? documentTypeIds.filter((id): id is string => typeof id === 'string')
            : [],
        }
      }),
    })
    return Response.json({ roots })
  })
}
