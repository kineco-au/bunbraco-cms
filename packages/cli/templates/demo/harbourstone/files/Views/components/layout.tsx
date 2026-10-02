import type { Child, Navigation, PublishedContent } from 'bunbraco'

/** A date property as prose. Date pickers hand back a string or a Date. */
export function longDate(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

/**
 * The shell every page shares. `Views/` is scanned one level deep for template
 * aliases, so a component in here is not mistaken for a template.
 */
export function Layout({
  model,
  nav,
  children,
}: {
  model: PublishedContent
  nav: Navigation
  children?: Child
}) {
  const home = nav.root()[0]
  const sections = home ? nav.children(home) : []
  const heading = model.text('title') || model.name
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>
          {home && home.key !== model.key ? `${heading} — ${home.text('title')}` : heading}
        </title>
        <link rel="stylesheet" href="/css/site.css" />
      </head>
      <body>
        <header class="masthead">
          <a class="wordmark" href={home?.url ?? '/'}>
            {home?.text('title') ?? 'Home'}
          </a>
          <nav>
            {sections.map((section) => (
              <a
                href={section.url}
                class={model.path.split(',').includes(String(section.id)) ? 'here' : undefined}
              >
                {section.text('title') || section.name}
              </a>
            ))}
          </nav>
        </header>
        {children}
        <footer>
          <p>{home?.text('strapline')}</p>
          <p class="fine-print">
            A demonstration site. {home?.text('title') ?? 'This distillery'} is not a real
            distillery, and nothing here is for sale.
          </p>
        </footer>
      </body>
    </html>
  )
}
