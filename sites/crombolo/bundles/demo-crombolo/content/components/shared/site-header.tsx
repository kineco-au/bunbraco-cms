import type { Navigation, PublishedContent } from '@crombolo/crombolo'
import { Logo } from './logo.tsx'
import { developerPage, docsSection, homeOf, repositoryUrl } from './site.tsx'

/**
 * The masthead. The home page's sections are linked by anchor through the home
 * page's own URL, so the links work from every page, not only the one they are on.
 */
export function SiteHeader({ model, nav }: { model: PublishedContent; nav: Navigation }) {
  const home = homeOf(nav)
  if (!home) return null
  const developers = developerPage(nav)
  const docs = docsSection(nav)
  const inDocs =
    docs !== undefined &&
    (docs.key === model.key || nav.ancestors(model).some((page) => page.key === docs.key))
  return (
    <header class="masthead">
      <div class="container masthead__inner">
        <a class="brand" href={home.url}>
          <Logo />
          crombolo
        </a>
        <nav aria-label="Primary">
          <a href={`${home.url}#why`}>Why Crombolo</a>
          <a href={`${home.url}#editors`}>For editors</a>
          {developers ? (
            <a
              href={developers.url}
              aria-current={developers.key === model.key ? 'page' : undefined}
            >
              For developers
            </a>
          ) : null}
          {docs ? (
            <a href={docs.url} aria-current={inDocs ? 'page' : undefined}>
              Docs
            </a>
          ) : null}
          <a href={repositoryUrl(nav)}>GitHub</a>
        </nav>
      </div>
    </header>
  )
}
