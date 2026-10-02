/**
 * References, shaped for the wire. The client discriminates the list by
 * `$type`, so a referencing node becomes a document, a media item, or the
 * default shape when it is neither.
 */
import type { ReferencePort } from '@bunbraco/api-management'
import { ObjectTypes } from '@bunbraco/core'
import { type Db, ReferenceRepository, type ReferencingNode } from '@bunbraco/data'

function toReference(node: ReferencingNode): unknown {
  const type = {
    id: node.contentTypeKey ?? node.key,
    icon: node.contentTypeIcon,
    alias: node.contentTypeAlias,
    name: node.contentTypeAlias,
  }
  if (node.objectType === ObjectTypes.Document)
    return {
      $type: 'DocumentReferenceResponseModel',
      id: node.key,
      name: node.name,
      published: node.published,
      documentType: type,
      // Invariant until a reference needs to name the culture it came from.
      variants: [
        {
          id: node.key,
          name: node.name ?? '',
          culture: null,
          state: node.published ? 'Published' : 'Draft',
          flags: [],
        },
      ],
    }
  if (node.objectType === ObjectTypes.Media)
    return {
      $type: 'MediaReferenceResponseModel',
      id: node.key,
      name: node.name,
      mediaType: type,
    }
  return {
    $type: 'DefaultReferenceResponseModel',
    id: node.key,
    name: node.name,
    type: node.contentTypeAlias,
    icon: node.contentTypeIcon,
  }
}

export function createReferencePort(db: Db): ReferencePort {
  const references = new ReferenceRepository(db)
  return {
    async referencedBy(key, paging) {
      const result = await references.referencedBy(key, paging.skip, paging.take)
      return { total: result.total, items: result.items.map(toReference) }
    },
    async referencedDescendants(key, paging) {
      const result = await references.referencedDescendants(key, paging.skip, paging.take)
      return { total: result.total, items: result.items.map((id) => ({ id })) }
    },
    async areReferenced(keys, paging) {
      const result = await references.areReferenced(keys, paging.skip, paging.take)
      return { total: result.total, items: result.items.map((id) => ({ id })) }
    },
  }
}
