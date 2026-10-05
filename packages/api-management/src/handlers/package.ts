/**
 * The Packages section: created-package definitions, their download, and the
 * two migration operations that answer honestly rather than pretend.
 *
 * `packagePath` is required by the contract and is a real file path in Umbraco,
 * which stores a built zip on disk. Nothing is stored here — the zip is built
 * when it is downloaded — so it reports the name the download will carry,
 * which is the only part of it the client ever shows.
 */
import {
  invalidSkipTake,
  notFound,
  paged,
  parseSkipTake,
  problemDetails,
  problemResponse,
} from '@bunbraco/core'
import type {
  PackageDefinition,
  PackageDefinitionInput,
  PackagePort,
  PackageWriteResult,
} from '../ports-packages.ts'
import type { ManagementApiRouter, RequestContext } from '../router.ts'
import { created } from './content-type.ts'

const packageNotFound = () => problemResponse(notFound('The package could not be found'))

/** A download filename from a package name: no separators, no surprises. */
export function packageFileName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug || 'package'}.zip`
}

const toResponse = (definition: PackageDefinition) => ({
  id: definition.id,
  name: definition.name,
  packagePath: packageFileName(definition.name),
  contentNodeId: definition.contentNodeId,
  contentLoadChildNodes: definition.contentLoadChildNodes,
  mediaIds: definition.mediaIds,
  mediaLoadChildNodes: definition.mediaLoadChildNodes,
  elementIds: definition.elementIds,
  documentTypes: definition.documentTypes,
  mediaTypes: definition.mediaTypes,
  dataTypes: definition.dataTypes,
  templates: definition.templates,
  partialViews: definition.partialViews,
  stylesheets: definition.stylesheets,
  scripts: definition.scripts,
  languages: definition.languages,
  dictionaryItems: definition.dictionaryItems,
})

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

/** The id of a reference, which the client sends as `{ id }` or as a bare string. */
const refId = (value: unknown): string | null => {
  if (typeof value === 'string') return value.length > 0 ? value : null
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    return typeof id === 'string' && id.length > 0 ? id : null
  }
  return null
}

function readInput(body: Record<string, unknown>): PackageDefinitionInput {
  return {
    name: String(body.name ?? '').trim(),
    contentNodeId: refId(body.contentNodeId),
    contentLoadChildNodes: body.contentLoadChildNodes === true,
    mediaIds: strings(body.mediaIds),
    mediaLoadChildNodes: body.mediaLoadChildNodes === true,
    elementIds:
      body.elementIds === null || body.elementIds === undefined ? null : strings(body.elementIds),
    documentTypes: strings(body.documentTypes),
    mediaTypes: strings(body.mediaTypes),
    dataTypes: strings(body.dataTypes),
    templates: strings(body.templates),
    partialViews: strings(body.partialViews),
    stylesheets: strings(body.stylesheets),
    scripts: strings(body.scripts),
    languages: strings(body.languages),
    dictionaryItems: strings(body.dictionaryItems),
  }
}

function writeFailure(result: PackageWriteResult): Response | undefined {
  if (result.ok) return undefined
  switch (result.status) {
    case 'NotFound':
      return packageNotFound()
    case 'InvalidName':
      return problemResponse(
        problemDetails({
          title: 'A package name is required',
          status: 400,
          operationStatus: 'InvalidName',
        }),
      )
    case 'DuplicateName':
      return problemResponse(
        problemDetails({
          title: 'Duplicate package name detected',
          detail: 'Another package exists with the same name. Package names must be unique.',
          status: 400,
          operationStatus: 'DuplicateName',
        }),
      )
  }
}

const body = async (ctx: RequestContext): Promise<Record<string, unknown>> =>
  ((await ctx.request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>

export function registerPackageHandlers(router: ManagementApiRouter, port: PackagePort): void {
  router.handle('GetPackageConfiguration', () =>
    Response.json({ marketplaceUrl: port.marketplaceUrl() }),
  )

  router.handle('GetPackageCreated', async (ctx) => {
    const page = parseSkipTake(ctx.url.searchParams)
    if (!page.ok) return problemResponse(invalidSkipTake())
    const result = await port.list(page.value)
    return Response.json(paged(result.items.map(toResponse), result.total))
  })

  router.handle('PostPackageCreated', async (ctx) => {
    const input = await body(ctx)
    const result = await port.create(readInput(input), refId(input.id) ?? undefined)
    const failed = writeFailure(result)
    if (failed) return failed
    const id = result.ok ? result.id : ''
    return created(`${ctx.url.origin}/umbraco/management/api/v1/package/created/${id}`, id)
  })

  router.handle('GetPackageCreatedById', async (ctx) => {
    const definition = await port.byId(ctx.params.id as string)
    if (!definition) return packageNotFound()
    return Response.json(toResponse(definition))
  })

  router.handle('PutPackageCreatedById', async (ctx) => {
    const result = await port.update(ctx.params.id as string, readInput(await body(ctx)))
    return writeFailure(result) ?? new Response(null, { status: 200 })
  })

  router.handle('DeletePackageCreatedById', async (ctx) => {
    const result = await port.remove(ctx.params.id as string)
    if (result === 'notFound') return packageNotFound()
    return new Response(null, { status: 200 })
  })

  router.handle('GetPackageCreatedByIdDownload', async (ctx) => {
    const built = await port.build(ctx.params.id as string)
    if (!built) return packageNotFound()
    return new Response(built.bytes, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${built.fileName}"`,
      },
    })
  })

  /**
   * Umbraco's package migrations are C# migrations shipped inside a package.
   * Nothing carries them here — extensions are client-side and schema changes
   * travel as TOML through a deploy — so there is never a package with a
   * pending migration, and saying so is the honest answer rather than a stub.
   */
  router.handle('GetPackageMigrationStatus', (ctx) => {
    if (!parseSkipTake(ctx.url.searchParams).ok) return problemResponse(invalidSkipTake())
    return Response.json(paged([], 0))
  })

  router.handle('PostPackageByNameRunMigration', (ctx) =>
    problemResponse(
      notFound(
        'The package could not be found',
        `No package named '${ctx.params.name}' has migrations to run. Package migrations do not exist in this CMS; schema changes travel as files through a deploy.`,
      ),
    ),
  )
}
