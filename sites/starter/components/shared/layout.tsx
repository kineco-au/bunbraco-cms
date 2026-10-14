import { type Child, type PageProps, SeoHead } from 'bunbraco'
import { SiteFooter } from './site-footer.tsx'
import { SiteHeader } from './site-header.tsx'

/** The shell every page shares: head tags, the header, the page, the footer. */
export function Layout(props: PageProps & { children?: Child }) {
  const { model, nav, seo, children } = props
  const siteName = seo.siteName || nav.root()[0]?.name || ''
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <SeoHead {...props} title={model.text('title') || model.name} />
        <link rel="stylesheet" href="/css/site.css" />
      </head>
      <body>
        <SiteHeader model={model} nav={nav} siteName={siteName} />
        <main class="container">{children}</main>
        <SiteFooter siteName={siteName} />
      </body>
    </html>
  )
}
