/**
 * Light and dark in the back office (story 049): crombolo's dark palette clears
 * contrast, the themes replace Umbraco's stock dark, and the shells apply the
 * stored choice before the first paint, the login page included.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createBackOfficePaths,
  EARLY_THEME_ID,
  earlyThemeScript,
  renderBackOfficeShell,
  renderLoginShell,
  resolveStaticFile,
  THEME_DARK,
  THEME_STORAGE_KEY,
  THEME_SYSTEM,
  themeStylesheets,
} from '@crombolo/backoffice-host'
import { ROOT } from '../scripts/packages.ts'

const PLUGIN = join(ROOT, 'packages/backoffice-host/plugin')
const paths = createBackOfficePaths()

function tokens(file: string): Record<string, string> {
  const text = readFileSync(join(PLUGIN, 'branding', file), 'utf8')
  const out: Record<string, string> = {}
  for (const [, name, value] of text.matchAll(/(--[\w-]+):\s*([^;]+);/g))
    out[name as string] = (value as string).trim()
  const resolve = (value: string): string => {
    const reference = /^var\((--[\w-]+)\)$/.exec(value)
    return reference ? resolve(out[reference[1] as string] ?? value) : value
  }
  return Object.fromEntries(Object.entries(out).map(([name, value]) => [name, resolve(value)]))
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number)
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

describe('the dark palette', () => {
  const dark = tokens('theme-dark.css')

  test('builds on the vendored dark, wherever the back office is mounted', () => {
    const text = readFileSync(join(PLUGIN, 'branding', 'theme-dark.css'), 'utf8')
    expect(text).toContain('@import url("/umbraco/backoffice/css/dark.css");')
    // That path is served whatever the back office's own path is.
    const moved = createBackOfficePaths({ backOfficePath: '/admin' })
    expect(resolveStaticFile(moved, '/umbraco/backoffice/css/dark.css')?.file).toEndWith(
      'css/dark.css',
    )
  })

  test.each([
    ['--uui-color-text', '--uui-color-background', 4.5],
    ['--uui-color-text', '--uui-color-surface', 4.5],
    ['--uui-color-text', '--uui-color-surface-alt', 4.5],
    ['--uui-color-text-alt', '--uui-color-surface', 4.5],
    ['--uui-color-interactive-emphasis', '--uui-color-surface', 4.5],
    ['--uui-color-default-contrast', '--uui-color-default', 4.5],
    ['--uui-color-selected-contrast', '--uui-color-selected', 4.5],
    ['--uui-color-current-contrast', '--uui-color-current', 4.5],
    ['--uui-color-header-contrast-emphasis', '--uui-color-header-surface', 4.5],
    ['--crombolo-snippet-title', '--uui-color-surface', 4.5],
    ['--uui-color-focus', '--uui-color-background', 3],
    ['--uui-color-focus', '--uui-color-surface', 3],
    ['--crombolo-header-current', '--uui-color-header-surface', 3],
    ['--uui-color-border-standalone', '--uui-color-surface', 3],
  ])('%s on %s clears %p:1', (foreground, background, minimum) => {
    const fg = dark[foreground] as string
    const bg = dark[background] as string
    expect([foreground, fg, bg].join(' ')).toMatch(/#[0-9a-f]{6} #[0-9a-f]{6}$/)
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(minimum)
  })

  test('"Match my system" is the dark palette while the computer asks for dark', () => {
    expect(readFileSync(join(PLUGIN, 'branding', 'theme-system.css'), 'utf8')).toContain(
      '@import url("./theme-dark.css") (prefers-color-scheme: dark);',
    )
  })
})

describe('the themes and the switch', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN, 'umbraco-package.json'), 'utf8')) as {
    extensions: Array<Record<string, unknown>>
  }
  const byAlias = (alias: string) => manifest.extensions.find((e) => e.alias === alias)

  test("crombolo's dark replaces Umbraco's, beside Match my system", () => {
    expect(byAlias(THEME_DARK)).toMatchObject({
      type: 'theme',
      name: 'Dark',
      overwrites: 'umb-dark-theme',
    })
    expect(byAlias(THEME_SYSTEM)).toMatchObject({ type: 'theme', name: 'Match my system' })
  })

  test('the header offers the choice', () => {
    expect(byAlias('Crombolo.HeaderApp.Theme')).toMatchObject({
      type: 'headerApp',
      element: '/crombolo-plugin/theme-switch.js',
    })
    const element = readFileSync(join(PLUGIN, 'theme-switch.js'), 'utf8')
    for (const alias of ['umb-light-theme', THEME_DARK, THEME_SYSTEM])
      expect(element).toContain(alias)
    // Kept for the person, not only the browser.
    expect(element).toContain('/umbraco/management/api/v1/user-data')
  })
})

/** Runs the shell's inline script against a stub page, and says what it linked. */
function runEarly(stored: string | null, options: { throws?: boolean } = {}) {
  const storage = new Map<string, string>(stored === null ? [] : [[THEME_STORAGE_KEY, stored]])
  const appended: Array<Record<string, string>> = []
  const localStorage = {
    getItem: (key: string) => {
      if (options.throws) throw new Error('storage is off')
      return storage.get(key) ?? null
    },
    setItem: (key: string, value: string) => storage.set(key, value),
  }
  const document = {
    createElement: () => {
      const element: Record<string, string> & { setAttribute?: (k: string, v: string) => void } = {}
      element.setAttribute = (key, value) => {
        element[key] = value
      }
      return element
    },
    head: { appendChild: (element: Record<string, string>) => appended.push(element) },
  }
  new Function('localStorage', 'document', earlyThemeScript(paths))(localStorage, document)
  return { appended, stored: storage.get(THEME_STORAGE_KEY) ?? null }
}

