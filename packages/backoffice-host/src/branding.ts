/**
 * The brand as data: the marks, and the palette behind them.
 *
 * The back office serves these as files, by path (`graphics.ts`). This exports
 * the same bytes to anything that has to *draw* the brand rather than serve it
 * — the enterprise console, which is a separate product surface in another
 * repository and reaches the CMS only through the `@crombolo/crombolo` umbrella.
 *
 * Imported as text rather than duplicated as string literals, so the `.svg`
 * and `.css` files stay the one source of truth and a new logo is one file to
 * change. Bun inlines a text import at bundle time, so this works in a browser
 * bundle as well as on the server — which matters, because the console that
 * consumes it is a client-side app and could not read a file at runtime.
 */
/// <reference path="./text-imports.d.ts" />
import faviconText from '../plugin/branding/favicon.svg' with { type: 'text' }
import logoText from '../plugin/branding/logo-header.svg' with { type: 'text' }
import themeText from '../plugin/branding/theme.css' with { type: 'text' }

/** The mark and wordmark, for a header or a sign-in card. */
export const logoSvg: string = logoText.trim()

/** The mark alone, square, for a tab icon. */
export const faviconSvg: string = faviconText.trim()

/**
 * The palette, read out of `theme.css` rather than restated here.
 *
 * The theme is what the back office is actually painted with, so parsing it is
 * what makes a consumer's colours the same colours rather than a copy that was
 * the same once. Only the `--crombolo-*` tokens are ours; everything else in
 * that file is an Umbraco variable being pointed at one of them.
 */
export interface BrandPalette {
  orange: string
  orangeLight: string
  orangeDeep: string
  orangeText: string
  cocoa: string
  cream: string
}

/** `--crombolo-orange-deep` → `orangeDeep`. */
const camel = (name: string) =>
  name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())

export function paletteFrom(css: string): BrandPalette {
  const found: Record<string, string> = {}
  for (const [, name, value] of css.matchAll(/--crombolo-([a-z-]+)\s*:\s*([^;]+);/g))
    found[camel(name as string)] = (value as string).trim()
  const wanted = ['orange', 'orangeLight', 'orangeDeep', 'orangeText', 'cocoa', 'cream']
  const missing = wanted.filter((key) => found[key] === undefined)
  // A theme that stopped declaring one of these would otherwise hand a
  // consumer `undefined` and paint something invisible.
  if (missing.length > 0) throw new Error(`theme.css declares no ${missing.join(', ')}.`)
  return Object.fromEntries(wanted.map((key) => [key, found[key]])) as unknown as BrandPalette
}

export const brandPalette: BrandPalette = paletteFrom(themeText)
