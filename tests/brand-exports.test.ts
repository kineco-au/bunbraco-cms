/**
 * The brand exported as data, for a consumer that draws it rather than serves
 * it (`bunbraco/branding`).
 *
 * The back office serves these marks as files, by path. The enterprise console
 * is a separate product surface in another repository and reaches this one only
 * through the `bunbraco` umbrella, so it needs the same bytes as values. What
 * these tests hold is that "the same bytes" stays true, and that importing them
 * cannot drag the server into a browser bundle.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { brandPalette, faviconSvg, logoSvg, paletteFrom } from '@bunbraco/backoffice-host/branding'

const PLUGIN = join(import.meta.dir, '..', 'packages', 'backoffice-host', 'plugin', 'branding')
const file = (name: string) => readFileSync(join(PLUGIN, name), 'utf8').trim()

describe('the marks', () => {
  test('are the same two files the back office serves', () => {
    // A text import cannot drift from the file it reads, so what this pins is
    // *which* file: `graphics.ts` serves logo-header.svg as `logo` and
    // favicon.svg as the tab icon. Exporting the backdrop or the surface mark
    // instead would compile and would show a customer one logo in the console
    // and a different one in their own back office.
    expect(logoSvg).toBe(file('logo-header.svg'))
    expect(faviconSvg).toBe(file('favicon.svg'))
  })

  test('are self-contained SVG, so a consumer can inline them', () => {
    for (const svg of [logoSvg, faviconSvg]) {
      expect(svg).toStartWith('<svg')
      expect(svg).toEndWith('</svg>')
      // No external reference: a consumer inlines this into its own page, where
      // a relative href would resolve against that page and fetch nothing.
      expect(svg).not.toMatch(/\b(?:href|src)\s*=/)
    }
  })

  test('carry the name, so the mark is legible to a screen reader or a tab', () => {
    expect(logoSvg).toContain('bunbraco')
    expect(faviconSvg).toContain('bunbraco')
  })

  test('the favicon is square and the logo is not, which is what each is for', () => {
    const box = (svg: string) =>
      (svg.match(/viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/) ?? []).slice(3).map(Number)
    const [faviconWidth, faviconHeight] = box(faviconSvg) as [number, number]
    const [logoWidth, logoHeight] = box(logoSvg) as [number, number]
    expect(faviconWidth).toBe(faviconHeight)
    expect(logoWidth).toBeGreaterThan(logoHeight * 2)
  })
})

describe('the palette', () => {
  test('is read out of the theme the back office is painted with', () => {
    // Parsed rather than restated, so a consumer's colours are the same
    // colours and not a copy that was the same once.
    const theme = file('theme.css')
    for (const [key, value] of Object.entries(brandPalette)) {
      const token = `--bunbraco-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
      expect([token, theme]).toEqual([token, expect.stringContaining(`${token}: ${value}`)])
    }
  })

  test('every colour is a hex value a stylesheet can use', () => {
    for (const [key, value] of Object.entries(brandPalette))
      expect([key, /^#[0-9a-f]{6}$/i.test(value)]).toEqual([key, true])
  })

  test('refuses a theme that stopped declaring one, rather than handing back undefined', () => {
    // Without this a consumer paints `color: undefined`, which renders as
    // nothing and looks like a styling bug three repositories away.
    expect(() => paletteFrom(':root { --bunbraco-orange: #e89550; }')).toThrow('declares no')
    expect(() => paletteFrom('')).toThrow('declares no')
  })

  test('reads a token whatever the spacing', () => {
    const css =
      ':root{--bunbraco-orange:#111111;--bunbraco-orange-light : #222222 ;\n' +
      '--bunbraco-orange-deep: #333333;--bunbraco-orange-text: #444444;' +
      '--bunbraco-cocoa: #555555;--bunbraco-cream: #666666;}'
    expect(paletteFrom(css)).toEqual({
      orange: '#111111',
      orangeLight: '#222222',
      orangeDeep: '#333333',
      orangeText: '#444444',
      cocoa: '#555555',
      cream: '#666666',
    })
  })
})

describe('what importing it costs', () => {
  const source = (...path: string[]) => readFileSync(join(import.meta.dir, '..', ...path), 'utf8')
  const hostBranding = source('packages', 'backoffice-host', 'src', 'branding.ts')
  const umbrellaBranding = source('packages', 'bunbraco', 'src', 'branding.ts')

  test('nothing in it touches the filesystem or the server', () => {
    // The one consumer is a client-side app. A `readFileSync` here would work
    // on the server and fail in the browser, which is the worst of both.
    for (const code of [hostBranding, umbrellaBranding]) {
      expect(code).not.toMatch(/from 'node:/)
      expect(code).not.toContain('@bunbraco/server')
      expect(code).not.toContain('@bunbraco/data')
      expect(code).not.toContain('readFileSync')
    }
  })

  test('the umbrella reaches branding by its subpath, never through its own index', () => {
    // Importing `@bunbraco/backoffice-host` plainly would pull its index, and
    // with it the shell, the manifests and everything they import.
    expect(umbrellaBranding).toContain("from '@bunbraco/backoffice-host/branding'")
    expect(umbrellaBranding).not.toMatch(/from '@bunbraco\/backoffice-host'/)
  })

  test('both packages declare the subpath, or an installed consumer cannot resolve it', () => {
    for (const name of ['backoffice-host', 'bunbraco']) {
      const manifest = JSON.parse(source('packages', name, 'package.json')) as {
        exports: Record<string, string>
      }
      expect([name, manifest.exports['./branding']]).toEqual([name, './src/branding.ts'])
    }
  })

  test('the files it reads are published, or the import resolves to nothing', () => {
    // `plugin` carries the SVGs and the theme; without it in `files` the
    // published package has the import and not the asset.
    const manifest = JSON.parse(source('packages', 'backoffice-host', 'package.json')) as {
      files: string[]
    }
    expect(manifest.files).toContain('plugin')
    expect(manifest.files).toContain('src')
  })
})