describe('the choice before the first paint', () => {
  const sheets = themeStylesheets(paths)

  test('nothing chosen, or light, links nothing: the shell is light already', () => {
    expect(runEarly(null).appended).toEqual([])
    expect(runEarly('umb-light-theme').appended).toEqual([])
    expect(runEarly('something-else').appended).toEqual([])
  })

  test.each([
    [THEME_DARK, sheets[THEME_DARK]],
    [THEME_SYSTEM, sheets[THEME_SYSTEM]],
    ['umb-high-contrast-theme', sheets['umb-high-contrast-theme']],
  ])('%s links its stylesheet', (alias, href) => {
    const [link] = runEarly(alias).appended
    expect(link).toMatchObject({ id: EARLY_THEME_ID, rel: 'stylesheet', href, 'data-theme': alias })
  })

  test("a browser that chose Umbraco's dark gets crombolo's, and keeps it", () => {
    const result = runEarly('umb-dark-theme')
    expect(result.appended[0]?.href).toBe(sheets[THEME_DARK])
    expect(result.stored).toBe(THEME_DARK)
  })

  test('storage that cannot be read leaves the page light, with no error', () => {
    expect(runEarly(THEME_DARK, { throws: true }).appended).toEqual([])
  })

  test('the back office and the login page both carry it, after the light palette', () => {
    const importmap = { imports: {} }
    const shells = [
      renderBackOfficeShell(paths, importmap),
      renderLoginShell(paths, importmap, {
        defaultUiLanguage: 'en-US',
        keepUserLoggedIn: false,
        title: 'Crombolo',
        usernameIsEmail: true,
        allowUserInvite: false,
        allowPasswordReset: false,
        disableLocalLogin: false,
      }),
    ]
    for (const shell of shells) {
      expect(shell).toContain(EARLY_THEME_ID)
      expect(shell.indexOf(EARLY_THEME_ID)).toBeGreaterThan(shell.indexOf('branding/theme.css'))
    }
  })
})
