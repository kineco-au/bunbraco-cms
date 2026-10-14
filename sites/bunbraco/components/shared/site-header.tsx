import type { Navigation, PublishedContent } from 'bunbraco'
import { Logo } from './logo.tsx'
import { developerPage, homeOf, repositoryUrl } from './site.tsx'

/**
 * The masthead. The home page's sections are linked by anchor through the home
 * page's own URL, so the links work from every page, not only the one they are on.
 */
export function SiteHeader({ model, nav }: { model: PublishedContent; nav: Navigation }) {
  const home = homeOf(nav)
  if (!home) return null
  const developers = developerPage(nav)
  return (
    <header class="masthead">
      <div class="container masthead__inner">
        <a class="brand" href={home.url}>
          <Logo />
          bunbraco
        </a>
        <nav aria-label="Primary">
          <a href={`${home.url}#why`}>Why Bunbraco</a>
          <a href={`${home.url}#editors`}>For editors</a>
          {developers ? (
            <a
              href={developers.url}
              aria-current={developers.key === model.key ? 'page' : undefined}
            >
              For developers
            </a>
          ) : null}
          <a href={repositoryUrl(nav)}>GitHub</a>
        </nav>
      </div>
    </header>
  )
}
