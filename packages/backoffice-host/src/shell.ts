/**
 * The server-rendered HTML shells. This is the server's entire HTML
 * responsibility: everything else is the SPA.
 *
 * Ported from Umbraco.Cms.StaticAssets/umbraco/UmbracoBackOffice/Index.cshtml
 * and .../UmbracoLogin/Index.cshtml.
 */

import { MANAGEMENT_API_PATH } from '@bunbraco/core'
import type { PackageManifestImportmap } from './manifests.ts'
import type { BackOfficePaths } from './paths.ts'

export interface ShellSettings {
  /** GlobalSettings.DefaultUILanguage — the initial UI language. */
  defaultUiLanguage: string
  /** SecuritySettings.KeepUserLoggedIn. */
  keepUserLoggedIn: boolean
  title: string
}

export const DEFAULT_SHELL_SETTINGS: ShellSettings = {
  defaultUiLanguage: 'en-US',
  keepUserLoggedIn: false,
  title: 'Bunbraco',
}

export interface LoginShellSettings {
  usernameIsEmail: boolean
  allowUserInvite: boolean
  allowPasswordReset: boolean
  disableLocalLogin: boolean
  /**
   * Where to go once signed in. The authorize endpoint puts its own URL here, so
   * the browser resumes the OAuth flow rather than landing on a blank editor.
   */
  returnUrl?: string
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )

const noscript = (logoUrl: string): string => `<noscript>
  <style>
    #noscript-container { display: flex; flex-wrap: wrap; flex-direction: column;
      align-items: center; justify-content: center; height: 100vh; padding: 0 20px;
      text-align: center; }
  </style>
  <div id="noscript-container">
    <h1 aria-hidden="true" class="uui-h3" style="display: inline-flex; align-items: center; gap: 10px">
      <img alt="logo" src="${logoUrl}" style="width: 100%" />
    </h1>
    <p>For full functionality of Bunbraco it is necessary to enable JavaScript.</p>
  </div>
</noscript>`

/** The `<base href>` must end in a slash: the client router derives its base from it. */
export function renderBackOfficeShell(
  paths: BackOfficePaths,
  importmap: PackageManifestImportmap,
  settings: ShellSettings = DEFAULT_SHELL_SETTINGS,
): string {
  const assets = paths.assetsPath
  const keepLoggedIn = settings.keepUserLoggedIn ? ' keep-user-logged-in' : ''
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <base href="${paths.backOfficePath}/" />
  <link rel="icon" type="image/svg+xml" href="${assets}/assets/favicon.svg" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="robots" content="noindex, nofollow" />
  <meta name="pinterest" content="nopin" />
  <meta name="application-name" content="${escapeHtml(settings.title)}" />
  <title>${escapeHtml(settings.title)}</title>
  <link rel="stylesheet" href="${assets}/css/umb-css.css" />
  <link rel="stylesheet" href="${assets}/css/light.css" />
  <link rel="stylesheet" href="${paths.pluginPath}/branding/theme.css" />
  <script type="importmap">
${JSON.stringify(importmap, null, 2)}
  </script>
  <script type="module" src="${assets}/apps/app/app.element.js"></script>
</head>
<body class="uui-font uui-text" style="margin: 0; padding: 0; overflow: hidden">
${noscript(`${MANAGEMENT_API_PATH}/security/back-office/graphics/login-logo-alternative`)}
${
  /* The client defaults this to '/umbraco' and builds its OAuth redirect_uri
      and post-logout URL from it, so it must be told where the editor is. */ ''
}
<umb-app lang="${escapeHtml(settings.defaultUiLanguage)}" backoffice-path="${escapeHtml(paths.backOfficePath)}"${keepLoggedIn}></umb-app>
</body>
</html>
`
}

export function renderLoginShell(
  paths: BackOfficePaths,
  importmap: PackageManifestImportmap,
  settings: ShellSettings & LoginShellSettings,
): string {
  const assets = paths.assetsPath
  const graphics = `${MANAGEMENT_API_PATH}/security/back-office/graphics`
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <base href="${paths.backOfficePath}/" />
  <link rel="icon" type="image/svg+xml" href="${assets}/assets/favicon.svg" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex, nofollow" />
  <meta name="application-name" content="${escapeHtml(settings.title)}" />
  <title>${escapeHtml(settings.title)}</title>
  <link rel="stylesheet" href="${assets}/css/light.css" />
  <link rel="stylesheet" href="${paths.pluginPath}/branding/theme.css" />
  <style>body { margin: 0; padding: 0; background-color: #fdf6ef; }</style>
  <script type="importmap">
${JSON.stringify(importmap, null, 2)}
  </script>
  <script type="module" src="${paths.backOfficePath}/login/login.js"></script>
</head>
<body class="uui-font uui-text" style="margin: 0; padding: 0; overflow: hidden">
${noscript(`${graphics}/login-logo-alternative`)}
<bunbraco-login
  lang="${escapeHtml(settings.defaultUiLanguage)}"
  return-url="${escapeHtml(settings.returnUrl ?? paths.backOfficePath)}"
  logo-image="${graphics}/login-logo"
  logo-image-alternative="${graphics}/login-logo-alternative"
  ${settings.usernameIsEmail ? 'username-is-email' : ''}
  ${settings.allowUserInvite ? 'allow-user-invite' : ''}
  ${settings.allowPasswordReset ? 'allow-password-reset' : ''}
  ${settings.disableLocalLogin ? 'disable-local-login' : ''}>
</bunbraco-login>
</body>
</html>
`
}
