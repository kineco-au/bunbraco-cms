/**
 * The Help menu, pointed at this project rather than at Umbraco's.
 *
 * The vendored client ships two items — the Umbraco Learning Base and the
 * Umbraco community forum. Relabelling them would be worse than leaving them:
 * "Bunbraco Learning Base" linking to Umbraco's YouTube is a lie, and there is no
 * bunbraco forum to send anyone to. So they are replaced by alias with links that
 * go where they say.
 *
 * `overwrites` is the registry's own mechanism for this — the same way the
 * Welcome dashboard takes the place of Umbraco's news dashboard — so an upstream
 * bump cannot quietly restore them.
 */
export const onInit = (_host, extensionRegistry) => {
  extensionRegistry.registerMany([
    {
      type: 'menuItem',
      // The same kind the originals use: the registry renders it as a link.
      kind: 'link',
      alias: 'Bunbraco.MenuItem.Help.Documentation',
      name: 'Bunbraco Documentation',
      weight: 200,
      overwrites: ['Umb.MenuItem.Help.LearningBase'],
      meta: {
        menus: ['Umb.Menu.Help'],
        label: 'Bunbraco documentation',
        icon: 'icon-book-alt',
        href: 'https://github.com/kineco-au/bunbraco-cms#readme',
      },
    },
    {
      type: 'menuItem',
      kind: 'link',
      alias: 'Bunbraco.MenuItem.Help.Issues',
      name: 'Bunbraco Issues',
      weight: 190,
      overwrites: ['Umb.MenuItem.Help.CommunityForum'],
      meta: {
        menus: ['Umb.Menu.Help'],
        label: 'Report an issue',
        icon: 'icon-bug',
        href: 'https://github.com/kineco-au/bunbraco-cms/issues',
      },
    },
  ])
}
