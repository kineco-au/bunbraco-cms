/**
 * One tree over `components/`, in place of Umbraco's Templates and Partial Views.
 *
 * Umbraco splits the two because Razor needed the distinction for
 * master-template inheritance; a TSX layout is an import, so here a template is
 * just a component a document type names (`docs/05-rendering.md`). The tree that
 * survives is the partial-view one, because it is path-addressed and understands
 * folders — the template tree is id-addressed and cannot show one.
 *
 * **Relabelled in place rather than replaced through `overwrites`.** The sidebar
 * keeps the open item's ancestors expanded by tagging them with the menu item's
 * alias (`menu-tree-structure-workspace-context-base.js:161`), and the
 * workspace contexts that do the tagging name `Umb.MenuItem.PartialView`
 * literally. Registering a new alias and overwriting that one took the tag away,
 * so the tree collapsed every time a component was opened. Re-registering under
 * the same alias keeps every one of those references working and changes only
 * the label.
 */
const PARTIAL_VIEWS = 'Umb.MenuItem.PartialView'
const TEMPLATES = 'Umb.MenuItem.Templates'

export const onInit = (_host, extensionRegistry) => {
  // A template is a component now, and it is in the tree below.
  extensionRegistry.unregister(TEMPLATES)

  extensionRegistry.unregister(PARTIAL_VIEWS)
  extensionRegistry.register({
    type: 'menuItem',
    kind: 'tree',
    // Umbraco's own alias, deliberately: see above.
    alias: PARTIAL_VIEWS,
    name: 'Components Menu Item',
    weight: 40,
    meta: {
      label: 'Components',
      treeAlias: 'Umb.Tree.PartialView',
      menus: ['Umb.Menu.Templating'],
    },
  })
}
