/**
 * URL segment generation.
 *
 * Mirrors Umbraco's DefaultUrlSegmentProvider: the `umbracoUrlName` property wins
 * if set, otherwise the name is slugified — diacritics folded, lowercased, and
 * separated with hyphens.
 */
export const URL_NAME_ALIAS = 'umbracoUrlName'

export function toUrlSegment(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function urlSegmentFor(name: string, urlNameOverride?: string | null): string {
  const source = urlNameOverride && urlNameOverride.trim().length > 0 ? urlNameOverride : name
  return toUrlSegment(source)
}

/** Joins segments into a site-root-relative path, always with a leading slash. */
export function joinPath(segments: readonly string[]): string {
  const parts = segments.filter((segment) => segment.length > 0)
  return parts.length === 0 ? '/' : `/${parts.join('/')}`
}
