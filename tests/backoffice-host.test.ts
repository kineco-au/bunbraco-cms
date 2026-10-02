import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  collectManifests,
  createBackOfficePaths,
  discoverManifests,
  isSpaRoute,
  type PackageManifest,
  PLUGIN_PATH_PLACEHOLDER,
  renderBackOfficeShell,
  renderLoginShell,
  resolveGraphic,
  resolveStaticFile,
  toResponseModels,
  VENDORED_ASSETS_PATH,
} from '@bunbraco/backoffice-host'
import { loadConfig } from '@bunbraco/server'

const paths = createBackOfficePaths()
const vendored = existsSync(join(paths.vendorDir, 'umbraco-package.json'))

describe('paths', () => {
  test('builds the cache-busted assets path Umbraco uses', () => {
    // The one place the default is pinned; everything else derives from it.
    expect(paths.backOfficePath).toBe('/bunbraco')
    expect(paths.virtualDirectory).toBe('/bunbraco/backoffice')
    expect(paths.assetsPath).toBe(`/bunbraco/backoffice/${paths.cacheBustHash}`)
    expect(paths.cacheBustHash).toMatch(/^[0-9a-f]{16}$/)
  })

  test('honours a custom backoffice path and strips trailing slashes', () => {
    expect(createBackOfficePaths({ backOfficePath: '/admin/' }).virtualDirectory).toBe(
      '/admin/backoffice',
    )
  })

  test('the hash changes when the vendored version changes', () => {
    const other = createBackOfficePaths({ vendorDir: '/nonexistent' })
    expect(other.cacheBustHash).not.toBe(paths.cacheBustHash)
  })
})

describe('SPA routes', () => {
  test('claims the routes the client router owns', () => {
    for (const route of [
      '',
      '/',
      '/section/content',
      '/install',
      '/upgrade',
      '/oauth_complete',
      '/logout',
      '/error',
      '/preview',
    ]) {
      expect(isSpaRoute('/bunbraco', `/bunbraco${route}`)).toBe(true)
    }
  })

  test('does not swallow unrelated paths', () => {
    // Umbraco constrains its catch-all, so a bad /umbraco URL is a real 404.
    expect(isSpaRoute('/bunbraco', '/bunbraco/nonsense')).toBe(false)
    expect(isSpaRoute('/umbraco', '/umbraco/management/api/v1/document')).toBe(false)
    expect(isSpaRoute('/bunbraco', '/')).toBe(false)
    expect(isSpaRoute('/bunbraco', '/bunbracoish')).toBe(false)
  })
})

describe('manifests', () => {
  const core: PackageManifest = {
    name: '@umbraco-cms/backoffice',
    version: '18.2.0',
    extensions: [],
    importmap: {
      imports: {
        '@umbraco-cms/backoffice/auth': '/umbraco/backoffice/packages/core/auth/index.js',
      },
    },
  }

  test('rewrites importmap targets onto the cache-busted path', () => {
    // Mirrors HtmlHelperBackOfficeExtensions, which does a string replace.
    const set = collectManifests(paths)
    for (const target of Object.values(set.importmap.imports)) {
      if (target.startsWith(paths.virtualDirectory)) {
        expect(target.startsWith(`${paths.assetsPath}/`)).toBe(true)
      }
    }
    void core
  })

  test('returns nothing for a directory with no manifests', () => {
    expect(discoverManifests('/nonexistent')).toEqual([])
  })

  test('splits public from private by allowPublicAccess', () => {
    const manifests: PackageManifest[] = [
      { name: 'public-one', allowPublicAccess: true, extensions: [] },
      { name: 'private-one', extensions: [] },
    ]
    expect(toResponseModels(manifests, 'abc', 'public').map((m) => m.name)).toEqual(['public-one'])
    expect(toResponseModels(manifests, 'abc', 'private').map((m) => m.name)).toEqual([
      'private-one',
    ])
    expect(toResponseModels(manifests, 'abc', 'all')).toHaveLength(2)
  })

  test('stamps the cache buster, unless the package opts out', () => {
    const manifests: PackageManifest[] = [
      { name: 'busted', extensions: [] },
      { name: 'opted-out', allowCacheBusting: false, extensions: [] },
    ]
    const [busted, optedOut] = toResponseModels(manifests, 'abc123', 'all')
    expect(busted?.cacheBuster).toBe('abc123')
    expect(optedOut?.cacheBuster).toBeNull()
  })

  test.skipIf(!vendored)('discovers the vendored core manifest', () => {
    const set = collectManifests(paths)
    expect(set.all.map((m) => m.name)).toContain('@umbraco-cms/backoffice')
    expect(Object.keys(set.importmap.imports).length).toBeGreaterThan(100)
  })

  test('rewrites our own manifests’ placeholder to wherever the editor is mounted', () => {
    // The placeholder is nobody's real path. If it and the rewrite ever drift,
    // every extension of ours 404s with nothing in the console to say why.
    const mounted = createBackOfficePaths({ backOfficePath: '/admin' })
    const ours = collectManifests(mounted).all.filter((m) => m.id?.startsWith('Bunbraco.'))
    expect(ours.length).toBeGreaterThan(0)
    const serialised = JSON.stringify(ours)
    expect(serialised).not.toContain(PLUGIN_PATH_PLACEHOLDER)
    expect(serialised).toContain('/admin/bunbraco/branding/branding.js')
  })
})

