import { type PageProps, search } from '@crombolo/crombolo'
import { DocsLayout } from '../shared/docs.tsx'

const PER_PAGE = 10

/** The docs pages matching `?q=`, best first, ten at a time, each with the text around the match. */
export default async function SearchPage(props: PageProps) {
  const { model, request } = props
  const url = new URL(request.url)
  const query = url.searchParams.get('q')?.trim() ?? ''
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1)
  const results = query
    ? await search(query, {
        types: ['docsPage', 'docsSection'],
        skip: (page - 1) * PER_PAGE,
        take: PER_PAGE,
      })
    : { total: 0, items: [] }
  const pages = Math.ceil(results.total / PER_PAGE)
  const link = (n: number) => `${model.url}?q=${encodeURIComponent(query)}&page=${n}`

  return (
    <DocsLayout {...props}>
      <search>
        <form class="search-form" action={model.url} method="get">
          <input type="search" name="q" value={query} aria-label="Search the docs" />
          <button type="submit">Search</button>
        </form>
      </search>
      {query ? (
        <p class="search-summary" role="status">
          {results.total === 0
            ? `Nothing matches “${query}”.`
            : `${results.total} ${results.total === 1 ? 'page matches' : 'pages match'} “${query}”.`}
        </p>
      ) : null}
      <ol class="search-results">
        {results.items.map((item) => (
          <li>
            <a href={item.url}>{item.content.text('title') || item.name}</a>
            <p>
              {item.excerpt.map((segment) =>
                segment.match ? <mark>{segment.text}</mark> : segment.text,
              )}
            </p>
          </li>
        ))}
      </ol>
      {pages > 1 ? (
        <nav class="search-pages" aria-label="Search results pages">
          {page > 1 ? <a href={link(page - 1)}>Previous</a> : null}
          <span>
            Page {page} of {pages}
          </span>
          {page < pages ? <a href={link(page + 1)}>Next</a> : null}
        </nav>
      ) : null}
    </DocsLayout>
  )
}
