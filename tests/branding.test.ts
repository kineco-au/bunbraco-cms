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
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createBackOfficePaths,
  DEFAULT_SHELL_SETTINGS,
  EXTENSION_KEYWORD,
  GRAPHICS_PREFIX,
  PLUGIN_PATH_PLACEHOLDER,
  renderBackOfficeShell,
  renderLoginShell,
  resolveGraphic,
  resolveStaticFile,
  VENDORED_ASSETS_PATH,
} from '@bunbraco/backoffice-host'
import { brandedTitle, brandName } from '../packages/backoffice-host/plugin/branding/branding.js'
import {
  needsCorrection,
  REQUIRED_PREFIX,
} from '../packages/backoffice-host/plugin/branding/client-credentials.js'
import english from '../packages/backoffice-host/plugin/branding/localization-en.js'
import {
  DROPPED,
  REPOSITORY,
  rebrandSearchMenu,
} from '../packages/backoffice-host/plugin/branding/log-viewer-menu.js'
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

  test('the favicon sits on a full-bleed square of the header fill', async () => {
    // The exception to the rule above: a tab strip gives the mark no ground of
    // its own, so this one carries the header bar's colour behind it.
    const svg = await Bun.file(`${BRANDING_DIR}/favicon.svg`).text()
    expect(svg).toContain('viewBox="0 0 345 345"')
    expect(svg).toContain('<rect width="345" height="345" fill="#e89550"/>')
    const theme = await Bun.file(`${BRANDING_DIR}/theme.css`).text()
    expect(theme).toContain('--uui-color-header-surface: var(--bunbraco-orange)')
    expect(theme).toContain('--bunbraco-orange: #e89550')
  })

  test('cut the same bun silhouette, the backdrop watermark included', async () => {
    // Five files draw this mark and nothing generates them, so the only thing
    // stopping the shape drifting in one of them is this comparison.
    const silhouettes = await Promise.all(
      [
        'logo-header.svg',
        'logo-surface.svg',
        'favicon.svg',
        'backdrop.svg',
        // The registry icon, served in place of Umbraco's roundel.
        'icon-mark.js',
      ].map(async (file) => {
        const svg = await Bun.file(`${BRANDING_DIR}/${file}`).text()
        return [file, /<path d="([^"]+)"/.exec(svg)?.[1]] as const
      }),
    )
    const bun = silhouettes[0]?.[1]
    // A flat-bottomed dome, not the circle the mark started as.
    expect(bun).toMatch(/^M10 243C/)
    for (const [file, d] of silhouettes) expect([file, d]).toEqual([file, bun])
  })
})