describe('shell', () => {
  const importmap = { imports: { '@umbraco-cms/backoffice/auth': '/x/auth.js' } }

  test('emits the elements the client boot depends on', () => {
    const html = renderBackOfficeShell(paths, importmap, {
      defaultUiLanguage: 'en-US',
      keepUserLoggedIn: false,
      title: 'Bunbraco',
    })
    // The router derives its base from <base href>, which must end in a slash.
    expect(html).toContain('<base href="/bunbraco/" />')
    expect(html).toContain('<script type="importmap">')
    expect(html).toContain('"@umbraco-cms/backoffice/auth": "/x/auth.js"')
    expect(html).toContain(`src="${paths.assetsPath}/apps/app/app.element.js"`)
    // The client defaults to /umbraco and derives its OAuth redirect from this.
    expect(html).toContain('<umb-app lang="en-US" backoffice-path="/bunbraco">')
    expect(html).toContain(`${paths.assetsPath}/css/umb-css.css`)
    expect(html).toContain(`${paths.assetsPath}/css/light.css`)
  })

  test('adds keep-user-logged-in only when configured', () => {
    const on = renderBackOfficeShell(paths, importmap, {
      defaultUiLanguage: 'en-US',
      keepUserLoggedIn: true,
      title: 'B',
    })
    expect(on).toContain('<umb-app lang="en-US" backoffice-path="/bunbraco" keep-user-logged-in>')
  })

  test('escapes interpolated settings', () => {
    const html = renderBackOfficeShell(paths, importmap, {
      defaultUiLanguage: '"><script>x</script>',
      keepUserLoggedIn: false,
      title: '<b>t</b>',
    })
    expect(html).not.toContain('<script>x</script>')
    expect(html).not.toContain('<b>t</b>')
  })

  test('the login shell configures the login element', () => {
    // Umbraco's own <umb-auth> ships in an unpublished package, so we render our
    // equivalent; see R2 in docs/07-roadmap.md.
    const html = renderLoginShell(paths, importmap, {
      defaultUiLanguage: 'en-US',
      keepUserLoggedIn: false,
      title: 'B',
      usernameIsEmail: true,
      allowUserInvite: false,
      allowPasswordReset: true,
      disableLocalLogin: false,
    })
    expect(html).toContain('<bunbraco-login')
    expect(html).toContain('return-url="/bunbraco"')
    expect(html).toContain('graphics/login-logo')
    expect(html).toContain('src="/bunbraco/login/login.js"')
    // Boolean attributes are present or absent, not ="true"/="false".
    expect(html).toContain('username-is-email')
    expect(html).toContain('allow-password-reset')
    expect(html).not.toContain('allow-user-invite')
    expect(html).not.toContain('disable-local-login')
  })

  test('the login shell carries the return url so sign-in resumes the flow', () => {
    const html = renderLoginShell(paths, importmap, {
      defaultUiLanguage: 'en-US',
      keepUserLoggedIn: false,
      title: 'B',
      usernameIsEmail: true,
      allowUserInvite: false,
      allowPasswordReset: false,
      disableLocalLogin: false,
      returnUrl: '/umbraco/management/api/v1/security/back-office/authorize?client_id=x',
    })
    expect(html).toContain(
      'return-url="/umbraco/management/api/v1/security/back-office/authorize?client_id=x"',
    )
  })
})

