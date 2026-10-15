/**
 * The JSON the Delivery API answers with, built from what the published cache
 * holds: content, media, links, blocks and each editor's value, in Umbraco
 * 18.2's shapes. docs/delivery-api.md, "Output".
 */
import {
  type BlockGridItem,
  type BlockItem,
  convertValue,
  ImageCropperValue,
  type Link,
  MediaWithCrops,
  PublishedContent,
  type PublishedElement,
  PublishedMedia,
  type PublishedProperty,
  RawHtml,
} from '@crombolo/render'
import { type ExpansionNode, keeps, nextNode } from './expansion.ts'
import type { Access } from './protection.ts'

export interface ApiRoute {
  path: string
  queryString: string | null
  startItem: { id: string; path: string }
}

/** What building output needs from the request and the cache. */
export interface OutputContext {
  /** The route of a page in the request's culture; undefined when it has none. */
  route(content: PublishedContent): ApiRoute | undefined
  /** A page by key, in the request's culture. */
  content(key: string): PublishedContent | undefined
  allowedType(alias: string): boolean
  /** Whether the caller may see a page's properties when a reference to it is expanded. */
  access(content: PublishedContent): Access
}

const iso = (date: Date): string => date.toISOString()

/** A property's stored shape and settings, for the one alias in the culture in scope. */
function propertyOf(
  properties: readonly PublishedProperty[],
  alias: string,
  culture: string | null,
): PublishedProperty | undefined {
  const own = properties.filter((p) => p.alias === alias)
  return (
    own.find((p) => p.culture && culture && p.culture.toLowerCase() === culture.toLowerCase()) ??
    own.find((p) => p.culture === null) ??
    own[0]
  )
}

const empty = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  value === '' ||
  (Array.isArray(value) && value.length === 0)

/** A page as a reference: everything but `cultures`, its properties only when expanded. */
export function apiContent(
  content: PublishedContent,
  ctx: OutputContext,
  expand: ExpansionNode | undefined,
  include: ExpansionNode | undefined,
  topLevel = false,
): Record<string, unknown> | null {
  const route = ctx.route(content)
  if (!route) return null
  const showProperties = topLevel || (expand !== undefined && ctx.access(content) === 'allowed')
  return {
    contentType: content.contentType.alias,
    name: content.name,
    createDate: iso(content.createDate),
    updateDate: iso(content.updateDate),
    route,
    id: content.key,
    properties: showProperties ? properties(content, ctx, expand, include) : {},
  }
}

function properties(
  item: PublishedContent | PublishedElement,
  ctx: OutputContext,
  expand: ExpansionNode | undefined,
  include: ExpansionNode | undefined,
): Record<string, unknown> {
  const culture = item instanceof PublishedContent ? item.culture : null
  const out: Record<string, unknown> = {}
  const aliases = [...new Set(item.properties.map((p) => p.alias))]
  for (const alias of aliases) {
    if (!keeps(include, alias)) continue
    const property = propertyOf(item.properties, alias, culture) as PublishedProperty
    const converted = item.value(alias)
    out[alias] = deliveryValue(
      property,
      converted,
      ctx,
      nextNode(expand, alias),
      include === undefined || include.children.length === 0 ? include : nextNode(include, alias),
    )
  }
  return out
}

/** An element (a block, a library element): its properties are always mapped. */
function apiElement(
  element: PublishedElement | null,
  ctx: OutputContext,
  expand: ExpansionNode | undefined,
  include: ExpansionNode | undefined,
): Record<string, unknown> | null {
  if (!element) return null
  return {
    contentType: element.contentType.alias ?? '',
    id: element.key,
    name: '',
    properties: properties(element, ctx, expand, include ?? { key: '', children: [] }),
  }
}

const numberOf = (media: PublishedMedia, alias: string): number | null => {
  const value = Number(media.value(alias))
  return media.value(alias) === null || Number.isNaN(value) ? null : value
}

