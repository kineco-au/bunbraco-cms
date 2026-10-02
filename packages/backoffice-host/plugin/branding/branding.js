/**
 * The two places the vendored client names the product in code rather than in a
 * string table, where the localisation override cannot reach.
 *
 * `view.controller.js` builds the page title with a hardcoded string rather than
 * a localisation key, so the dictionary override cannot reach it. Patching the
 * vendored file would work until the next `vendor:backoffice`, which is the
 * reason nothing here patches vendored files.
 *
 * So it is corrected as it is written. The suffix is the site's own name, which
 * the shell states in `<meta name="application-name">` — so a site called
 * something other than Bunbraco gets its own name rather than a second hardcoded
 * one.
 *
 * Not read from `document.title`, although the shell puts the name there too.
 * This module loads after the client has started, and by then the client may
 * have written a title of its own. Taking `Content | Umbraco` for the site's
 * name makes every correction end in ` | Umbraco` again: the observer below
 * then answers its own change, forever, and the page never gets its main thread
 * back.
 */
const CLIENT_SUFFIX = ' | Umbraco'

/** The site's name as the shell stated it. */
export function brandName(doc = document) {
  const stated = doc.querySelector('meta[name="application-name"]')?.getAttribute('content')
  return stated?.trim() || 'Bunbraco'
}

/**
 * `title` with the client's suffix replaced by the site's name.
 *
 * A fixed point: its own output comes back unchanged, whatever the name is —
 * including a name that itself ends in the client's suffix. That is what makes
 * it safe to call from an observer of the very thing it writes.
 */
export function brandedTitle(title, brand) {
  const branded = ` | ${brand}`
  if (title.endsWith(branded) || !title.endsWith(CLIENT_SUFFIX)) return title
  return `${title.slice(0, -CLIENT_SUFFIX.length)}${branded}`
}

/**
 * The logo popover carries a link to umbraco.com, hardcoded in
 * `backoffice-header-logo.element.js`. Its image is already served as bunbraco's
 * (see `graphics.ts`), so only the link is left.
 *
 * This reaches into a vendored element's shadow root, which is worth naming as
 * the compromise it is: there is no extension point for the app shell's own
 * chrome. It is written to do nothing at all if that element or its anchor is not
 * what it was, so an upstream change costs a stale link and never an error.
 */
function deepQuery(selector, root = document) {
  const direct = root.querySelector(selector)
  if (direct) return direct
  // The header logo lives inside the header's shadow root, so a plain
  // `document.querySelector` cannot see it. Nothing here is reachable without
  // walking through the roots.
  for (const element of root.querySelectorAll('*')) {
    if (!element.shadowRoot) continue
    const found = deepQuery(selector, element.shadowRoot)
    if (found) return found
  }
  return null
}

function correctLogoLink() {
  const logo = deepQuery('umb-backoffice-header-logo')
  const anchor = logo?.shadowRoot?.querySelector('a[href*="umbraco.com"]')
  if (!anchor) return false
  anchor.href = 'https://github.com/kineco-au/bunbraco-cms'
  anchor.textContent = 'Bunbraco on GitHub'
  const image = logo.shadowRoot.querySelector('img[alt="Umbraco"]')
  if (image) image.alt = brandName()
  return true
}

export const onInit = () => {
  const brand = brandName()
  const correct = () => {
    const corrected = brandedTitle(document.title, brand)
    if (corrected !== document.title) document.title = corrected
  }
  correct()
  // The header renders after the app boots, and the popover's contents with it.
  let tries = 0
  const timer = setInterval(() => {
    if (correctLogoLink() || ++tries > 40) clearInterval(timer)
  }, 250)
  const head = document.querySelector('head')
  const title = document.querySelector('title')
  if (!head || !title) return
  // The element is replaced as well as retitled, so both are watched.
  new MutationObserver(correct).observe(title, {
    childList: true,
    characterData: true,
    subtree: true,
  })
  new MutationObserver(correct).observe(head, { childList: true })
}
