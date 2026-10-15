/** Relation types and their derived relations, shaped for the wire. */
import type { RelationPort, RelationTypeView } from '@crombolo/api-management'
import { ObjectTypes } from '@crombolo/core'
import { type Db, RELATION_TYPES, RelationRepository, relationTypeByKey } from '@crombolo/data'

/** Umbraco's friendly names for the object types a relation type joins. */
const OBJECT_TYPE_NAMES: Record<string, string> = {
  [ObjectTypes.Document]: 'Document',
  [ObjectTypes.Media]: 'Media',
  [ObjectTypes.Member]: 'Member',
  [ObjectTypes.Element]: 'Element',
  [ObjectTypes.ElementContainer]: 'Element Container',
}

const objectType = (id: string | null) => (id ? { id, name: OBJECT_TYPE_NAMES[id] ?? id } : null)

const VIEWS: readonly RelationTypeView[] = RELATION_TYPES.map((type) => ({
  id: type.key,
  alias: type.alias,
  name: type.name,
  parentObject: objectType(type.parentObjectType),
  childObject: objectType(type.childObjectType),
  isBidirectional: type.isBidirectional,
  isDependency: type.isDependency,
}))

export function createRelationPort(db: Db): RelationPort {
  const relations = new RelationRepository(db)
  return {
    types: () => VIEWS,
    async relations(typeKey, paging) {
      const type = relationTypeByKey(typeKey)
      if (!type) return undefined
      const result = await relations.relations(type, paging.skip, paging.take)
      return {
        total: result.total,
        items: result.items.map((relation) => ({
          id: relation.key,
          relationType: { id: relation.typeKey },
          parent: { id: relation.parent.key, name: relation.parent.name },
          child: { id: relation.child.key, name: relation.child.name },
          createDate: relation.createDate.toISOString(),
          comment: null,
        })),
      }
    },
  }
}