describe('the section Umbraco calls Packages', () => {
  const dictionary = english as Record<string, Record<string, string>>

  test('is named Bundles, because that is the artifact it builds', async () => {
    // The nav filters section manifests by `allowedSections.includes(alias)`
    // (`backoffice.context.js`), so a replacement manifest under a bunbraco
    // alias would vanish from the nav rather than rename anything. The label is
    // a dictionary key, so overriding the key is the whole rename.
    expect(dictionary.sections?.packages).toBe('Bundles')
    const manifests = await Bun.file(
      'packages/backoffice-dist/dist/packages/packages/package-section/manifests.js',
    ).text()
    expect(manifests).toContain("label: '#sections_packages'")
  })

  test('says bundle in the flow that builds one', async () => {
    expect(dictionary.packager?.createPackage).toBe('Create bundle')
    expect(dictionary.packager?.noPackagesCreated).toBe('No bundles have been created yet')
  })

  test('names its three views for what each one holds, not for the section', async () => {
    // Umbraco labels its Marketplace view "Packages", which under a section of
    // the same name said nothing twice.
    const plugin = await Bun.file('packages/backoffice-host/plugin/umbraco-package.json').json()
    const label = (alias: string) =>
      plugin.extensions.find((e: { alias: string }) => e.alias === alias)?.meta?.label
    expect(label('Bunbraco.SectionView.Bundles.Marketplace')).toBe('Marketplace')
    expect(label('Bunbraco.SectionView.Bundles.Installed')).toBe('Installed')
    expect(dictionary.packager?.created).toBeUndefined()
  })

  test('a bundle is found on npm by the keyword that names it', async () => {
    // The client shows the keyword in its empty state, so the two must agree or
    // the screen tells you to publish under a keyword nothing searches for.
    expect(EXTENSION_KEYWORD).toBe('bunbraco-bundle')
    const marketplace = await Bun.file(
      'packages/backoffice-host/plugin/bundles-marketplace.js',
    ).text()
    expect(marketplace).toContain(`this._keyword = '${EXTENSION_KEYWORD}'`)
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

  test('restores an article the new name can no longer elide', () => {
    // French elides `de` before a vowel; Bunbraco opens on a consonant, so the
    // blunt replacement left `d'Bunbraco` where the article belongs.
    expect(rebrand("Chercher dans le code source d'Umbraco sur Github")).toBe(
      'Chercher dans le code source de Bunbraco sur Github',
    )
  })

  test('generates nothing for a language that never names the product', () => {
    expect(brandDictionary({ login: { instruction: 'Conectare' } }, keys)).toBeUndefined()
  })
})

describe('the client’s own sign-in screen', () => {
  const paths = createBackOfficePaths()
  const signIn = () => Bun.file(`${BRANDING_DIR}/sign-in.js`).text()

  test('offers one button, and it names no product', async () => {
    // The vendored manifest labels its provider `Umbraco` under the roundel,
    // which the default button renders through `login_signInWith` as
    // "Sign in with Umbraco". Ours supplies its own element, so neither the
    // dictionary template nor an icon gets a say.
    const source = await signIn()
    expect(source).toContain("const LABEL = 'Sign in'")
    expect(source).toContain('elementName: TAG')
    // The default button is what reads `meta.defaultView.icon`.
    expect(source).not.toContain('defaultView')
    // Whatever the label is, it cannot name the product.
    const label = /const LABEL = '([^']*)'/.exec(source)?.[1] ?? ''
    expect(/umbraco/i.test(label)).toBe(false)
  })

  test('replaces the vendored provider rather than overwriting it', async () => {
    // `app-auth.controller.js` reads `byType('authProvider')` and skips this
    // screen when exactly one provider is registered — and `byType` does not
    // apply `overwrites`, which is resolved where an extension is rendered. An
    // `overwrites` manifest would leave two providers in that list and so add a
    // screen that signing in does not currently show.
    const source = await signIn()
    expect(source).toContain("const VENDORED = 'Umb.AuthProviders.Umbraco'")
    expect(source).toContain('extensionRegistry.unregister(VENDORED)')
    // Nothing in the manifest either: the entry point is the whole mechanism.
    const plugin = await Bun.file('packages/backoffice-host/plugin/umbraco-package.json').json()
    const providers = plugin.extensions.filter((e: { type: string }) => e.type === 'authProvider')
    expect(providers).toEqual([])
  })

  test('keeps the provider name the server authorizes against', async () => {
    // Renaming this would take the button to an identity provider the authorize
    // endpoint does not know, and would stop the view hiding it when local
    // login is off. Nothing displays it.
    expect(await signIn()).toContain("forProviderName: 'Umbraco'")
  })

  test('loses the two curves the view draws across its panel', async () => {
    // Set on `:root`, which is the only way in: the curves are inside a shadow
    // root and these are the element's own hooks, read off `:host`.
    const css = await Bun.file(`${BRANDING_DIR}/theme.css`).text()
    expect(css).toContain('--umb-login-curves-display: none')
  })

  test('fills that panel with the backdrop, which nothing used to answer', () => {
    // Unanswered, the panel was an empty rounded rectangle behind the curves.
    expect(resolveGraphic(paths, `${GRAPHICS_PREFIX}/login-background`)).toBe(
      join(paths.pluginDir, 'branding/backdrop.svg'),
    )
  })

  test('runs from an entry point, so it is in place before a session times out', async () => {
    const plugin = await Bun.file('packages/backoffice-host/plugin/umbraco-package.json').json()
    const entry = plugin.extensions.find(
      (e: { alias: string }) => e.alias === 'Bunbraco.EntryPoint.SignIn',
    )
    expect(entry?.type).toBe('backofficeEntryPoint')
    expect(entry?.js).toBe(`${PLUGIN_PATH_PLACEHOLDER}/branding/sign-in.js`)
  })
})

