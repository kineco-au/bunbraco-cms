import { type Child, type PageProps, SeoHead } from 'bunbraco'
import { FAVICON } from './logo.tsx'
import { homeOf } from './site.tsx'
import { SiteFooter } from './site-footer.tsx'
import { SiteHeader } from './site-header.tsx'

/** The shell every page shares. System fonts only, so nothing loads from a third party. */
export function Layout(props: PageProps & { children?: Child }) {
  const { model, nav, children } = props
  const home = homeOf(nav)
  const heading = model.text('title') || model.name
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <SeoHead
          {...props}
          title={home && home.key !== model.key ? model.name : `Bunbraco — ${heading}`}
          titleSuffix={home && home.key !== model.key ? ' — Bunbraco' : null}
          description={model.text('strapline') || model.text('standfirst')}
        />
        <link rel="icon" type="image/svg+xml" href={FAVICON} />
        <link rel="stylesheet" href="/css/site.css" />
      </head>
      <body>
        <SiteHeader model={model} nav={nav} />
        <main>{children}</main>
        <SiteFooter nav={nav} />
      </body>
    </html>
  )
}
