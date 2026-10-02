/**
 * Cultures and languages. UI translation strings are client-side manifests, not
 * server endpoints — these describe which cultures exist, not what words mean.
 */
import {
  invalidSkipTake,
  notFound,
  paged,
  parseSkipTake,
  problemDetails,
  problemResponse,
} from '@bunbraco/core'
import type { LanguageInput, LocalizationPort } from '../ports.ts'
import type { ManagementApiRouter, RequestContext } from '../router.ts'

/** Applies Umbraco's paging contract, including the skip-multiple-of-take rule. */
function pageOf<T>(ctx: RequestContext, items: readonly T[]): Response {
  const skipTake = parseSkipTake(ctx.url.searchParams)
  if (!skipTake.ok) return problemResponse(invalidSkipTake())
  const { skip, take } = skipTake.value
  const window = take === 0 ? [] : items.slice(skip, skip + take)
  return Response.json(paged([...window], items.length))
}

export function registerLocalizationHandlers(
  router: ManagementApiRouter,
  localization: LocalizationPort,
): void {
  router.handle('GetCulture', (ctx) => pageOf(ctx, localization.cultures()))
  // Segments come from a segment provider; like Umbraco without one, there are none
  router.handle('GetSegment', (ctx) => pageOf(ctx, []))
  router.handle('GetDocumentByIdAvailableSegmentOptions', (ctx) => pageOf(ctx, []))
  router.handle('GetLanguage', async (ctx) => pageOf(ctx, await localization.allLanguages()))
  router.handle('GetItemLanguageDefault', async () => {
    const languages = await localization.allLanguages()
    const fallback = languages.find((l) => l.isDefault) ?? languages[0]
    return Response.json(
      fallback ?? {
        isoCode: 'en-US',
        name: 'English (United States)',
        isDefault: true,
        isMandatory: true,
        fallbackIsoCode: null,
      },
    )
  })
  router.handle('GetItemLanguage', async (ctx) => {
    const wanted = new Set(ctx.url.searchParams.getAll('isoCode').map((c) => c.toLowerCase()))
    const languages = await localization.allLanguages()
    return Response.json(
      languages
        .filter((l) => wanted.size === 0 || wanted.has(l.isoCode.toLowerCase()))
        .map((l) => ({ name: l.name, isoCode: l.isoCode })),
    )
  })
  router.handle('GetLanguageByIsoCode', async ({ params }) => {
    const language = await localization.language(params.isoCode as string)
    if (!language) return problemResponse(notFound('The language could not be found'))
    return Response.json(language)
  })
  router.handle('PostLanguage', async (ctx) => {
    const body = (await ctx.request.json()) as Record<string, unknown>
    const isoCode = String(body.isoCode ?? '')
    if (!isoCode)
      return problemResponse(problemDetails({ title: 'isoCode is required', status: 400 }))
    if (await localization.language(isoCode))
      return problemResponse(
        problemDetails({
          title: 'The language already exists',
          status: 400,
          operationStatus: 'DuplicateIsoCode',
        }),
      )
    await localization.saveLanguage(readLanguage(isoCode, body))
    ctx.notifications.push({ message: 'Language created', category: 'Language', type: 'Success' })
    return new Response(null, {
      status: 201,
      headers: { location: `${ctx.url.origin}/umbraco/management/api/v1/language/${isoCode}` },
    })
  })
  router.handle('PutLanguageByIsoCode', async (ctx) => {
    const isoCode = ctx.params.isoCode as string
    const existing = await localization.language(isoCode)
    if (!existing) return problemResponse(notFound('The language could not be found'))
    const body = (await ctx.request.json()) as Record<string, unknown>
    await localization.saveLanguage(readLanguage(existing.isoCode, body))
    ctx.notifications.push({ message: 'Language saved', category: 'Language', type: 'Success' })
    return new Response(null, { status: 200 })
  })
  router.handle('DeleteLanguageByIsoCode', async (ctx) => {
    const result = await localization.deleteLanguage(ctx.params.isoCode as string)
    if (result === 'not-found') return problemResponse(notFound('The language could not be found'))
    if (result !== 'deleted')
      return problemResponse(
        problemDetails({
          title:
            result === 'default'
              ? 'The default language cannot be deleted'
              : 'Another language falls back to this one',
          status: 400,
        }),
      )
    ctx.notifications.push({ message: 'Language deleted', category: 'Language', type: 'Success' })
    return new Response(null, { status: 200 })
  })
}

function readLanguage(isoCode: string, body: Record<string, unknown>): LanguageInput {
  return {
    isoCode,
    name: String(body.name ?? isoCode),
    isDefault: body.isDefault === true,
    isMandatory: body.isMandatory === true,
    fallbackIsoCode: typeof body.fallbackIsoCode === 'string' ? body.fallbackIsoCode : null,
  }
}
