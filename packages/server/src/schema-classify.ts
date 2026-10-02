/**
 * What a content-type change does to the content already stored.
 *
 * `runCheck` answers this for files against a database, which is the right shape
 * for an import and the wrong one for a save: by the time a save has happened the
 * database already holds the change, so there is nothing left to compare. This
 * asks the same questions of the two aggregates a save has in hand — what the
 * type was, and what it is about to become — so an editor's change can be
 * classified before it is applied, and the schema version moved accordingly.
 *
 * The rules are the ones `packages/schema/src/check.ts` applies, kept in step
 * with it deliberately rather than by accident:
 *
 * - a property's editor changed **and content exists** → breaking, because
 *   getting there converts data
 * - a property became mandatory **and content exists** → data-requiring
 * - anything else that differs → additive
 *
 * Removing a property is none of these: the schema system retires properties
 * rather than deleting them, and their values come back if the property does.
 */
import type { ContentTypeAggregate, PropertyTypeModel } from '@bunbraco/core'
import { type Db, DocumentRepository } from '@bunbraco/data'
import { type ChangeClass, typeNodeIdsCarrying } from '@bunbraco/schema'

/** Whether anything is stored against this type, compositions included. */
async function hasContent(db: Db, typeKey: string): Promise<boolean> {
  const carriers = await typeNodeIdsCarrying(db, typeKey)
  if (carriers.length === 0) return false
  const documents = await new DocumentRepository(db).documentsOfTypes(carriers)
  return documents.length > 0
}

const byKeyOrAlias = (
  properties: readonly PropertyTypeModel[],
  property: PropertyTypeModel,
): PropertyTypeModel | undefined =>
  properties.find((candidate) => candidate.key === property.key) ??
  properties.find((candidate) => candidate.alias === property.alias)

/**
 * How `after` differs from `before`, in terms of what it costs the content.
 * `before` absent means the type is new, which can only be additive.
 */
export async function classifyTypeChange(
  db: Db,
  before: ContentTypeAggregate | undefined,
  after: ContentTypeAggregate,
): Promise<ChangeClass> {
  if (!before) return 'additive'

  let live: boolean | undefined
  const contentExists = async () => {
    live ??= await hasContent(db, before.key)
    return live
  }

  let dataRequiring = false
  for (const property of after.properties) {
    const previous = byKeyOrAlias(before.properties, property)
    if (!previous) continue

    if (previous.dataTypeKey !== property.dataTypeKey && (await contentExists())) return 'breaking'
    if (property.mandatory && !previous.mandatory && (await contentExists())) dataRequiring = true
  }
  if (dataRequiring) return 'data-requiring'

  const same =
    before.alias === after.alias &&
    before.name === after.name &&
    before.properties.length === after.properties.length &&
    after.properties.every((property) => {
      const previous = byKeyOrAlias(before.properties, property)
      return (
        previous !== undefined &&
        previous.alias === property.alias &&
        previous.dataTypeKey === property.dataTypeKey &&
        previous.mandatory === property.mandatory
      )
    })
  return same ? 'none' : 'additive'
}
