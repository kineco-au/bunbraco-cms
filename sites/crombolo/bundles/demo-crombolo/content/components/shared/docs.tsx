import type { Child, Navigation, PageProps, PublishedContent } from '@crombolo/crombolo'
import { Layout } from './layout.tsx'

const DOCS_PAGE = 'docsPage'

/** The section a docs page sits in: the page itself when it is the section. */
export function docsSectionOf(model: PublishedContent, nav: Navigation) {
  if (model.contentType.alias === 'docsSection') return model
  return nav.ancestors(model).find((page) => page.contentType.alias === 'docsSection')
}

const pagesUnder = (page: PublishedContent, nav: Navigation) =>
  nav.children(page, { visibleOnly: true }).filter((child) => child.contentType.alias === DOCS_PAGE)

/** Every docs page in reading order: each page, then the pages under it. */
export function readingOrder(section: PublishedContent, nav: Navigation): PublishedContent[] {
  const walk = (page: PublishedContent): PublishedContent[] =>
    pagesUnder(page, nav).flatMap((child) => [child, ...walk(child)])
  return [section, ...walk(section)]
}

export interface Heading {
  id: string
  text: string
}

const decode = (text: string) =>
  text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')

/** The second-level headings of a page's body that carry an id, for "On this page". */
export function headingsOf(markup: string): Heading[] {
  return [...markup.matchAll(/<h2\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/g)].map((match) => ({
    id: decode(match[1] ?? ''),
    text: decode((match[2] ?? '').replaceAll(/<[^>]+>/g, '')).trim(),
  }))
}

function Tree({
  page,
  nav,
  model,
  open,
}: {
  page: PublishedContent
  nav: Navigation
  model: PublishedContent
  open: Set<string>
}) {
  const children = pagesUnder(page, nav)
  if (children.length === 0) return null
  return (
    <ul>
      {children.map((child) => (
        <li>
          <a href={child.url} aria-current={child.key === model.key ? 'page' : undefined}>
            {child.name}
          </a>
          {open.has(child.key) ? <Tree page={child} nav={nav} model={model} open={open} /> : null}
        </li>
      ))}
    </ul>
  )
}

/** The frame every docs page shares: the section's contents beside the page. */
export function DocsLayout(props: PageProps & { children?: Child; headings?: Heading[] }) {
  const { model, nav, children } = props
  const section = docsSectionOf(model, nav)
  if (!section) return <Layout {...props}>{children}</Layout>
  // The pages on the way down to this one are opened; the rest stay closed, so
  // the contents stay short on a phone.
  const open = new Set([model.key, ...nav.ancestors(model).map((page) => page.key)])
  const search = nav.children(section).find((child) => child.contentType.alias === 'searchPage')
  const order = readingOrder(section, nav)
  const at = order.findIndex((page) => page.key === model.key)
  const previous = at > 0 ? order[at - 1] : undefined
  const next = at >= 0 ? order[at + 1] : undefined
  const trail = nav
    .ancestors(model)
    .reverse()
    .filter((page) => page.contentType.alias === DOCS_PAGE || page.key === section.key)
  const headings = props.headings ?? []

  return (
    <Layout {...props}>
      <div class="container docs">
        <aside class="docs__aside">
          {search ? (
            <search>
              <form class="docs-search" action={search.url} method="get">
                <input type="search" name="q" aria-label="Search the docs" placeholder="Search" />
                <button type="submit">Search</button>
              </form>
            </search>
          ) : null}
          <nav class="docs-nav" aria-label="Docs">
            <a
              class="docs-nav__home"
              href={section.url}
              aria-current={section.key === model.key ? 'page' : undefined}
            >
              {section.name}
            </a>
            <Tree page={section} nav={nav} model={model} open={open} />
          </nav>
        </aside>
        <article class="docs__main">
          {trail.length > 0 ? (
            <nav class="breadcrumbs" aria-label="Breadcrumbs">
              <ol>
                {trail.map((page) => (
                  <li>
                    <a href={page.url}>{page.name}</a>
                  </li>
                ))}
              </ol>
            </nav>
          ) : null}
          <h1>{model.text('title') || model.name}</h1>
          {model.hasValue('standfirst') ? <p class="lead">{model.text('standfirst')}</p> : null}
          {headings.length > 1 ? (
            <nav class="on-this-page" aria-label="On this page">
              <h2>On this page</h2>
              <ul>
                {headings.map((heading) => (
                  <li>
                    <a href={`#${heading.id}`}>{heading.text}</a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
          {children}
          {previous || next ? (
            <nav class="pager" aria-label="Previous and next">
              {previous ? (
                <a class="pager__previous" href={previous.url} rel="prev">
                  <span>Previous</span> {previous.name}
                </a>
              ) : null}
              {next ? (
                <a class="pager__next" href={next.url} rel="next">
                  <span>Next</span> {next.name}
                </a>
              ) : null}
            </nav>
          ) : null}
        </article>
      </div>
    </Layout>
  )
}
