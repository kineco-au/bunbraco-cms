/**
 * The back office's light or dark mode, applied before the first paint
 * (story 049). Umbraco's theme context keeps the choice in `localStorage` and
 * applies it once the client has booted, so a reload painted light first; and
 * the login shell boots no theme context at all. This inline script reads the
 * same key and links the same stylesheet at once.
 */
import type { BackOfficePaths } from './paths.ts'

/** The key Umbraco's theme context keeps the choice under. */
export const THEME_STORAGE_KEY = 'umb-theme-alias'

export const THEME_DARK = 'Crombolo.Theme.Dark'
export const THEME_SYSTEM = 'Crombolo.Theme.System'

/** Umbraco's own dark, which crombolo's replaces: a browser that chose it gets the new one. */
const RENAMED: Record<string, string> = { 'umb-dark-theme': THEME_DARK }

export const EARLY_THEME_ID = 'crombolo-early-theme'

/** Each choice's stylesheet; light, or nothing chosen, needs none beyond the shell's own. */
export function themeStylesheets(paths: BackOfficePaths): Record<string, string> {
  return {
    [THEME_DARK]: `${paths.pluginPath}/branding/theme-dark.css`,
    [THEME_SYSTEM]: `${paths.pluginPath}/branding/theme-system.css`,
    'umb-high-contrast-theme': `${paths.assetsPath}/css/high-contrast.css`,
  }
}

/** The inline script, as the shells embed it. It fails quietly: light is a fine fallback. */
export function earlyThemeScript(paths: BackOfficePaths): string {
  const sheets = JSON.stringify(themeStylesheets(paths))
  const renamed = JSON.stringify(RENAMED)
  return `(function () {
  try {
    var key = ${JSON.stringify(THEME_STORAGE_KEY)};
    var alias = localStorage.getItem(key);
    var renamed = ${renamed};
    if (alias && renamed[alias]) { alias = renamed[alias]; localStorage.setItem(key, alias); }
    var href = alias ? ${sheets}[alias] : undefined;
    if (!href) return;
    var link = document.createElement('link');
    link.id = ${JSON.stringify(EARLY_THEME_ID)};
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-theme', alias);
    document.head.appendChild(link);
  } catch (error) {}
})();`
}
