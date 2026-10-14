import type { Navigation, PublishedContent } from 'bunbraco'

/**
 * The site name, from the config, and the primary nav: the home page followed by its children, so
 * adding a page in the backoffice adds it here.
 */
export function SiteHeader({
  model,
  nav,
  siteName,
}: {
  model: PublishedContent
  nav: Navigation
  siteName: string
}) {
  const home = nav.root()[0]
  if (!home) return null
  const ancestry = model.path.split(',')
  const links = [home, ...nav.children(home, { visibleOnly: true })]
  return (
    <header class="site-header">
      <div class="container site-header__inner">
        <a class="site-name" href={home.url}>
          {siteName}
        </a>
        <nav aria-label="Primary">
          {links.map((link) => {
            const here =
              link.key === home.key ? model.key === home.key : ancestry.includes(String(link.id))
            return (
              <a href={link.url} aria-current={here ? 'page' : undefined}>
                {link.key === home.key ? 'Home' : link.name}
              </a>
            )
          })}
        </nav>
      </div>
    </header>
  )
}
