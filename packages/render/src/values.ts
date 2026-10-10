/**
 * What templates get for structured property values: Umbraco's published value
 * converters. A picker yields the content it points at, a link picker yields
 * links with their URLs resolved, and block editors yield element models with
 * the same `value()` API as a page.
 */
import { keyFromReference, type SchemaForm } from '@bunbraco/core'
import { RawHtml } from './html.ts'
import { ImageCropperValue, MediaWithCrops, PublishedMedia } from './media.ts'
import type { PublishedProperty } from './model.ts'

/** What conversion needs from the published cache. */
export interface ValueContext<Content = unknown, Media = unknown> {
  content(key: string): Content | undefined
  /**
   * A form definition by key. Absent until the renderer is given one, which is
   * what makes a `formPicker` resolve to the form rather than to its key.
   */
  form?(key: string): SchemaForm | undefined
  /** Absent until the cache knows media. */
  media?(key: string): Media | undefined
  /** A published library element by key; absent until the cache knows them. */
  element?(key: string): PublishedElement | undefined
  /** A document type's alias by key, which is all a block records of its element type. */
  contentTypeAlias?(key: string): string | undefined
  /** A content URL, for links. */
  urlOf(content: Content): string
  mediaUrlOf?(media: Media): string
}

export interface Link {
  name: string
  url: string
  target: string | null
  type: 'document' | 'media' | 'external'
  /** The linked item's key; null for an external link. */
  key: string | null
}

export interface BlockItem {
  contentKey: string
  content: PublishedElement
  settingsKey: string | null
  settings: PublishedElement | null
}

export interface BlockGridArea {
  key: string
  items: BlockGridItem[]
}

export interface BlockGridItem extends BlockItem {
  columnSpan: number | null
  rowSpan: number | null
  areas: BlockGridArea[]
}

const references = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap((v) => (typeof v === 'string' ? [v] : []))
  if (typeof value === 'string')
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  return []
}

/** One block's content or settings: an element with properties, but no URL or place in the tree. */
export class PublishedElement {
  readonly key: string
  readonly contentType: { key: string; alias: string | null }
  readonly properties: PublishedProperty[]
  #context: ValueContext | undefined

  constructor(
    init: {
      key: string
      contentTypeKey: string
      contentTypeAlias?: string | null
      properties: PublishedProperty[]
    },
    context?: ValueContext,
  ) {
    this.key = init.key
    this.contentType = { key: init.contentTypeKey, alias: init.contentTypeAlias ?? null }
    this.properties = init.properties
    this.#context = context
  }

  value(alias: string): unknown {
    const property = this.properties.find((p) => p.alias === alias)
    if (!property) return null
    return convertValue(property.editorAlias, property.value, this.#context, property.config)
  }

  text(alias: string): string {
    const value = this.value(alias)
    return value === null || value === undefined ? '' : String(value)
  }

  html(alias: string): RawHtml {
    return new RawHtml(this.text(alias))
  }
}

/** An element whose `value()` knows its properties, as `bunbraco generate` types block content. */
export interface TypedElement<Properties> extends PublishedElement {
  value<Alias extends keyof Properties & string>(alias: Alias): Properties[Alias]
}

interface BlockData {
  key: string
  contentTypeKey: string
  values?: Array<{
    alias: string
    value: unknown
    editorAlias?: string
    culture?: string | null
    segment?: string | null
  }>
}

interface BlockLayout {
  contentKey?: string
  settingsKey?: string | null
  columnSpan?: number
  rowSpan?: number
  areas?: Array<{ key: string; items?: BlockLayout[] }>
}

interface BlockValue {
  layout?: Record<string, BlockLayout[] | undefined>
  contentData?: BlockData[]
  settingsData?: BlockData[]
}

function elementFrom(data: BlockData | undefined, context?: ValueContext): PublishedElement | null {
  if (!data) return null
  return new PublishedElement(
    {
      key: data.key,
      contentTypeKey: data.contentTypeKey,
      contentTypeAlias: context?.contentTypeAlias?.(data.contentTypeKey) ?? null,
      properties: (data.values ?? []).map((v) => ({
        alias: v.alias,
        editorAlias: v.editorAlias ?? '',
        culture: v.culture ?? null,
        segment: v.segment ?? null,
        value: v.value,
      })),
    },
    context,
  )
}

function blockItems<T extends BlockItem>(
  value: unknown,
  layoutAlias: string,
  context: ValueContext | undefined,
  extend: (layout: BlockLayout, item: BlockItem, build: (layouts: BlockLayout[]) => T[]) => T,
): T[] {
  if (!value || typeof value !== 'object') return []
  const block = value as BlockValue
  const contents = new Map((block.contentData ?? []).map((d) => [d.key, d]))
  const settings = new Map((block.settingsData ?? []).map((d) => [d.key, d]))
  const build = (layouts: BlockLayout[]): T[] =>
    layouts.flatMap((layout) => {
      const content = elementFrom(contents.get(layout.contentKey ?? ''), context)
      if (!content) return []
      const item: BlockItem = {
        contentKey: content.key,
        content,
        settingsKey: layout.settingsKey ?? null,
        settings: elementFrom(settings.get(layout.settingsKey ?? ''), context),
      }
      return [extend(layout, item, build)]
    })
  return build(block.layout?.[layoutAlias] ?? [])
}

/**
 * Schemes a link picked in the backoffice may use on the front end.
 *
 * A link's URL is typed by an editor and ends up in an `href`, where escaping
 * does nothing about the scheme: `javascript:` there runs for every visitor.
 * Relative and fragment URLs have no scheme and are left alone.
 */
const SAFE_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:', 'ftp:'])

function safeExternalUrl(url: string): string {
  const trimmed = url.trim()
  if (trimmed === '') return ''
  // No scheme: a path, a fragment or a protocol-relative URL, none of which can
  // carry script. `new URL` needs a base to judge those, so they are let through
  // without one rather than guessed at.
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) return trimmed
  try {
    return SAFE_LINK_SCHEMES.has(new URL(trimmed).protocol) ? trimmed : ''
  } catch {
    return ''
  }
}

