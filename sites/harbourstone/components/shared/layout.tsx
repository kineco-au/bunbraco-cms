import type { Child, Navigation, PublishedContent } from 'bunbraco'
import { SiteFooter } from './site-footer.tsx'
import { SiteHeader } from './site-header.tsx'

/**
 * The shell every page shares. Nothing here is a template, because no document
 * type names it — which is the only thing that decides, so `shared/` is a
 * folder chosen for readers rather than a rule.
 *
 * The two faces come from Google Fonts rather than from files in this template:
 * nothing binary ships, and deleting the two <link> tags is the whole cost of
 * taking the third-party request out. `site.css` names a fallback for each, so
 * a blocked request degrades to the system serif and sans rather than to
 * nothing.
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
  const siteName = home?.text('title') || 'Harbourstone'
  const heading = model.text('title') || model.name
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{home && home.key !== model.key ? `${heading} — ${siteName}` : siteName}</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Outfit:wght@300;400;500&display=swap"
        />
        <link rel="stylesheet" href="/css/site.css" />
      </head>
      <body>
        <SiteHeader model={model} nav={nav} />
        <main>{children}</main>
        <SiteFooter />
      </body>
    </html>
  )
}
