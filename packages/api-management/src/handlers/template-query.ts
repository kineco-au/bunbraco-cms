/**
 * The template editor's query builder.
 *
 * It writes the snippet a component uses to pick content, so what it emits is
 * **TypeScript against the render model** — `nav.children(...)` and the
 * accessors a `.tsx` already has — rather than the Razor and LINQ Umbraco's own
 * builder writes. The wire contract is still Umbraco's, so the field names here
 * are theirs and only the expression inside is ours.
 *
 * `execute` runs the query it describes, so the count and the sample are the
 * answer the snippet would give rather than a guess about it.
 */
import type { ResponseOf } from '@bunbraco/contracts'
import type {
  TemplateQueryFilter,
  TemplateQueryPort,
  TemplateQueryRequest,
  TemplateQuerySort,
} from '../ports-content.ts'
import type { ManagementApiRouter } from '../router.ts'

/** What the builder can filter and sort on: the model's own fields. */
const PROPERTIES = [
  { alias: 'Id', type: 'Integer' },
  { alias: 'Name', type: 'String' },
  { alias: 'CreateDate', type: 'DateTime' },
  { alias: 'UpdateDate', type: 'DateTime' },
] as const

const OPERATORS = [
  { operator: 'Equals', applicableTypes: ['String', 'DateTime', 'Integer'] },
  { operator: 'NotEquals', applicableTypes: ['String', 'DateTime', 'Integer'] },
  { operator: 'Contains', applicableTypes: ['String'] },
  { operator: 'NotContains', applicableTypes: ['String'] },
  { operator: 'LessThan', applicableTypes: ['DateTime', 'Integer'] },
  { operator: 'LessThanEqualTo', applicableTypes: ['DateTime', 'Integer'] },
  { operator: 'GreaterThan', applicableTypes: ['DateTime', 'Integer'] },
  { operator: 'GreaterThanEqualTo', applicableTypes: ['DateTime', 'Integer'] },
] as const

const TYPE_OF = new Map<string, string>(PROPERTIES.map((p) => [p.alias, p.type]))

/** The accessor on a `PublishedContent` that each property names. */
const ACCESSOR: Record<string, string> = {
  Id: 'id',
  Name: 'name',
  CreateDate: 'createDate',
  UpdateDate: 'updateDate',
}