/** Media's own fields; its properties exclude the `umbraco*` ones, and appear only when expanded. */
function mediaCore(
  media: PublishedMedia,
  expand: ExpansionNode | undefined,
  topLevel: boolean,
): Record<string, unknown> {
  const extension = media.value('umbracoExtension')
  return {
    id: media.key,
    name: media.name,
    mediaType: media.mediaType.alias,
    url: media.url,
    extension: typeof extension === 'string' && extension ? extension : null,
    width: numberOf(media, 'umbracoWidth'),
    height: numberOf(media, 'umbracoHeight'),
    bytes: numberOf(media, 'umbracoBytes'),
    properties: topLevel || expand !== undefined ? mediaProperties(media) : {},
  }
}

function mediaProperties(media: PublishedMedia): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const property of media.properties) {
    if (property.alias.toLowerCase().startsWith('umbraco')) continue
    const value = convertValue(property.editorAlias, property.value, undefined, property.config)
    out[property.alias] = empty(value) ? null : plain(value)
  }
  return out
}

const crops = (value: ImageCropperValue) =>
  value.crops.map((crop) => ({
    alias: crop.alias,
    width: crop.width,
    height: crop.height,
    coordinates: crop.coordinates ?? null,
  }))

/** A media item as a query or item endpoint answers it: its tree path, dates, crops. */
export function apiMediaResponse(media: PublishedMedia, path: string): Record<string, unknown> {
  const image = media.image
  return {
    path,
    createDate: iso(media.createDate),
    updateDate: iso(media.updateDate),
    ...mediaCore(media, undefined, true),
    focalPoint: image.focalPoint,
    crops: image.src || image.crops.length > 0 ? crops(image) : null,
  }
}

function mediaWithCrops(
  pick: MediaWithCrops,
  expand: ExpansionNode | undefined,
): Record<string, unknown> {
  // The pick's own crops and focal point win; the media's fill in what it lacks.
  const own = pick.media.image
  const merged = own.crops.map((crop) => {
    const local = pick.crops.find((c) => c.alias === crop.alias)
    return local ? { ...crop, ...local, coordinates: local.coordinates ?? crop.coordinates } : crop
  })
  return {
    focalPoint: pick.focalPoint ?? own.focalPoint ?? null,
    crops: crops(new ImageCropperValue({ crops: merged })),
    ...mediaCore(pick.media, expand, false),
  }
}

function link(linkValue: Link, ctx: OutputContext): Record<string, unknown> | null {
  if (linkValue.type === 'document' && linkValue.key) {
    const target = ctx.content(linkValue.key)
    if (!target) return null
    const route = ctx.route(target)
    if (!route) return null
    return {
      url: null,
      queryString: null,
      title: linkValue.name || target.name,
      target: linkValue.target,
      destinationId: target.key,
      destinationType: target.contentType.alias,
      route,
      linkType: 'Content',
      culture: target.culture,
    }
  }
  return {
    url: linkValue.url,
    queryString: null,
    title: linkValue.name,
    target: linkValue.target,
    destinationId: linkValue.key,
    destinationType: linkValue.type === 'media' ? 'Media' : null,
    route: null,
    linkType: linkValue.type === 'media' ? 'Media' : 'External',
    culture: null,
  }
}

function blockItem(
  item: BlockItem,
  ctx: OutputContext,
  expand: ExpansionNode | undefined,
  include: ExpansionNode | undefined,
) {
  return {
    content: apiElement(item.content, ctx, expand, include),
    settings: apiElement(item.settings, ctx, expand, include),
  }
}

function gridItem(
  item: BlockGridItem,
  ctx: OutputContext,
  columns: number,
  expand: ExpansionNode | undefined,
  include: ExpansionNode | undefined,
): Record<string, unknown> {
  return {
    rowSpan: item.rowSpan ?? 1,
    columnSpan: item.columnSpan ?? columns,
    areaGridColumns: columns,
    areas: item.areas.map((area) => ({
      alias: area.key,
      rowSpan: 1,
      columnSpan: columns,
      items: area.items.map((inner) => gridItem(inner, ctx, columns, expand, include)),
    })),
    ...blockItem(item, ctx, expand, include),
  }
}

