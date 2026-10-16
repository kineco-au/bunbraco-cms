import { type PageProps, search } from '@crombolo/crombolo'
import { Layout } from '../shared/layout.tsx'
import { Eyebrow } from '../shared/section-intro.tsx'

const PER_PAGE = 10

/**
 * The pages matching `?q=`, best first, ten at a time. Each result reads its
 * eyebrow and title by the aliases every page type here shares, so a whisky
 * shows as "Single malt — The Harbour 12" rather than by its node name.
 */
export default async function SearchPage({ model, nav, request }: PageProps) {
  const url = new URL(request.url)
  const query = url.searchParams.get('q')?.trim() ?? ''
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1)
  const results = query
    ? await search(query, { skip: (page - 1) * PER_PAGE, take: PER_PAGE })
    : { total: 0, items: [] }
  const pages = Math.ceil(results.total / PER_PAGE)
  const link = (n: number) => `${model.url}?q=${encodeURIComponent(query)}&page=${n}`

  return (
    <Layout model={model} nav={nav}>
      <header class="page-header">
        <Eyebrow>{model.text('eyebrow')}</Eyebrow>
        <h1>{model.text('title')}</h1>
        <search>
          <form class="search-form" action={model.url} method="get">
            <input type="search" name="q" value={query} aria-label="Search the site" />
            <button class="button" type="submit">
              Search
            </button>
          </form>
        </search>
        {query ? (
          <p class="standfirst">
            {results.total === 0
              ? `Nothing matches “${query}”.`
              : `${results.total} ${results.total === 1 ? 'page matches' : 'pages match'} “${query}”.`}
          </p>
        ) : model.hasValue('standfirst') ? (
          <p class="standfirst">{model.text('standfirst')}</p>
        ) : null}
      </header>

      {results.items.length > 0 ? (
        <section>
          <ol class="search-results">
            {results.items.map((item) => (
              <li>
                <Eyebrow>{item.content.text('eyebrow')}</Eyebrow>
                <h2>
                  <a href={item.url}>{item.content.text('title') || item.name}</a>
                </h2>
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
              {page > 1 ? <a href={link(page - 1)}>Previous</a> : <span />}
              <span>
                Page {page} of {pages}
              </span>
              {page < pages ? <a href={link(page + 1)}>Next</a> : <span />}
            </nav>
          ) : null}
        </section>
      ) : null}
    </Layout>
  )
}