const quote = (value: string) => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`

/** A filter as a TypeScript predicate over `item`. */
function predicate(filter: TemplateQueryFilter): string | undefined {
  const accessor = ACCESSOR[filter.propertyAlias]
  const type = TYPE_OF.get(filter.propertyAlias)
  if (!accessor || !type) return undefined
  const left = `item.${accessor}`
  const value = filter.constraintValue

  if (type === 'String') {
    const right = quote(value)
    switch (filter.operator) {
      case 'Equals':
        return `${left} === ${right}`
      case 'NotEquals':
        return `${left} !== ${right}`
      case 'Contains':
        return `${left}.includes(${right})`
      case 'NotContains':
        return `!${left}.includes(${right})`
      default:
        return undefined
    }
  }

  // A date compares as a number, which is also what `Integer` already is.
  const left_ = type === 'DateTime' ? `${left}.getTime()` : left
  const right_ =
    type === 'DateTime' ? `new Date(${quote(value)}).getTime()` : String(Number(value) || 0)
  switch (filter.operator) {
    case 'Equals':
      return `${left_} === ${right_}`
    case 'NotEquals':
      return `${left_} !== ${right_}`
    case 'LessThan':
      return `${left_} < ${right_}`
    case 'LessThanEqualTo':
      return `${left_} <= ${right_}`
    case 'GreaterThan':
      return `${left_} > ${right_}`
    case 'GreaterThanEqualTo':
      return `${left_} >= ${right_}`
    default:
      return undefined
  }
}

/** A sort as the comparator `Array.prototype.sort` takes. */
function comparator(sort: TemplateQuerySort): string | undefined {
  const accessor = ACCESSOR[sort.propertyAlias]
  const type = TYPE_OF.get(sort.propertyAlias)
  if (!accessor || !type) return undefined
  const [first, second] = sort.direction?.toLowerCase() === 'descending' ? ['b', 'a'] : ['a', 'b']
  if (type === 'String') return `${first}.${accessor}.localeCompare(${second}.${accessor})`
  if (type === 'DateTime') return `${first}.${accessor}.getTime() - ${second}.${accessor}.getTime()`
  return `${first}.${accessor} - ${second}.${accessor}`
}

/**
 * The snippet itself.
 *
 * `?? model` rather than a guard on the lookup: a key that no longer resolves
 * falls back to the page being rendered, so the component still compiles and
 * still renders something.
 */
export function queryExpression(request: TemplateQueryRequest): string {
  const from = request.rootKey
    ? `nav.children(nav.byKey(${quote(request.rootKey)}) ?? model)`
    : 'nav.children(model)'
  const lines = [`const selection = ${from}`]
  if (request.documentTypeAlias)
    lines.push(
      `  .filter((item) => item.contentType.alias === ${quote(request.documentTypeAlias)})`,
    )
  for (const filter of request.filters) {
    const expression = predicate(filter)
    if (expression) lines.push(`  .filter((item) => ${expression})`)
  }
  const sort = request.sort ? comparator(request.sort) : undefined
  if (sort) lines.push(`  .sort((a, b) => ${sort})`)
  lines.push(`  .slice(0, ${request.take})`)
  return lines.join('\n')
}

export function registerTemplateQueryHandlers(
  router: ManagementApiRouter,
  port: TemplateQueryPort,
): void {
  router.handle('GetTemplateQuerySettings', async () => {
    const documentTypeAliases = await port.documentTypeAliases()
    return Response.json({
      documentTypeAliases,
      properties: PROPERTIES.map((property) => ({ ...property })),
      operators: OPERATORS.map((operator) => ({
        operator: operator.operator,
        applicableTypes: [...operator.applicableTypes],
      })),
    } as ResponseOf<'GetTemplateQuerySettings'>)
  })

  router.handle('PostTemplateQueryExecute', async (ctx) => {
    const body = (await ctx.request.json()) as Record<string, unknown>
    const root = body.rootDocument as { id?: unknown } | null | undefined
    const request: TemplateQueryRequest = {
      rootKey: typeof root?.id === 'string' ? root.id : null,
      documentTypeAlias:
        typeof body.documentTypeAlias === 'string' && body.documentTypeAlias
          ? body.documentTypeAlias
          : null,
      filters: (Array.isArray(body.filters) ? body.filters : [])
        .map((filter) => filter as Record<string, unknown>)
        .filter((filter) => typeof filter.propertyAlias === 'string' && filter.propertyAlias)
        .map((filter) => ({
          propertyAlias: String(filter.propertyAlias),
          constraintValue: String(filter.constraintValue ?? ''),
          operator: String(filter.operator ?? 'Equals'),
        })),
      sort:
        body.sort && typeof (body.sort as Record<string, unknown>).propertyAlias === 'string'
          ? {
              propertyAlias: String((body.sort as Record<string, unknown>).propertyAlias),
              direction: ((body.sort as Record<string, unknown>).direction as string) ?? null,
            }
          : null,
      take: Number(body.take) > 0 ? Number(body.take) : 10,
    }

    const started = Bun.nanoseconds()
    const result = await port.execute(request)
    // Milliseconds, as the contract's `int64` and the client's label expect.
    const executionTime = Math.round((Bun.nanoseconds() - started) / 1_000_000)

    return Response.json({
      queryExpression: queryExpression(request),
      sampleResults: result.items.map((item) => ({ icon: item.icon, name: item.name })),
      resultCount: result.total,
      executionTime,
    } as ResponseOf<'PostTemplateQueryExecute'>)
  })
}
