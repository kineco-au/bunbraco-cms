/**
 * JSON Schema for what a property or a whole content type holds.
 *
 * Umbraco derives these from the .NET type a property editor stores, so the
 * names it reports are .NET's. The shape is what a caller needs to validate or
 * generate a value, which for us follows the data type's storage column.
 */
import type { ValueStorageTypeName } from '@bunbraco/core'

/** The .NET name Umbraco reports for each storage type. */
export const VALUE_TYPE_NAMES: Record<ValueStorageTypeName, string> = {
  Ntext: 'System.String',
  Nvarchar: 'System.String',
  Integer: 'System.Int32',
  Decimal: 'System.Decimal',
  Date: 'System.DateTime',
}

export function schemaForStorage(storage: string): Record<string, unknown> {
  switch (storage) {
    case 'Integer':
      return { type: 'integer' }
    case 'Decimal':
      return { type: 'number' }
    case 'Date':
      return { type: 'string', format: 'date-time' }
    default:
      return { type: 'string' }
  }
}

export const valueTypeName = (storage: string): string =>
  VALUE_TYPE_NAMES[storage as ValueStorageTypeName] ?? 'System.String'

export interface SchemaProperty {
  alias: string
  name: string
  description: string | null
  mandatory: boolean
  storage: string
}

/** A content type as a JSON Schema object: one property per alias. */
export function contentTypeJsonSchema(
  type: { alias: string; name: string; description: string | null },
  properties: readonly SchemaProperty[],
): Record<string, unknown> {
  const shape: Record<string, unknown> = {}
  for (const property of properties) {
    const schema = schemaForStorage(property.storage) as Record<string, unknown>
    shape[property.alias] = property.description
      ? { ...schema, title: property.name, description: property.description }
      : { ...schema, title: property.name }
  }
  const required = properties.filter((p) => p.mandatory).map((p) => p.alias)
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: type.name,
    description: type.description ?? undefined,
    type: 'object',
    properties: shape,
    ...(required.length > 0 ? { required } : {}),
  }
}