describe('the Umbraco mark in the icon registry', () => {
  const paths = createBackOfficePaths()
  const VENDORED_ICON = 'packages/core/icon-registry/icons/icon-umbraco.js'

  test('is served as the bun mark, on both prefixes', () => {
    // The registry is addressed by name and any element may ask for one, so the
    // glyph behind the name is ours and no path reaches the roundel.
    for (const prefix of [`${paths.assetsPath}/`, `${VENDORED_ASSETS_PATH}/`]) {
      expect(resolveStaticFile(paths, `${prefix}${VENDORED_ICON}`)?.file).toBe(
        join(paths.pluginDir, 'branding/icon-mark.js'),
      )
    }
  })

  test('is matched by shape, because the chunk is named after its contents', () => {
    // The shells load the *bundled* app, whose icon manifest asks for
    // `chunks/icon-umbraco-<hash>.js` — so an exact path would be right until
    // the next re-vendor and then quietly serve the roundel again.
    const chunk = readdirSync(join(paths.vendorDir, 'chunks')).find((file) =>
      file.startsWith('icon-umbraco'),
    )
    expect(chunk).toBeDefined()
    expect(resolveStaticFile(paths, `${paths.assetsPath}/chunks/${chunk}`)?.file).toBe(
      join(paths.pluginDir, 'branding/icon-mark.js'),
    )
  })

  test('is the only vendored file still drawing the roundel', async () => {
    // Nothing else may be left for a path to reach. The `.d.ts` beside the glyph
    // is a type declaration the browser never asks for.
    const drawn: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(path)
        } else if (entry.name.endsWith('.js') && !entry.name.startsWith('icon-umbraco')) {
          // The roundel's own outline, as `icon-umbraco.js` draws it.
          if (readFileSync(path, 'utf8').includes('M0 157.74')) drawn.push(path)
        }
      }
    }
    walk(paths.vendorDir)
    expect(drawn).toEqual([])
  })

  test('draws in the consumer’s colour, as every icon in the registry does', async () => {
    const { default: svg } = await import(join(process.cwd(), BRANDING_DIR, 'icon-mark.js'))
    expect(svg).toContain('fill="currentColor"')
    // The root element carries no size of its own: the consumer sets it, which
    // is why a viewBox is the only geometry on it.
    const root = /^<svg[^>]*>/.exec(svg)?.[0] ?? ''
    expect(root).toContain('viewBox="0 0 345 345"')
    expect(root).not.toMatch(/\s(?:width|height)="/)
    // `uui-icon` inlines this markup into the page, where the short mask ids the
    // shells' own marks use would collide with it.
    expect(svg).not.toMatch(/id="[bgm]"/)
    expect(svg).toContain('id="bunbraco-icon-mark"')
  })

  test('is not offered by the icon picker', async () => {
    // The picker renders `icon.name` into the button's label and title, so the
    // roundel sat among the document type icons under the name `icon-umbraco`.
    const source = await Bun.file(`${BRANDING_DIR}/icon-registry.js`).text()
    expect(source).toContain("new Set(['icon-umbraco'])")
    // `approvedIcons` is the list the picker reads; `icons` is left whole.
    expect(source).toContain('this.approvedIcons')
  })

  test('replaces the icons context, where overwrites is applied', async () => {
    // Unlike a second `icons` extension, which would win or lose on the order
    // its module happens to resolve in: the context appends each one as it
    // loads, and the last append of a name is the one that stands.
    const plugin = await Bun.file('packages/backoffice-host/plugin/umbraco-package.json').json()
    const context = plugin.extensions.find(
      (e: { alias: string }) => e.alias === 'Bunbraco.GlobalContext.Icons',
    )
    expect(context?.type).toBe('globalContext')
    expect(context?.overwrites).toEqual(['Umb.GlobalContext.Icons'])
    expect(context?.api).toBe(`${PLUGIN_PATH_PLACEHOLDER}/branding/icon-registry.js`)
  })
})

