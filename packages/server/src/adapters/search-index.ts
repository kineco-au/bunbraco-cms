/** The Examine dashboard's port over the search index. docs/search.md. */
import type { SearchIndexInfo, SearchIndexPort } from '@crombolo/api-management'
import { type Db, SEARCH_INDEXES, SearchIndex, type SearchIndexDefinition } from '@crombolo/data'

export function createSearchIndexPort(db: Db, onQueued?: () => void): SearchIndexPort {
  const search = new SearchIndex(db)
  const info = async (index: SearchIndexDefinition): Promise<SearchIndexInfo> => ({
    name: index.name,
    searcherName: index.searcherName,
    ...(await search.stats(index)),
  })
  return {
    indexes: () => Promise.all(SEARCH_INDEXES.map(info)),
    async index(name) {
      const index = SearchIndex.definition(name)
      return index ? info(index) : undefined
    },
    async rebuild(name) {
      const index = SearchIndex.definition(name)
      if (!index) return false
      await search.rebuild(index)
      onQueued?.()
      return true
    },
    searchers: () => SEARCH_INDEXES.map((index) => index.searcherName),
    async query(searcherName, term, paging) {
      const index = SearchIndex.bySearcher(searcherName)
      return index ? search.query(index, term, paging) : undefined
    },
  }
}