const LOCAL_LINK = /\/?(?:\{|%7B)localLink:(?:umb:\/\/[a-z-]+\/)?([0-9a-fA-F-]{32,36})(?:\}|%7D)/g

/**
 * Rich text links to pages and media are stored as `/{localLink:<key>}`, so a
 * move or rename never breaks them; they become URLs when rendered. A link to
 * something unpublished or gone becomes `#`.
 */
export function resolveLocalLinks(markup: string, context?: ValueContext): string {
  return markup.replace(LOCAL_LINK, (_, reference: string) => {
    const key = keyFromReference(reference)
    if (!key || !context) return '#'
    const content = context.content(key)
    if (content) return context.urlOf(content)
    const media = context.media?.(key)
    return media && context.mediaUrlOf ? context.mediaUrlOf(media) : '#'
  })
}

/** A stored (editor-shaped) value as a template receives it. */
export function convertValue(
  editorAlias: string,
  value: unknown,
  context?: ValueContext,
  config: Record<string, unknown> = {},
): unknown {
  if (value === null || value === undefined) return value
  switch (editorAlias) {
    case 'Umbraco.MediaPicker3': {
      const picks = (Array.isArray(value) ? value : []).flatMap((raw) => {
        const pick = raw as Record<string, unknown>
        const key = keyFromReference(pick.mediaKey)
        const media = key ? context?.media?.(key) : undefined
        return media instanceof PublishedMedia ? [new MediaWithCrops(media, pick)] : []
      })
      return config.multiple === false ? (picks[0] ?? null) : picks
    }
    case 'Umbraco.RichText':
      return typeof value === 'string' ? resolveLocalLinks(value, context) : value
    case 'Umbraco.ImageCropper':
      return typeof value === 'object' || typeof value === 'string'
        ? new ImageCropperValue(typeof value === 'string' ? { src: value } : (value as object))
        : value
    // A form definition is a file, so there is nothing in the content cache to
    // resolve against: the lookup reads `schema/forms/`. Without one the raw key
    // comes back, which is what a unit test sees.
    case 'Bunbraco.FormPicker': {
      const key = typeof value === 'string' ? value.trim() : ''
      if (!key) return null
      return context?.form?.(key) ?? null
    }
    case 'Umbraco.ContentPicker': {
      const key = keyFromReference(value)
      return (key && context?.content(key)) ?? null
    }
    /**
     * The Library's own picker. Umbraco stores a bare `Guid[]` here rather than the
     * `umb://…` references a content picker stores, and always yields a collection
     * even where the configuration allows one pick — so a template writes `[0]` for
     * a single. An element the culture cannot see is simply absent from this
     * culture's view, which is the drop Umbraco's converter does explicitly.
     */
    case 'Umbraco.ElementPicker':
      return references(value).flatMap((reference) => {
        const key = keyFromReference(reference)
        const found = key ? context?.element?.(key) : undefined
        return found ? [found] : []
      })
    case 'Umbraco.MultiNodeTreePicker':
      return references(value).flatMap((reference) => {
        const key = keyFromReference(reference)
        const found = key ? (context?.content(key) ?? context?.media?.(key)) : undefined
        return found ? [found] : []
      })
    case 'Umbraco.MultiUrlPicker': {
      if (!Array.isArray(value)) return []
      return value.flatMap((raw): Link[] => {
        const link = raw as Record<string, unknown>
        const key = keyFromReference(link.unique ?? link.udi)
        const type = link.type === 'media' ? 'media' : key ? 'document' : 'external'
        const queryString = typeof link.queryString === 'string' ? link.queryString : ''
        let url: string | undefined
        if (type === 'document' && key) {
          const content = context?.content(key)
          if (!content) return []
          url = context?.urlOf(content)
        } else if (type === 'media' && key) {
          const media = context?.media?.(key)
          if (!media) return []
          url = context?.mediaUrlOf?.(media)
        } else url = safeExternalUrl(typeof link.url === 'string' ? link.url : '')
        return [
          {
            name: typeof link.name === 'string' ? link.name : '',
            url: `${url ?? ''}${queryString}`,
            target: typeof link.target === 'string' && link.target ? link.target : null,
            type,
            key: key ?? null,
          },
        ]
      })
    }
    case 'Umbraco.BlockList':
      return blockItems<BlockItem>(value, 'Umbraco.BlockList', context, (_, item) => item)
    case 'Umbraco.BlockGrid':
      return blockItems<BlockGridItem>(
        value,
        'Umbraco.BlockGrid',
        context,
        (layout, item, build) => ({
          ...item,
          columnSpan: layout.columnSpan ?? null,
          rowSpan: layout.rowSpan ?? null,
          areas: (layout.areas ?? []).map((area) => ({
            key: area.key,
            items: build(area.items ?? []),
          })),
        }),
      )
    default:
      return value
  }
}