describe('static serving', () => {
  test('strips the cache-bust segment before looking the file up', () => {
    const match = resolveStaticFile(paths, `${paths.assetsPath}/apps/app/app.element.js`)
    expect(match?.file).toBe(join(paths.vendorDir, 'apps/app/app.element.js'))
    expect(match?.cacheControl).toContain('immutable')
  })

  test('serves a stale hash from a previous deploy without caching it', () => {
    const match = resolveStaticFile(
      paths,
      `${paths.virtualDirectory}/0000000000000000/css/light.css`,
    )
    expect(match?.file).toBe(join(paths.vendorDir, 'css/light.css'))
    expect(match?.cacheControl).toBe('no-cache')
  })

  test('does not mark the hashed path immutable in development', () => {
    const match = resolveStaticFile(paths, `${paths.assetsPath}/css/light.css`, {
      immutable: false,
    })
    expect(match?.cacheControl).toBe('no-cache')
  })

  test('lets a long-lived development process opt back into immutable assets', () => {
    // `immutableAssets` exists for the browser suite, which runs in development
    // mode but signs in forty-odd times. Without it the browser re-fetches every
    // one of the client's ~6,500 modules on each sign-in, and a CI runner answers
    // with ERR_INSUFFICIENT_RESOURCES — which then looks like a test failure
    // anywhere but here. The config default and this flag must stay independent.
    const config = loadConfig({ development: true, immutableAssets: true })
    expect(config.immutableAssets ?? !config.development).toBe(true)
    // The default is still off in development, and on in production.
    expect(loadConfig({ development: true }).immutableAssets ?? false).toBe(false)
    const production = loadConfig({ development: false })
    expect(production.immutableAssets ?? !production.development).toBe(true)
  })

  test('the browser suite asks for them, because that is the whole point', async () => {
    const serve = await Bun.file('tests/browser/serve.ts').text()
    expect(serve).toContain('immutableAssets: true')
    // And cleans up the sites earlier runs abandoned, which is how 1.1 GB of
    // gitignored SQLite WAL once accumulated unnoticed.
    expect(serve).toContain("startsWith('browser-site-')")
  })

  test('serves App_Plugins when configured', () => {
    const match = resolveStaticFile(paths, '/App_Plugins/my-pkg/index.js', {
      appPluginsDir: '/plugins',
    })
    expect(match?.file).toBe('/plugins/my-pkg/index.js')
  })

  test('refuses to traverse outside the vendored root', () => {
    for (const attack of [
      `${paths.assetsPath}/../../../../etc/passwd`,
      `${paths.assetsPath}/%2e%2e%2f%2e%2e%2fetc/passwd`,
      `${paths.virtualDirectory}/../../secret`,
    ]) {
      const match = resolveStaticFile(paths, attack)
      if (match) expect(match.file.startsWith(paths.vendorDir)).toBe(true)
    }
  })

  test('ignores paths that are not ours', () => {
    expect(resolveStaticFile(paths, '/')).toBeUndefined()
    expect(resolveStaticFile(paths, paths.backOfficePath)).toBeUndefined()
    expect(resolveStaticFile(paths, '/App_Plugins/x.js')).toBeUndefined()
  })
})

describe('graphics', () => {
  test('resolves the branding images the shells reference', () => {
    const prefix = '/umbraco/management/api/v1/security/back-office/graphics'
    for (const name of ['logo', 'logo-alternative', 'login-logo', 'login-logo-alternative']) {
      expect(resolveGraphic(paths, `${prefix}/${name}`)).toBeTruthy()
    }
  })

  test("no longer serves Umbraco's login illustration, which nothing asked for", () => {
    const prefix = '/umbraco/management/api/v1/security/back-office/graphics'
    expect(resolveGraphic(paths, `${prefix}/background`)).toBeUndefined()
  })

  test("the logos and favicon are bunbraco's, in place of Umbraco's", async () => {
    const prefix = '/umbraco/management/api/v1/security/back-office/graphics'
    for (const [name, file] of [
      ['logo', 'logo-header.svg'],
      ['logo-alternative', 'logo-surface.svg'],
      ['login-logo', 'logo-header.svg'],
      ['login-logo-alternative', 'logo-surface.svg'],
    ]) {
      const resolved = resolveGraphic(paths, `${prefix}/${name}`) as string
      expect([name, resolved.endsWith(`branding/${file}`)]).toEqual([name, true])
      expect(await Bun.file(resolved).text()).toContain('bunbraco')
    }
    // Every one of Umbraco's marks, on both the hashed and the plain prefix. MIT
    // licenses the code and not the trademarks, so none of these may reach the
    // vendored file — and none of them is committed any more.
    for (const asset of [
      'assets/favicon.svg',
      'assets/umbraco-logo.svg',
      'assets/installer-illustration.svg',
    ])
      for (const prefix of [paths.assetsPath, paths.virtualDirectory, VENDORED_ASSETS_PATH])
        expect([asset, resolveStaticFile(paths, `${prefix}/${asset}`)?.file]).toEqual([
          asset,
          expect.stringContaining('/branding/'),
        ])
    // Everything else in the client is still the client's
    expect(resolveStaticFile(paths, `${paths.assetsPath}/css/umb-css.css`)?.file).toContain(
      paths.vendorDir,
    )
  })

  test("does not carry Umbraco's marks, which MIT does not license", () => {
    // The seed is what a fresh clone gets; a mark reappearing in it is the way
    // this regresses, since `vendor:refresh-static` copies whatever is listed.
    const seed = join(paths.vendorDir, '..', 'upstream-static')
    for (const mark of ['umbraco-logo.svg', 'installer-illustration.svg', 'favicon.svg'])
      expect([mark, existsSync(join(seed, 'assets', mark))]).toEqual([mark, false])
  })

  test('ignores unknown graphics', () => {
    expect(
      resolveGraphic(paths, '/umbraco/management/api/v1/security/back-office/graphics/nope'),
    ).toBeUndefined()
    expect(resolveGraphic(paths, '/somewhere/else')).toBeUndefined()
  })
})
