/**
 * Umbraco's seven built-in media types, verbatim from its installer
 * (`DatabaseDataCreator`): keys, aliases, names, icons, the one group each
 * carries, and every property with its key.
 *
 * Folder, Image and File are **system** media types (Umbraco's
 * `IsSystemMediaType`): shipped with the framework, ensured at every boot, not
 * deletable, alias fixed. Video, Audio, Article and Vector Graphics are
 * ordinary types a site owns as files in `schema/media-types/`; `bunbraco
 * init` scaffolds them and deleting one deletes its file.
 */
import { type ContentTypeAggregate, normaliseUuid, SYSTEM_MEDIA_TYPE_KEYS } from '@bunbraco/core'
import type { Db } from '../database.ts'
import { ContentTypeRepository } from '../repositories/content-types.ts'
import { DEFAULT_DATA_TYPES } from './content-seed.ts'

export interface BuiltInMediaProperty {
  key: string
  alias: string
  name: string
  /** A built-in data type alias. */
  dataType: string
  mandatory: boolean
}

export interface BuiltInMediaType {
  key: string
  alias: string
  name: string
  icon: string
  /** Folder, Image and File: undeletable, alias fixed. */
  system: boolean
  /** A built-in data type alias for the collection view. */
  collection?: string
  /** Aliases; Folder allows every built-in, the ones a site has. */
  allowChildren: string[]
  group?: { key: string; name: string; alias: string }
  properties: BuiltInMediaProperty[]
}

const extension = (key: string): BuiltInMediaProperty => ({
  key,
  alias: 'umbracoExtension',
  name: 'File extension',
  dataType: 'label',
  mandatory: false,
})
const bytes = (key: string): BuiltInMediaProperty => ({
  key,
  alias: 'umbracoBytes',
  name: 'File size',
  dataType: 'labelBytes',
  mandatory: false,
})
const pixels = (key: string, alias: 'umbracoWidth' | 'umbracoHeight'): BuiltInMediaProperty => ({
  key,
  alias,
  name: alias === 'umbracoWidth' ? 'Width' : 'Height',
  dataType: 'labelPixels',
  mandatory: false,
})

