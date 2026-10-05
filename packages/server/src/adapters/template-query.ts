/**
 * Runs what the template query builder describes.
 *
 * Against the published cache and through `Navigation`, because that is what a
 * component renders from: the count and the sample the builder shows are then
 * the answer the snippet it wrote would give, not a second implementation that
 * can drift from it.
 */
import type {
  TemplateQueryFilter,
  TemplateQueryPort,
  TemplateQueryRequest,
  TemplateQuerySort,
} from '@bunbraco/api-management'
import type { ContentTypeRepository } from '@bunbraco/data'
import type { PublishedCache, PublishedContent } from '@bunbraco/render'

/** The accessor each queryable property names, and how it compares. */
const FIELDS: Record<
  string,
  { of: (content: PublishedContent) => string | number; text: boolean }
> = {
  Id: { of: (content) => content.id, text: false },
  Name: { of: (content) => content.name, text: true },
  CreateDate: { of: (content) => content.createDate.getTime(), text: false },
  UpdateDate: { of: (content) => content.updateDate.getTime(), text: false },
}

function matches(content: PublishedContent, filter: TemplateQueryFilter): boolean {
  const field = FIELDS[filter.propertyAlias]
  if (!field) return true
  const left = field.of(content)

  if (field.text) {
    const right = filter.constraintValue
    const text = String(left)
    switch (filter.operator) {
      case 'Equals':
        return text === right
      case 'NotEquals':
        return text !== right
      case 'Contains':
        return text.includes(right)
      case 'NotContains':
        return !text.includes(right)
      default:
        return true
    }
  }

  const right = filter.propertyAlias.endsWith('Date')
    ? new Date(filter.constraintValue).getTime()
    : Number(filter.constraintValue)
  // An unparseable constraint filters nothing out rather than everything: the
  // builder sends what has been typed so far, half-finished dates included.
  if (Number.isNaN(right)) return true
  const value = Number(left)
  switch (filter.operator) {
    case 'Equals':
      return value === right
    case 'NotEquals':
      return value !== right
    case 'LessThan':
      return value < right
    case 'LessThanEqualTo':
      return value <= right
    case 'GreaterThan':
      return value > right
    case 'GreaterThanEqualTo':
      return value >= right
    default:
      return true
  }
}

function compare(sort: TemplateQuerySort): (a: PublishedContent, b: PublishedContent) => number {
  const field = FIELDS[sort.propertyAlias]
  if (!field) return () => 0
  const descending = sort.direction?.toLowerCase() === 'descending'
  return (a, b) => {
    const [first, second] = descending ? [b, a] : [a, b]
    const left = field.of(first)
    const right = field.of(second)
    if (field.text) return String(left).localeCompare(String(right))
    return Number(left) - Number(right)
  }
}

export function createTemplateQueryPort(options: {
  cache: PublishedCache
  types: ContentTypeRepository
}): TemplateQueryPort {
  return {
    async documentTypeAliases() {
      const all = await options.types.all()
      return (
        all
          // An element type is never routed to, so a query cannot return one.
          .filter((type) => !type.isElement)
          .map((type) => type.alias)
          .sort((a, b) => a.localeCompare(b))
      )
    },

    async execute(request: TemplateQueryRequest) {
      const nav = await options.cache.navigation()
      const root = request.rootKey ? nav.byKey(request.rootKey) : undefined
      // No root picked means "below the page this renders on", which has no one
      // answer here — the site's own roots are the closest honest stand-in.
      const from = root ? nav.children(root) : nav.root().flatMap((node) => nav.children(node))

      let found = from
      if (request.documentTypeAlias)
        found = found.filter((item) => item.contentType.alias === request.documentTypeAlias)
      for (const filter of request.filters) found = found.filter((item) => matches(item, filter))
      if (request.sort) found = [...found].sort(compare(request.sort))

      return {
        total: found.length,
        items: found.slice(0, request.take).map((item) => ({
          icon: 'icon-document',
          name: item.name,
        })),
      }
    },
  }
}
