/**
 * The search menu on a log message, pointed at this project rather than at
 * Umbraco's.
 *
 * `log-viewer-message.element.js` builds six items in `_getSearchMenuData()`,
 * four of them Umbraco's: two that search the Umbraco forum — one under the
 * Umbraco mark — and two that search Umbraco-CMS on GitHub by the line's
 * `SourceContext`. The forum pair goes, because there is no bunbraco forum to
 * send anyone to and the item above it already puts the message into Google.
 * The GitHub pair stays, repointed: searching the source and the issues by the
 * type that logged a line is how you chase one down, it just has to be this
 * CMS's source and issues.
 *
 * The array is rebuilt on every render by a method on the element's prototype,
 * so the method is wrapped rather than the element replaced: the rest of the
 * log viewer is what we want, and wrapping keeps the two items we leave alone —
 * and anything upstream adds — exactly as they were.
 *
 * Items are matched on their **resolved** label rather than the key, because
 * the key is not readable off the built array: `localize.term` returns the
 * string. Resolving the same keys through the same controller matches in
 * whatever language the editor is in.
 *
 * Patched rather than registered, because the menu is not an extension point.
 */
const TAG = 'umb-log-viewer-message'
export const REPOSITORY = 'https://github.com/kineco-au/bunbraco-cms'

/** The forum pair, which has no equivalent here. */
export const DROPPED = ['logViewer_searchOurUmbraco', 'logViewer_searchOurUmbracoWithGoogle']

/** The GitHub pair, whose labels we keep and whose targets we replace. */
export const REPOINTED = {
  logViewer_searchUmbracoSource: (query) => `${REPOSITORY}/search?q=${query}`,
  logViewer_searchUmbracoIssues: (query) => `${REPOSITORY}/issues?q=${query}`,
}

/**
 * `items` with Umbraco's forum entries gone and its GitHub entries aimed here.
 *
 * `term` resolves a dictionary key the way the element does, so this matches
 * the labels in the editor's own language; `query` is the `SourceContext` the
 * two surviving searches look for.
 */
export function rebrandSearchMenu(items, term, query) {
  const dropped = new Set(DROPPED.map(term))
  const repointed = new Map(
    Object.entries(REPOINTED).map(([key, href]) => [term(key), () => href(query)]),
  )
  return items
    .filter((item) => !dropped.has(item.label))
    .map((item) => {
      const href = repointed.get(item.label)
      return href ? { ...item, href } : item
    })
}

export const onInit = async () => {
  // Registered with the Log Viewer section, so not defined until it is opened.
  const element = await customElements.whenDefined(TAG)
  const prototype = element.prototype
  const original = prototype._getSearchMenuData
  if (typeof original !== 'function') return

  prototype._getSearchMenuData = function patched() {
    const query =
      this.properties?.find((property) => property.name === 'SourceContext')?.value ?? ''
    return rebrandSearchMenu(original.call(this), (key) => this.localize.term(key), query)
  }
}
