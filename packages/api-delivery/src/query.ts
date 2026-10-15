/**
 * The query endpoints' `fetch`, `filter` and `sort`, parsed as Umbraco 18.2
 * parses them: content and media differ, and so do their errors.
 * docs/delivery-api.md, "Queries".
 */

export type Selector =
  | { kind: 'all' }
  | { kind: 'ancestors' | 'children' | 'descendants'; target: string }

export type ContentFilter =
  | { kind: 'contentType'; values: string[]; negate: boolean }
  | { kind: 'name'; values: string[]; negate: boolean }
  | {
      kind: 'createDate' | 'updateDate'
      operator: '=' | '>' | '>=' | '<' | '<=' | 'none'
      date: Date
    }

export type SortField = 'createDate' | 'updateDate' | 'level' | 'name' | 'sortOrder'
export interface Sort {
  field: SortField
  ascending: boolean
}

export type QueryError = 'selector' | 'filter' | 'sort'

export const QUERY_ERRORS: Record<QueryError, { title: string; detail: string }> = {
  selector: {
    title: 'Selector option not found',
    detail: "The attempted 'fetch' option does not exist",
  },
  filter: {
    title: 'Filter option not found',
    detail: "One of the attempted 'filter' options does not exist",
  },
  sort: {
    title: 'Sort option not found',
    detail: "One of the attempted 'sort' options does not exist",
  },
}

/** `ancestors:`, `children:` or `descendants:` and what follows; absent is everything. Pure. */
export function parseContentSelector(fetch: string | null): Selector | QueryError {
  if (fetch === null || fetch === '') return { kind: 'all' }
  const match = /^(ancestors|children|descendants):(.*)$/is.exec(fetch)
  if (!match) return 'selector'
  return {
    kind: (match[1] as string).toLowerCase() as 'ancestors' | 'children' | 'descendants',
    target: (match[2] as string).trim(),
  }
}

const DATE_FILTER = /(createDate|updateDate)(?<operator>[><:]{1,2})(?<value>.*)/i

/** Every filter, or which kind of error; an unparsable date is dropped, as Umbraco drops it. Pure. */
export function parseContentFilters(filters: readonly string[]): ContentFilter[] | QueryError {
  const out: ContentFilter[] = []
  for (const raw of filters) {
    if (!raw.trim()) continue
    const listed = /^(contentType|name):(!?)(.*)$/is.exec(raw)
    if (listed) {
      out.push({
        kind: (listed[1] as string).toLowerCase() === 'name' ? 'name' : 'contentType',
        negate: listed[2] === '!',
        values: (listed[3] as string).split(',').filter((v) => v !== ''),
      })
      continue
    }
    const dated = DATE_FILTER.exec(raw)
    if (dated?.groups) {
      const field = dated[1]?.toLowerCase() === 'createdate' ? 'createDate' : 'updateDate'
      const date = new Date(dated.groups.value as string)
      if (Number.isNaN(date.getTime())) continue
      const operator =
        ({ ':': '=', '>': '>', '>:': '>=', '<': '<', '<:': '<=' } as const)[
          dated.groups.operator as ':'
        ] ?? 'none'
      out.push({ kind: field, operator, date })
      continue
    }
    return 'filter'
  }
  return out
}

const SORT_FIELDS: Record<string, SortField> = {
  createdate: 'createDate',
  updatedate: 'updateDate',
  level: 'level',
  name: 'name',
  sortorder: 'sortOrder',
}

/** In order, primary first; ascending only when the direction starts with `asc`. Pure. */
export function parseContentSorts(sorts: readonly string[]): Sort[] | QueryError {
  const out: Sort[] = []
  for (const raw of sorts) {
    if (!raw.trim()) continue
    const at = raw.indexOf(':')
    const field = at < 0 ? undefined : SORT_FIELDS[raw.slice(0, at).toLowerCase()]
    if (!field) return 'sort'
    out.push({ field, ascending: raw.slice(at + 1).startsWith('asc') })
  }
  return out
}

/** Media's own rules: `children:` is required, filters are `key:value`, the last sort wins. Pure. */
export function parseMediaQuery(input: {
  fetch: string | null
  filters: readonly string[]
  sorts: readonly string[]
}):
  | {
      parent: string
      filters: Array<{ kind: 'mediaType' | 'name'; value: string }>
      sort: Sort | undefined
    }
  | QueryError {
  const fetch = /^children:(.*)$/is.exec(input.fetch ?? '')
  if (!fetch) return 'selector'
  const filters: Array<{ kind: 'mediaType' | 'name'; value: string }> = []
  for (const raw of input.filters) {
    const parts = raw.split(':')
    if (parts.length !== 2 || (parts[0] !== 'mediaType' && parts[0] !== 'name')) return 'filter'
    filters.push({ kind: parts[0], value: parts[1] as string })
  }
  let sort: Sort | undefined
  for (const raw of input.sorts) {
    const parts = raw.split(':')
    const fields: Record<string, SortField> = {
      createDate: 'createDate',
      updateDate: 'updateDate',
      name: 'name',
      sortOrder: 'sortOrder',
    }
    const field = parts.length === 2 ? fields[parts[0] as string] : undefined
    if (!field) return 'sort'
    sort = { field, ascending: (parts[1] as string).startsWith('asc') }
  }
  return { parent: (fetch[1] as string).trim(), filters, sort }
}

/** The comparison a sort makes, for anything with these fields. Pure. */
export function compareBy<
  T extends { createDate: Date; updateDate: Date; level: number; name: string; sortOrder: number },
>(sorts: readonly Sort[]): (a: T, b: T) => number {
  return (a, b) => {
    for (const { field, ascending } of sorts) {
      const left = field === 'name' ? a.name.toLowerCase() : a[field]
      const right = field === 'name' ? b.name.toLowerCase() : b[field]
      const order =
        left instanceof Date && right instanceof Date
          ? left.getTime() - right.getTime()
          : left < right
            ? -1
            : left > right
              ? 1
              : 0
      if (order !== 0) return ascending ? order : -order
    }
    return 0
  }
}

/** Whether an item passes every content filter: the filters AND, each one's values OR. Pure. */
export function passesFilters(
  item: { contentType: string; name: string; createDate: Date; updateDate: Date },
  filters: readonly ContentFilter[],
): boolean {
  return filters.every((filter) => {
    if (filter.kind === 'contentType') {
      const hit = filter.values.includes(item.contentType)
      return filter.negate ? !hit : hit
    }
    if (filter.kind === 'name') {
      const name = item.name.toLowerCase()
      const hit = filter.values.some((v) => name.includes(v.toLowerCase()))
      return filter.negate ? !hit : hit
    }
    const at = item[filter.kind].getTime()
    const to = filter.date.getTime()
    switch (filter.operator) {
      case '=':
        return at === to
      case '>':
        return at > to
      case '>=':
        return at >= to
      case '<':
        return at < to
      case '<=':
        return at <= to
      default:
        return false
    }
  })
}