export const BUILT_IN_MEDIA_TYPES: readonly BuiltInMediaType[] = [
  {
    key: SYSTEM_MEDIA_TYPE_KEYS.Folder,
    alias: 'Folder',
    name: 'Folder',
    icon: 'icon-folder',
    system: true,
    collection: 'listViewMedia',
    allowChildren: [
      'Folder',
      'Image',
      'File',
      'umbracoMediaVideo',
      'umbracoMediaAudio',
      'umbracoMediaArticle',
      'umbracoMediaVectorGraphics',
    ],
    properties: [],
  },
  {
    key: SYSTEM_MEDIA_TYPE_KEYS.Image,
    alias: 'Image',
    name: 'Image',
    icon: 'icon-picture',
    system: true,
    allowChildren: [],
    group: { key: '79ed4d07-254a-42cf-8fa9-ebe1c116a596', name: 'Image', alias: 'image' },
    properties: [
      {
        key: 'b646ca8f-e469-4fc2-a48a-d4dc1aa64a53',
        alias: 'umbracoFile',
        name: 'Image',
        dataType: 'imageCropper',
        mandatory: true,
      },
      pixels('a68d453b-1f62-44f4-9f71-0b6bbd43c355', 'umbracoWidth'),
      pixels('854087f6-648b-40ed-bc98-b8a9789e80b9', 'umbracoHeight'),
      bytes('bd4c5ace-26e3-4a8b-af1a-e8206a35fa07'),
      extension('f7786fe8-724a-4ed0-b244-72546db32a92'),
    ],
  },
  {
    key: SYSTEM_MEDIA_TYPE_KEYS.File,
    alias: 'File',
    name: 'File',
    icon: 'icon-document',
    system: true,
    allowChildren: [],
    group: { key: '50899f9c-023a-4466-b623-aba9049885fe', name: 'File', alias: 'file' },
    properties: [
      {
        key: 'a0fb68f3-f427-47a6-afce-536ffa5b64e9',
        alias: 'umbracoFile',
        name: 'File',
        dataType: 'upload',
        mandatory: true,
      },
      extension('3531c0a3-4e0a-4324-a621-b9d3822b071f'),
      bytes('f9527050-59bc-43e4-8fa8-1658d1319ff5'),
    ],
  },
  {
    key: 'f6c515bb-653c-4bdc-821c-987729ebe327',
    alias: 'umbracoMediaVideo',
    name: 'Video',
    icon: 'icon-video',
    system: false,
    allowChildren: [],
    group: { key: '2f0a61b6-cf92-4ff4-b437-751ab35eb254', name: 'Video', alias: 'video' },
    properties: [
      {
        key: 'bed8ab97-d85f-44d2-a8b9-aef6893f9610',
        alias: 'umbracoFile',
        name: 'Video',
        dataType: 'uploadVideo',
        mandatory: true,
      },
      extension('edd2b3fd-1e57-4e57-935e-096defccdc9b'),
      bytes('180eeecf-1f00-409e-8234-bba967e08b0a'),
    ],
  },
  {
    key: 'a5ddeee0-8fd8-4cee-a658-6f1fcdb00de3',
    alias: 'umbracoMediaAudio',
    name: 'Audio',
    icon: 'icon-audio-lines',
    system: false,
    allowChildren: [],
    group: { key: '335fb495-0a87-4e82-b902-30eb367b767c', name: 'Audio', alias: 'audio' },
    properties: [
      {
        key: '1f48d730-f174-4684-afad-a335e59d84a0',
        alias: 'umbracoFile',
        name: 'Audio',
        dataType: 'uploadAudio',
        mandatory: true,
      },
      extension('1bee433f-a21a-4031-8e03-af01bb8d2de9'),
      bytes('3cbf538a-29ab-4317-a9eb-bbcdf1a54260'),
    ],
  },
  {
    key: 'a43e3414-9599-4230-a7d3-943a21b20122',
    alias: 'umbracoMediaArticle',
    name: 'Article',
    icon: 'icon-article',
    system: false,
    allowChildren: [],
    group: { key: '9af3bd65-f687-4453-9518-5f180d1898ec', name: 'Article', alias: 'article' },
    properties: [
      {
        key: 'e5c8c2d0-2d82-4f01-b53a-45a1d1cbf19c',
        alias: 'umbracoFile',
        name: 'Article',
        dataType: 'uploadArticle',
        mandatory: true,
      },
      extension('ef1b4af7-36de-45eb-8c18-a2de07319227'),
      bytes('aab7d00c-7209-4337-be3f-a4421c8d79a0'),
    ],
  },
  {
    key: 'c4b1efcf-a9d5-41c4-9621-e9d273b52a9c',
    alias: 'umbracoMediaVectorGraphics',
    name: 'Vector Graphics (SVG)',
    icon: 'icon-origami',
    system: false,
    allowChildren: [],
    group: {
      key: 'f199b4d7-9e84-439f-8531-f87d9af37711',
      name: 'Vector Graphics',
      alias: 'vectorGraphics',
    },
    properties: [
      {
        key: 'e2a2bdf2-971b-483e-95a1-4104cc06af26',
        alias: 'umbracoFile',
        name: 'Vector Graphics',
        dataType: 'uploadVectorGraphics',
        mandatory: true,
      },
      extension('0f25a89e-2eb7-49bc-a7b4-759a7e4c69f2'),
      bytes('09a07aff-861d-4769-a2b0-c165ebd43d39'),
      pixels('5bc7e468-c53e-41a6-a522-2723f3b94514', 'umbracoWidth'),
      pixels('9e4c2b59-6bc6-4648-bb71-b0f45ddbc274', 'umbracoHeight'),
    ],
  },
]

export const SYSTEM_MEDIA_TYPES = BUILT_IN_MEDIA_TYPES.filter((t) => t.system)