/** What a value is when nothing more specific applies: dates as ISO, markup as text. */
function plain(value: unknown): unknown {
  if (value instanceof Date) return iso(value)
  if (value instanceof RawHtml) return value.value
  if (value instanceof ImageCropperValue)
    return { url: value.src || null, focalPoint: value.focalPoint, crops: crops(value) }
  if (Array.isArray(value)) return value.map(plain)
  return value
}

const list = <T>(value: unknown): T[] =>
  Array.isArray(value) ? (value as T[]) : value === null || value === undefined ? [] : [value as T]

/** One property's Delivery API value. Empty is `null`, as in Umbraco. */
export function deliveryValue(
  property: PublishedProperty,
  converted: unknown,
  ctx: OutputContext,
  expand: ExpansionNode | undefined,
  include: ExpansionNode | undefined,
): unknown {
  if (empty(property.value) || empty(converted)) return null
  const config = property.config ?? {}
  switch (property.editorAlias) {
    case 'Umbraco.MemberPicker':
      return '(unsupported)'
    case 'Umbraco.RichText':
      return { markup: plain(converted), blocks: [] }
    case 'Umbraco.ContentPicker': {
      const content = converted instanceof PublishedContent ? converted : undefined
      if (!content || !ctx.allowedType(content.contentType.alias)) return null
      return apiContent(content, ctx, expand, include)
    }
    case 'Umbraco.MultiNodeTreePicker':
      return list<unknown>(converted).flatMap((item) => {
        if (item instanceof PublishedContent)
          return ctx.allowedType(item.contentType.alias)
            ? [apiContent(item, ctx, expand, include)].filter(Boolean)
            : []
        if (item instanceof PublishedMedia) return [mediaCore(item, expand, false)]
        return []
      })
    case 'Umbraco.MediaPicker3':
      return list<MediaWithCrops>(converted)
        .filter((pick) => pick instanceof MediaWithCrops)
        .map((pick) => mediaWithCrops(pick, expand))
    case 'Umbraco.MultiUrlPicker':
      return list<Link>(converted).flatMap((l) => {
        const built = link(l, ctx)
        return built ? [built] : []
      })
    case 'Umbraco.BlockList':
      return { items: list<BlockItem>(converted).map((i) => blockItem(i, ctx, expand, include)) }
    case 'Umbraco.BlockGrid': {
      const columns = Number(config.gridColumns) || 12
      return {
        gridColumns: columns,
        items: list<BlockGridItem>(converted).map((i) =>
          gridItem(i, ctx, columns, expand, include),
        ),
      }
    }
    case 'Umbraco.ElementPicker':
      return list<PublishedElement>(converted).map((e) => apiElement(e, ctx, expand, include))
    case 'Umbraco.DropDown.Flexible': {
      const values = list<string>(converted)
      return config.multiple === true ? values : (values[0] ?? null)
    }
    case 'Umbraco.CheckBoxList':
    case 'Umbraco.MultipleTextstring':
    case 'Umbraco.Tags':
      return list<string>(converted)
    case 'Umbraco.DateTime':
      // Umbraco's legacy date picker has no time zone, so no `Z`.
      return typeof converted === 'string' ? converted.replace(' ', 'T') : plain(converted)
    case 'Umbraco.ColorPicker': {
      if (typeof converted === 'object' && converted !== null) {
        const color = converted as { value?: unknown; label?: unknown }
        return { value: color.value ?? null, label: color.label ?? color.value ?? null }
      }
      return { value: converted, label: converted }
    }
    default:
      return plain(converted)
  }
}

/** A page as an item or query endpoint answers it: a reference, plus its routes per culture. */
export function apiContentResponse(
  content: PublishedContent,
  ctx: OutputContext,
  routeIn: (culture: string) => ApiRoute | undefined,
  expand: ExpansionNode | undefined,
  include: ExpansionNode | undefined,
): Record<string, unknown> | null {
  const built = apiContent(content, ctx, expand, include, true)
  if (!built) return null
  const cultures: Record<string, ApiRoute> = {}
  for (const culture of content.cultures) {
    const route = routeIn(culture)
    if (route) cultures[culture] = route
  }
  return { ...built, cultures }
}
