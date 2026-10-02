/**
 * Node object types.
 *
 * `node` is a universal polymorphic tree — documents, media, members, all content
 * types, data types, templates and folders are rows in it — and this GUID is the
 * discriminator. The values are Umbraco's, so SQL and documentation transfer
 * even though the table names do not.
 *
 * Written lowercase deliberately: Postgres' `uuid` type normalises to lowercase
 * on read while SQLite stores text verbatim, so everything that compares a uuid
 * must agree on one case. `normaliseUuid` enforces it on the way in.
 */
export const ObjectTypes = {
  SystemRoot: 'ea7d8624-4cfe-4578-a871-24aa946bf34d',
  Document: 'c66ba18e-eaf3-4cff-8a22-41b16d66a972',
  DocumentType: 'a2cb7800-f571-4787-9638-bc48539a0efb',
  DocumentTypeContainer: '2f7a2769-6b0b-4468-90dd-af42d64f7f16',
  DocumentBlueprint: '6ebef410-03aa-48cf-a792-e1c1cb087aca',
  DocumentBlueprintContainer: 'a7eff71b-fa69-4552-93fc-038f7deee453',
  ContentRecycleBin: '01bb7ff2-24dc-4c0c-95a2-c24ef72bbac8',
  DataType: '30a2a501-1978-4ddb-a57b-f7efed43ba3c',
  DataTypeContainer: '521231e3-8b37-469c-9f9d-51afc91feb7b',
  Template: '6fbde604-4178-42ce-a10b-8a2600a2f07d',
  Media: 'b796f64c-1f99-4ffb-b886-4bf4bc011a9c',
  MediaType: '4ea4382b-2f5a-4c2b-9587-ae9b3cf3602e',
  MediaTypeContainer: '42aef799-b288-4744-9b10-be144b73cdc4',
  MediaRecycleBin: 'cf3d8e34-1c1c-41e9-ae56-878b57b32113',
  ElementContainer: '2815b0cf-9706-499f-aa2a-8a4c7aef005d',
  ElementRecycleBin: 'a1ee71eb-659c-4eee-bc97-6243e721cc0d',
  Member: '39eb0f98-b348-42a1-8662-e7eb18487560',
  MemberType: '9b5416fb-e72f-45a9-a07b-5a9a2709ce43',
  MemberTypeContainer: '59ef5767-7223-4abc-b229-72821dc711b9',
  MemberGroup: '366e63b9-880f-4e13-a61c-98069b029728',
  Element: '3d7b623c-94b1-487d-8554-a46ec37568be',
  Language: '6b05d05b-ec78-49be-a4e4-79e274f07a77',
  RelationType: 'b1988fad-8675-4f47-915a-b3a602bc5d8d',
  LockObject: '87a9f1ff-b1e4-4a25-babb-465a4a47ec41',
} as const

export type ObjectType = (typeof ObjectTypes)[keyof typeof ObjectTypes]

/** The canonical form for a uuid anywhere in the system. */
export function normaliseUuid(value: string): string {
  return value.toLowerCase()
}

export function uuidEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * `umb://document/2ef0…` or a bare uuid, as a dashed lowercase key.
 *
 * The two spellings a stored value uses for a reference. It lives here rather
 * than beside the value converters that first needed it because exporting a
 * bundle reads the same references out of the same values, and `@bunbraco/transfer`
 * must not depend on the renderer to do it.
 */
export function keyFromReference(reference: unknown): string | undefined {
  if (typeof reference !== 'string') return undefined
  const hex = reference
    .replace(/^umb:\/\/[a-z-]+\//i, '')
    .replaceAll('-', '')
    .toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) return undefined
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Fixed node ids, as Umbraco seeds them. */
export const SystemNodes = {
  Root: -1,
  ContentRecycleBin: -20,
  MediaRecycleBin: -21,
  ElementRecycleBin: -22,
} as const

/** `ContentVariation` is a flags byte on both content types and property types. */
export const ContentVariation = {
  Nothing: 0,
  Culture: 1,
  Segment: 2,
  CultureAndSegment: 3,
} as const

export function variationFlags(variesByCulture: boolean, variesBySegment: boolean): number {
  return (variesByCulture ? 1 : 0) | (variesBySegment ? 2 : 0)
}

export const variesByCulture = (flags: number): boolean => (flags & 1) !== 0
export const variesBySegment = (flags: number): boolean => (flags & 2) !== 0

/**
 * Effective variance is the intersection of the content type's and the property
 * type's: a property varies by culture only if its type does too.
 */
export function effectiveVariation(contentTypeFlags: number, propertyTypeFlags: number): number {
  return contentTypeFlags & propertyTypeFlags
}

/** `PropertyGroupType`: a tab is rendered as a top-level tab, a group as a fieldset. */
export const PropertyGroupType = { Group: 0, Tab: 1 } as const

/** How values are stored in `property_data`, chosen by the data type. */
export const ValueStorageType = {
  Ntext: 'Ntext',
  Nvarchar: 'Nvarchar',
  Integer: 'Integer',
  Date: 'Date',
  Decimal: 'Decimal',
} as const

export type ValueStorageTypeName = (typeof ValueStorageType)[keyof typeof ValueStorageType]

/** The `property_data` column a storage type writes to. */
export const STORAGE_COLUMN: Record<ValueStorageTypeName, string> = {
  Ntext: 'text_value',
  Nvarchar: 'varchar_value',
  Integer: 'int_value',
  Date: 'date_value',
  Decimal: 'decimal_value',
}