const dataTypeKey = (alias: string): string => {
  const found = DEFAULT_DATA_TYPES.find((d) => d.alias === alias)
  if (!found) throw new Error(`built-in media types reference unknown data type "${alias}"`)
  return found.key
}

/** The aggregate for a built-in, allowing as children only the types given. */
export function builtInMediaTypeAggregate(
  def: BuiltInMediaType,
  allowedChildKeys: readonly string[],
): ContentTypeAggregate {
  return {
    key: def.key,
    alias: def.alias,
    name: def.name,
    description: null,
    icon: def.icon,
    allowedAsRoot: true,
    variesByCulture: false,
    variesBySegment: false,
    isElement: false,
    allowedInLibrary: false,
    collectionKey: def.collection ? dataTypeKey(def.collection) : null,
    cleanup: {
      preventCleanup: false,
      keepAllVersionsNewerThanDays: null,
      keepLatestVersionPerDayForDays: null,
    },
    containers: def.group
      ? [
          {
            key: def.group.key,
            name: def.group.name,
            alias: def.group.alias,
            type: 'Group',
            sortOrder: 0,
            parentKey: null,
          },
        ]
      : [],
    properties: def.properties.map((p, sortOrder) => ({
      key: p.key,
      alias: p.alias,
      name: p.name,
      description: null,
      dataTypeKey: dataTypeKey(p.dataType),
      containerKey: def.group?.key ?? null,
      sortOrder,
      variesByCulture: false,
      variesBySegment: false,
      mandatory: p.mandatory,
      mandatoryMessage: null,
      regEx: null,
      regExMessage: null,
      labelOnTop: false,
    })),
    compositions: [],
    allowedContentTypes: allowedChildKeys.map((contentTypeKey, sortOrder) => ({
      contentTypeKey,
      sortOrder,
    })),
    allowedTemplateKeys: [],
    defaultTemplateKey: null,
    parentKey: null,
  }
}

export interface EnsureMediaTypesOptions {
  /**
   * Link Folder to every built-in media type the site has. Skipped when the
   * site defines Folder in a file: then the file says what Folder allows.
   */
  linkFolderChildren?: boolean
}

/**
 * Creates any missing system media type (Folder, Image, File) by its fixed
 * key; never changes one that exists. Idempotent; runs at every boot, before
 * and after the schema sync.
 */
export async function ensureSystemMediaTypes(
  db: Db,
  options: EnsureMediaTypesOptions = {},
): Promise<string[]> {
  const repo = new ContentTypeRepository(db, { kind: 'media' })
  const created: string[] = []
  for (const def of SYSTEM_MEDIA_TYPES) {
    if (await repo.byKey(def.key)) continue
    const systemChildren = def.allowChildren
      .map((alias) => SYSTEM_MEDIA_TYPES.find((s) => s.alias === alias)?.key)
      .filter((key): key is string => key !== undefined)
    await repo.save(builtInMediaTypeAggregate(def, systemChildren))
    created.push(def.alias)
  }
  if (options.linkFolderChildren) {
    const folderDef = BUILT_IN_MEDIA_TYPES.find((t) => t.alias === 'Folder') as BuiltInMediaType
    const folder = await repo.byKey(folderDef.key)
    if (folder) {
      const allowed = new Set(
        folder.allowedContentTypes.map((a) => normaliseUuid(a.contentTypeKey)),
      )
      const missing: string[] = []
      for (const alias of folderDef.allowChildren) {
        const def = BUILT_IN_MEDIA_TYPES.find((t) => t.alias === alias)
        if (!def || allowed.has(def.key)) continue
        if (await repo.byKey(def.key)) missing.push(def.key)
      }
      if (missing.length > 0)
        await repo.save({
          ...folder,
          allowedContentTypes: [
            ...folder.allowedContentTypes,
            ...missing.map((contentTypeKey, i) => ({
              contentTypeKey,
              sortOrder: folder.allowedContentTypes.length + i,
            })),
          ],
        })
    }
  }
  return created
}