describe('the Log Viewer’s search menu', () => {
  // The element resolves labels through the dictionary before this sees them.
  const term = (key: string) => key.replace('logViewer_', '')
  type MenuItem = { label: string; href: () => string; icon: string }
  const menu: MenuItem[] = [
    {
      label: 'searchWithGoogle',
      href: () => 'https://www.google.com/search?q=boom',
      icon: 'icon-google',
    },
    {
      label: 'searchOurUmbraco',
      href: () => 'https://forum.umbraco.com/search?q=boom',
      icon: 'icon-umbraco',
    },
    {
      label: 'searchOurUmbracoWithGoogle',
      href: () => 'https://www.google.com/?q=site:forum.umbraco.com%20boom',
      icon: 'icon-google',
    },
    {
      label: 'searchUmbracoSource',
      href: () => 'https://github.com/umbraco/Umbraco-CMS/search?q=Umb.Core',
      icon: 'icon-github',
    },
    {
      label: 'searchUmbracoIssues',
      href: () => 'https://github.com/umbraco/Umbraco-CMS/issues?q=Umb.Core',
      icon: 'icon-github',
    },
  ]

  test('drops the two that search a forum this project does not have', () => {
    expect(
      rebrandSearchMenu(menu, term, 'Bunbraco.Core').map((item: MenuItem) => item.label),
    ).toEqual(['searchWithGoogle', 'searchUmbracoSource', 'searchUmbracoIssues'])
  })

  test('aims the source and issue searches at this repository', () => {
    // By the SourceContext of the line, which is the whole point of the pair.
    expect(
      rebrandSearchMenu(menu, term, 'Bunbraco.Core').map((item: MenuItem) => item.href()),
    ).toEqual([
      'https://www.google.com/search?q=boom',
      `${REPOSITORY}/search?q=Bunbraco.Core`,
      `${REPOSITORY}/issues?q=Bunbraco.Core`,
    ])
  })

  test('leaves no item pointing at Umbraco, nor any under its mark', () => {
    for (const item of rebrandSearchMenu(menu, term, 'Bunbraco.Core') as MenuItem[]) {
      expect([item.label, /umbraco/i.test(item.href())]).toEqual([item.label, false])
      expect([item.label, item.icon]).not.toEqual([item.label, 'icon-umbraco'])
    }
  })

  test('passes an item it does not know about through untouched', () => {
    // Wrapping the method rather than replacing it is what keeps an upstream
    // addition in the menu instead of silently dropping it.
    const extra = { label: 'somethingNew', href: () => 'https://example.com', icon: 'icon-search' }
    expect(rebrandSearchMenu([extra], term, 'Bunbraco.Core')).toEqual([extra])
  })

  test('names the keys it drops as the dictionary spells them', () => {
    expect(DROPPED).toEqual(['logViewer_searchOurUmbraco', 'logViewer_searchOurUmbracoWithGoogle'])
  })

  test('says Bunbraco in the two labels it keeps', () => {
    const dictionary = english as Record<string, Record<string, string>>
    expect(dictionary.logViewer?.searchUmbracoSource).toBe('Search Bunbraco source')
    expect(dictionary.logViewer?.searchUmbracoIssues).toBe('Search Bunbraco issues')
  })
})
