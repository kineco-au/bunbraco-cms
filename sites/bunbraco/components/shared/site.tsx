import type { Navigation, PublishedContent, PublishedElement } from 'bunbraco'

/** Where the source lives when the home page does not say. */
const DEFAULT_REPOSITORY = 'https://github.com/kineco-au/bunbraco-cms'

/** The home page, which holds the settings every page shares. */
export function homeOf(nav: Navigation): PublishedContent | undefined {
  return nav.root()[0]
}

export function repositoryUrl(nav: Navigation): string {
  return homeOf(nav)?.text('repositoryUrl') || DEFAULT_REPOSITORY
}

/** The developer page, found by type so renaming or moving it changes nothing here. */
export function developerPage(nav: Navigation): PublishedContent | undefined {
  const home = homeOf(nav)
  return home
    ? nav.children(home).find((child) => child.contentType.alias === 'developerPage')
    : undefined
}

/**
 * An element picker always yields a list, as Umbraco's converter does, even
 * where the data type allows a single pick.
 */
export function elementsOf(model: PublishedContent, alias: string): PublishedElement[] {
  return (model.value(alias) ?? []) as PublishedElement[]
}
