/**
 * Everything that makes the vendored Umbraco client read as bunbraco: the page
 * title, the colour scheme, the logos, the System information modal and the
 * per-language product name.
 *
 * The title correction runs from a MutationObserver on the title it writes, so
 * anything it produces that it would correct again is an endless loop on the
 * page's main thread — which is what it once did, whenever the client wrote a
 * title before the module had loaded. The backoffice then never finished
 * booting, with nothing in the console to say why.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  createBackOfficePaths,
  DEFAULT_SHELL_SETTINGS,
  PLUGIN_PATH_PLACEHOLDER,
  renderBackOfficeShell,
  renderLoginShell,
  resolveStaticFile,
} from '@bunbraco/backoffice-host'
import { brandedTitle, brandName } from '../packages/backoffice-host/plugin/branding/branding.js'
import {
  needsCorrection,
  REQUIRED_PREFIX,
} from '../packages/backoffice-host/plugin/branding/client-credentials.js'
import english from '../packages/backoffice-host/plugin/branding/localization-en.js'
import {
  isSysinfoClipboardText,
  rebrandSysinfo,
} from '../packages/backoffice-host/plugin/branding/sysinfo.js'
import { brandDictionary, curatedKeys, rebrand } from '../scripts/build-localizations.ts'

const BRANDING_DIR = 'packages/backoffice-host/plugin/branding'
const LOCALIZATIONS_DIR = 'packages/backoffice-host/plugin/localizations'
const LANG_DIR = 'packages/backoffice-dist/dist/assets/lang'

const loginSettings = {
  ...DEFAULT_SHELL_SETTINGS,
  usernameIsEmail: true,
  allowUserInvite: false,
  allowPasswordReset: false,
  disableLocalLogin: false,
}

const doc = (html: string) =>
  ({
    querySelector: (selector: string) => {
      const match =
        selector === 'meta[name="application-name"]'
          ? /<meta name="application-name" content="([^"]*)"/.exec(html)
          : null
      return match ? { getAttribute: () => match[1] } : null
    },
  }) as unknown as Document

describe('the title the client writes', () => {
  test('gets the site’s name in place of the client’s', () => {
    expect(brandedTitle('Content | Umbraco', 'Bunbraco')).toBe('Content | Bunbraco')
    expect(brandedTitle('Settings | Templates | Umbraco', 'Acme')).toBe(
      'Settings | Templates | Acme',
    )
    // Not the client's suffix: left alone.
    expect(brandedTitle('Bunbraco', 'Bunbraco')).toBe('Bunbraco')
    expect(brandedTitle('Umbraco rocks', 'Acme')).toBe('Umbraco rocks')
  })

  test('is never corrected twice, whatever the site is called', () => {
    // Each of these names makes a naive correction produce something it would
    // correct again. The last is what the entry point once took for the site's
    // name, by reading a title the client had already written.
    const names = ['Bunbraco', 'Umbraco', 'Acme | Umbraco', 'Content | Umbraco', ' | Umbraco', '']
    const titles = ['Content | Umbraco', 'A | B | Umbraco', 'Umbraco', ' | Umbraco', '']
    for (const name of names) {
      for (const title of titles) {
        const once = brandedTitle(title, name)
        expect([name, title, brandedTitle(once, name)]).toEqual([name, title, once])
      }
    }
  })

  test('cannot grow without bound under an observer of its own writes', () => {
    // The loop as the page runs it: write, observe, write again.
    let title = 'Content | Umbraco'
    let writes = 0
    for (let i = 0; i < 50; i++) {
      const corrected = brandedTitle(title, 'Content | Umbraco')
      if (corrected === title) break
      title = corrected
      writes++
    }
    expect(writes).toBeLessThanOrEqual(1)
    expect(title.length).toBeLessThan(60)
  })
})

describe('the site’s name', () => {
  test('is what the shell states, not whatever the title happens to say', () => {
    const paths = createBackOfficePaths({ backOfficePath: '/bunbraco' })
    const shell = renderBackOfficeShell(
      paths,
      { imports: {} },
      {
        ...DEFAULT_SHELL_SETTINGS,
        title: 'Acme & Sons',
      },
    )
    expect(shell).toContain('<meta name="application-name" content="Acme &amp; Sons" />')
    expect(brandName(doc('<meta name="application-name" content="Acme" />'))).toBe('Acme')
  })

  test('falls back to Bunbraco when the shell does not say', () => {
    expect(brandName(doc('<title>Content | Umbraco</title>'))).toBe('Bunbraco')
    expect(brandName(doc('<meta name="application-name" content="  " />'))).toBe('Bunbraco')
  })

  test('is not read from the title by the entry point', async () => {
    const source = await Bun.file('packages/backoffice-host/plugin/branding/branding.js').text()
    expect(source).not.toMatch(/=\s*\(?\s*document\.title\s*\|\|/)
  })
})

describe('the colour scheme', () => {
  const paths = createBackOfficePaths()
  const themeHref = `${paths.pluginPath}/branding/theme.css`

  test('loads after the vendored stylesheet it overrides, in both shells', () => {
    for (const html of [
      renderBackOfficeShell(paths, { imports: {} }),
      renderLoginShell(paths, { imports: {} }, loginSettings),
    ]) {
      expect(html).toContain(`<link rel="stylesheet" href="${themeHref}" />`)
      // Equal specificity, so the later sheet is the one that applies.
      expect(html.indexOf(themeHref)).toBeGreaterThan(html.indexOf('/css/light.css'))
    }
  })

  test('is served from the plugin directory', () => {
    expect(resolveStaticFile(paths, themeHref)?.file).toBe(
      join(paths.pluginDir, 'branding/theme.css'),
    )
  })

  test('repaints the accent the client routes through the violet-blue palette', async () => {
    const css = await Bun.file(`${BRANDING_DIR}/theme.css`).text()
    expect(css).toContain('--uui-palette-violet-blue: var(--bunbraco-orange)')
    expect(css).toContain('--uui-color-header-surface: var(--bunbraco-orange)')
    expect(css).toContain('--bunbraco-orange: #e89550')
  })

  test('puts dark ink on the accent, because the accent is light', async () => {
    // Stock light.css puts white on it, which against this orange is ~2.4:1.
    const css = await Bun.file(`${BRANDING_DIR}/theme.css`).text()
    for (const token of ['--uui-color-default-contrast', '--uui-color-selected-contrast']) {
      expect(css).toContain(`${token}: var(--bunbraco-cocoa)`)
    }
    expect(css).toContain('--bunbraco-cocoa: #3b2412')
  })

  test('leaves the semantic colours alone, so success stays green and danger red', async () => {
    const css = await Bun.file(`${BRANDING_DIR}/theme.css`).text()
    for (const token of ['--uui-color-positive', '--uui-color-danger', '--uui-color-warning']) {
      expect([token, css.includes(`${token}:`)]).toEqual([token, false])
    }
  })
})

describe('the logos', () => {
  test('carry the brand colours and no trace of the Umbraco-era blue', async () => {
    for (const file of ['logo-header.svg', 'logo-surface.svg', 'favicon.svg']) {
      const svg = await Bun.file(`${BRANDING_DIR}/${file}`).text()
      expect([file, svg.includes('#3b2412')]).toEqual([file, true])
      // The two blues the marks used before.
      expect([file, /#283a97|#3544b1/i.test(svg)]).toEqual([file, false])
    }
  })

  test('are the one dark mark, on the orange header and on white alike', async () => {
    // The bun reads on the orange header band and on white, so unlike the two
    // circles it replaced there is no lighter variant to keep in step.
    for (const file of ['logo-header.svg', 'logo-surface.svg']) {
      const svg = await Bun.file(`${BRANDING_DIR}/${file}`).text()
      expect([file, svg.includes('#e89550')]).toEqual([file, false])
      expect([file, svg.includes('aria-label="bunbraco"')]).toEqual([file, true])
    }
  })

  test('cut the same bun silhouette, the backdrop watermark included', async () => {
    // Four files draw this mark and nothing generates them, so the only thing
    // stopping the shape drifting in one of them is this comparison.
    const silhouettes = await Promise.all(
      ['logo-header.svg', 'logo-surface.svg', 'favicon.svg', 'backdrop.svg'].map(
        async (file) => {
          const svg = await Bun.file(`${BRANDING_DIR}/${file}`).text()
          return [file, /<path d="([^"]+)"/.exec(svg)?.[1]] as const
        },
      ),
    )
    const [, bun] = silhouettes[0]
    // A flat-bottomed dome, not the circle the mark started as.
    expect(bun).toMatch(/^M10 243C/)
    for (const [file, d] of silhouettes) expect([file, d]).toEqual([file, bun])
  })
})

describe('the System information modal', () => {
  test('renames the product in the rows and the copied heading', () => {
    expect(rebrandSysinfo('Umbraco build version: 18.2.0')).toBe('Bunbraco build version: 18.2.0')
    expect(rebrandSysinfo('Umbraco assembly version: ')).toBe('Bunbraco assembly version: ')
    expect(rebrandSysinfo('Umbraco client version: 18.2.0')).toBe('Bunbraco client version: 18.2.0')
    expect(rebrandSysinfo('Umbraco system information')).toBe('Bunbraco system information')
  })

  test('is a fixed point, so re-applying it to its own output changes nothing', () => {
    const once = rebrandSysinfo('Umbraco build version: 1\nUmbraco client version: 2')
    expect(rebrandSysinfo(once)).toBe(once)
  })

  test('leaves the rows that are the browser’s own words, not the client’s', () => {
    // The same text carries the user agent and the current URL, so a blanket
    // replacement would rewrite whatever a site happens to have in its address.
    for (const row of [
      'Browser location: https://example.com/umbraco/section/settings',
      'Browser (user agent): Mozilla/5.0 Umbraco-Crawler/1.0',
      'User sections: Umb.Section.Content',
      'Runtime mode: Production',
    ]) {
      expect([row, rebrandSysinfo(row)]).toEqual([row, row])
    }
  })

  test('only claims the modal’s own clipboard payload', () => {
    expect(isSysinfoClipboardText('```\nUmbraco system information\n---\nx')).toBe(true)
    expect(isSysinfoClipboardText('a paragraph a user copied out of an editor')).toBe(false)
    expect(isSysinfoClipboardText(undefined)).toBe(false)
  })

  test('patches the row property rather than the shadow DOM it renders into', async () => {
    // Walking the shadow root would need an observer and would miss the copy
    // button; the reactive property is upstream of both.
    const source = await Bun.file(`${BRANDING_DIR}/sysinfo.js`).text()
    expect(source).toContain("'_systemInformation'")
    expect(source).toContain("whenDefined('umb-sysinfo')")
  })
})

describe('the client credential dialog’s prefix label', () => {
  test('says what the server now requires', () => {
    // The dialog submits the typed value whole, so this label is the only thing
    // telling an administrator what to type. If it drifts from the server's
    // prefix, the dialog cannot be completed at all.
    expect(REQUIRED_PREFIX).toBe('bunbraco-back-office-')
  })

  test('corrects the vendored label once and then leaves it be', () => {
    expect(needsCorrection('umbraco-back-office-')).toBe(true)
    expect(needsCorrection(' umbraco-back-office- ')).toBe(true)
    expect(needsCorrection(REQUIRED_PREFIX)).toBe(false)
    expect(needsCorrection('')).toBe(false)
    expect(needsCorrection(undefined)).toBe(false)
  })
})

describe('the non-English languages', () => {
  const keys = curatedKeys(english as Record<string, Record<string, string>>)
  const generated = existsSync(LOCALIZATIONS_DIR)
    ? readdirSync(LOCALIZATIONS_DIR).filter((f) => f.endsWith('.js'))
    : []

  test('are generated for every language whose curated keys name Umbraco', async () => {
    const cultures = readdirSync(LANG_DIR)
      .filter((f) => f.endsWith('.js'))
      .map((f) => f.replace(/\.js$/, ''))
    for (const culture of cultures) {
      // en and en-us are the hand-written override, not generated.
      if (culture === 'en' || culture === 'en-us') continue
      const dictionary = (await import(join(process.cwd(), LANG_DIR, `${culture}.js`))).default
      const needed = brandDictionary(dictionary, keys) !== undefined
      expect([culture, generated.includes(`${culture}.js`)]).toEqual([culture, needed])
    }
  })

  test('no generated override still names Umbraco in anything it displays', async () => {
    expect(generated.length).toBeGreaterThan(0)
    for (const file of generated) {
      const { default: dictionary } = await import(join(process.cwd(), LOCALIZATIONS_DIR, file))
      const values = Object.values(dictionary as Record<string, Record<string, string>>).flatMap(
        (section) => Object.values(section),
      )
      expect([file, values.length > 0]).toEqual([file, true])
      for (const value of values) {
        expect([file, value, /umbraco/i.test(value)]).toEqual([file, value, false])
      }
      expect([file, values.some((v) => /bunbraco/i.test(v))]).toEqual([file, true])
    }
  })

  test('leaves the dictionary keys alone, because those are Umbraco’s identifiers', async () => {
    // `general.umbracoInfo` is the key the client asks for by name. Renaming it
    // would make the override miss, and nobody reads a key.
    const { default: dictionary } = await import(join(process.cwd(), LOCALIZATIONS_DIR, 'da.js'))
    const general = (dictionary as Record<string, Record<string, string>>).general ?? {}
    expect(Object.keys(general)).toContain('umbracoInfo')
  })

  test('the generated manifest registers each one against its own culture', async () => {
    const manifest = await Bun.file(join(LOCALIZATIONS_DIR, 'umbraco-package.json')).json()
    expect(manifest.extensions).toHaveLength(generated.length)
    for (const extension of manifest.extensions) {
      expect(extension.type).toBe('localization')
      // Lowest weight wins: the registry sorts highest-to-lowest and applies in
      // that order, so 0 lands after the core dictionary's 100.
      expect(extension.weight).toBe(0)
      expect(extension.js).toBe(
        `${PLUGIN_PATH_PLACEHOLDER}/localizations/${extension.meta.culture}.js`,
      )
      expect(generated).toContain(`${extension.meta.culture}.js`)
    }
  })

  test('refuses a string that names a configuration key rather than the product', () => {
    for (const value of [
      "The appSetting 'Umbraco:CMS:Global:UseHttps' is set to 'false'.",
      'Read more at umbraco.com',
      'Visit /umbraco/ to sign in',
      'no mention at all',
    ]) {
      expect([value, rebrand(value)]).toEqual([value, undefined])
    }
    expect(rebrand('Log ind på Umbraco')).toBe('Log ind på Bunbraco')
  })

  test('generates nothing for a language that never names the product', () => {
    expect(brandDictionary({ login: { instruction: 'Conectare' } }, keys)).toBeUndefined()
  })
})
