import type { Navigation, PublishedContent } from 'bunbraco'

/**
 * The masthead and the primary nav.
 *
 * The nav is the home page followed by its children, labelled with each node's
 * name rather than its title — the About page's title is a sentence, and a nav
 * wants a word. Adding a page in the backoffice adds it here; there is no list
 * of links to keep in step.
 *
 * There is no hamburger because there is no client-side JavaScript on this
 * site: below the breakpoint the links wrap under the wordmark instead, which
 * `site.css` does with flex-wrap alone.
 */
export function SiteHeader({ model, nav }: { model: PublishedContent; nav: Navigation }) {
  const home = nav.root()[0]
  if (!home) return null
  const ancestry = model.path.split(',')
  const links = [home, ...nav.children(home)]
  return (
    <header class="masthead">
      <div class="masthead__inner">
        <a class="wordmark" href={home.url}>
          <Wordmark />
        </a>
        <nav aria-label="Primary">
          {links.map((link) => {
            const here =
              link.key === home.key ? model.key === home.key : ancestry.includes(String(link.id))
            return (
              <a
                href={link.url}
                class={here ? 'here' : undefined}
                aria-current={here ? 'page' : undefined}
              >
                {link.key === home.key ? 'Home' : link.name}
              </a>
            )
          })}
        </nav>
      </div>
    </header>
  )
}

/**
 * Written out rather than read from the home page's title: a wordmark is a mark
 * with two colours in it, which makes it part of the design and not a value an
 * editor should have to reproduce. The page title stays the editable one.
 */
export function Wordmark() {
  return (
    <>
      Harbour<span>stone</span>
    </>
  )
}
