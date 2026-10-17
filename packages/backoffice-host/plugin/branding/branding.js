/**
 * The two places the vendored client names the product in code rather than in a
 * string table.
 *
 * `view.controller.js` builds the page title with a hardcoded suffix, which
 * `vendor:backoffice` rebrands to Crombolo. The suffix should be the site's own
 * name, which the shell states in `<meta name="application-name">` — so a site
 * called something other than Crombolo gets its own name rather than ours.
 *
 * Not read from `document.title`, although the shell puts the name there too.
 * This module loads after the client has started, and by then the client may
 * have written a title of its own. Taking `Content | Crombolo` for the site's
 * name makes every correction end in ` | Crombolo` again: the observer below
 * then answers its own change, forever, and the page never gets its main thread
 * back.
 */
const CLIENT_SUFFIX = ' | Crombolo'

/** The site's name as the shell stated it. */
export function brandName(doc = document) {
  const stated = doc.querySelector('meta[name="application-name"]')?.getAttribute('content')
  return stated?.trim() || 'Crombolo'
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
 * `backoffice-header-logo.element.js`. Its image is already served as crombolo's
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
  anchor.href = 'https://github.com/kineco-au/crombolo-cms'
  anchor.textContent = 'Crombolo on GitHub'
  const image = logo.shadowRoot.querySelector('img#logo')
  if (image) image.alt = brandName()
  return true
}

/** Where Umbraco's theme context keeps the choice, as the shells' early script reads it. */
const THEME_KEY = 'umb-theme-alias'

/** Whether a theme choice paints the back office dark: Dark, or Match my system on a dark computer. */
export function isDarkTheme(alias, prefersDark) {
  return (
    alias === 'Crombolo.Theme.Dark' ||
    alias === 'umb-dark-theme' ||
    (alias === 'Crombolo.Theme.System' && Boolean(prefersDark))
  )
}

const GRAPHIC =
  /(\/security\/back-office\/graphics\/)(logo|logo-alternative|login-logo|login-logo-alternative)(-dark)?$/

/**
 * A logo's address for the theme: the cream-lettered `-dark` variant on a dark
 * theme, the plain one otherwise. Anything that is not one of the logos comes
 * back as it was.
 */
export function themedLogoUrl(src, dark) {
  const match = GRAPHIC.exec(src ?? '')
  if (!match) return src
  return `${src.slice(0, match.index)}${match[1]}${match[2]}${dark ? '-dark' : ''}`
}

const prefersDark = () => {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

const storedTheme = () => {
  try {
    return localStorage.getItem(THEME_KEY)
  } catch {
    return null
  }
}

/**
 * The header's logo, and the wordmark in its popover, in the theme's colours.
 *
 * `umb-app-logo` picks its graphic from Umbraco's own theme names, and the
 * header pins it to the one drawn for an orange bar, so its cocoa lettering
 * vanished on the dark header. Like the link above, this reaches into the
 * vendored element and does nothing if it is not what it was.
 */
function applyThemedLogos() {
  const dark = isDarkTheme(storedTheme(), prefersDark())
  const header = deepQuery('umb-backoffice-header-logo')?.shadowRoot
  const mark = header?.querySelector('umb-app-logo')?.shadowRoot?.querySelector('img')
  if (!mark) return false
  const src = mark.getAttribute('src')
  const next = themedLogoUrl(src, dark)
  if (next !== src) mark.setAttribute('src', next)
  const popover = header.querySelector('img#logo')
  if (popover) {
    popover.dataset.lightSrc ??= popover.getAttribute('src') ?? ''
    const wanted = dark
      ? next.replace(/graphics\/logo-dark$/, 'graphics/logo-alternative-dark')
      : popover.dataset.lightSrc
    if (popover.getAttribute('src') !== wanted) popover.setAttribute('src', wanted)
  }
  return true
}

/** Applies the logos now and on every change of theme: the menu, another tab, or the computer's. */
function followTheme() {
  const apply = () => setTimeout(applyThemedLogos, 0)
  // The theme context swaps the theme's stylesheet in the head when the choice changes.
  new MutationObserver(apply).observe(document.head, { childList: true })
  window.addEventListener('storage', (event) => {
    if (event.key === THEME_KEY) apply()
  })
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply)
  } catch {
    // Without media queries, Match my system stays light.
  }
}

export const onInit = () => {
  const brand = brandName()
  let themed = false
  const logos = setInterval(() => {
    if (applyThemedLogos() && !themed) {
      themed = true
      clearInterval(logos)
      followTheme()
    }
  }, 250)
  setTimeout(() => clearInterval(logos), 30_000)
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
