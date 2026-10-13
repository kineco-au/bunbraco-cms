/**
 * Document types this CMS ships. "Search & sharing" (`seoFields`) is a
 * composition a site opts into with `compositions = ["seoFields"]`: the fields
 * the head helper, the sitemap and the editor's preview read.
 *
 * A **system** type, like the Folder, Image and File media types: ensured at
 * every boot, exempt from schema retirement, not deletable, alias fixed. A site
 * may extend it with a file of the same alias and key; the shipped fields stay.
 */
import {
  type ContentTypeAggregate,
  SEO_FIELDS_PROPERTIES,
  SYSTEM_DOCUMENT_TYPE_KEYS,
  type SystemPropertyModel,
} from '@bunbraco/core'
import type { Db } from '../database.ts'
import { ContentTypeRepository } from '../repositories/content-types.ts'

export interface BuiltInDocumentType {
  key: string
  alias: string
  name: string
  description: string
  icon: string
  tab: { key: string; name: string; alias: string }
  properties: readonly SystemPropertyModel[]
}

export const SEO_FIELDS_TYPE: BuiltInDocumentType = {
  key: SYSTEM_DOCUMENT_TYPE_KEYS.SeoFields,
  alias: 'seoFields',
  name: 'Search & sharing',
  description: 'How a page appears in search results and when shared.',
  icon: 'icon-search',
  tab: { key: '3f8a1d6c-5e2b-4a07-9c84-b1e7d0f2a658', name: 'Search & sharing', alias: 'seo' },
  properties: SEO_FIELDS_PROPERTIES,
}

export const SYSTEM_DOCUMENT_TYPES: readonly BuiltInDocumentType[] = [SEO_FIELDS_TYPE]

export function systemDocumentTypeAggregate(def: BuiltInDocumentType): ContentTypeAggregate {
  return {
    key: def.key,
    alias: def.alias,
    name: def.name,
    description: def.description,
    icon: def.icon,
    allowedAsRoot: false,
    variesByCulture: false,
    variesBySegment: false,
    isElement: false,
    allowedInLibrary: false,
    collectionKey: null,
    cleanup: {
      preventCleanup: false,
      keepAllVersionsNewerThanDays: null,
      keepLatestVersionPerDayForDays: null,
    },
    containers: [
      {
        key: def.tab.key,
        name: def.tab.name,
        alias: def.tab.alias,
        type: 'Tab',
        sortOrder: 0,
        parentKey: null,
      },
    ],
    properties: def.properties.map((p, sortOrder) => ({
      key: p.key,
      alias: p.alias,
      name: p.name,
      description: p.description,
      dataTypeKey: p.dataTypeKey,
      containerKey: def.tab.key,
      sortOrder,
      variesByCulture: false,
      variesBySegment: false,
      mandatory: false,
      mandatoryMessage: null,
      regEx: null,
      regExMessage: null,
      labelOnTop: false,
    })),
    compositions: [],
    allowedContentTypes: [],
    allowedComponentKeys: [],
    defaultComponentKey: null,
    parentKey: null,
  }
}

/**
 * Creates any missing system document type by its fixed key; never changes one
 * that exists. Idempotent; runs at every boot.
 */
export async function ensureSystemDocumentTypes(db: Db): Promise<string[]> {
  const repo = new ContentTypeRepository(db, { kind: 'document' })
  const created: string[] = []
  for (const def of SYSTEM_DOCUMENT_TYPES) {
    if (await repo.byKey(def.key)) continue
    await repo.save(systemDocumentTypeAggregate(def))
    created.push(def.alias)
  }
  return created
}
