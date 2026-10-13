/**
 * "Content Types" in the two places Umbraco hard-codes "Document Types".
 *
 * Every other mention of the term is a dictionary string, rewritten per language
 * by `scripts/build-localizations.ts`. The Settings menu item and the search
 * provider carry a literal English label instead, so they are re-registered
 * pointing at the dictionary key the global search already uses, and follow the
 * user's language like the rest.
 *
 * Re-registered under Umbraco's own aliases, for the reason `components-tree.js`
 * gives: workspace contexts name the menu item's alias to keep the tree expanded.
 */
const LABEL = '#treeHeaders_documentTypes'

export const RELABELLED = ['Umb.MenuItem.DocumentTypes', 'Umb.SearchProvider.DocumentType']

/** Re-register `alias` with `label`, leaving the rest of its manifest as Umbraco wrote it. */
export function relabel(extensionRegistry, alias, label) {
  const manifest = extensionRegistry.getByAlias(alias)
  if (!manifest) return
  extensionRegistry.unregister(alias)
  extensionRegistry.register({ ...manifest, meta: { ...manifest.meta, label } })
}

export const onInit = (_host, extensionRegistry) => {
  for (const alias of RELABELLED) relabel(extensionRegistry, alias, LABEL)
}
