/** Umbraco's universal paging envelope. `total` is int64 in the contract. */
export interface PagedViewModel<T> {
  total: number
  items: T[]
}

export const DEFAULT_TAKE = 100

export interface SkipTake {
  skip: number
  take: number
}

export type SkipTakeResult = { ok: true; value: SkipTake } | { ok: false }

export function parseSkipTake(params: URLSearchParams, defaultTake = DEFAULT_TAKE): SkipTakeResult {
  const skip = Number(params.get('skip') ?? 0)
  const take = Number(params.get('take') ?? defaultTake)
  if (!Number.isInteger(skip) || !Number.isInteger(take) || skip < 0 || take < 0)
    return { ok: false }
  if (take > 0 && skip % take !== 0) return { ok: false }
  return { ok: true, value: { skip, take } }
}

export function paged<T>(items: T[], total: number): PagedViewModel<T> {
  return { total, items }
}
