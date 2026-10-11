/**
 * The bun mark as a registry icon, served in place of the vendored
 * `icon-umbraco.js` (see `BRANDED_ASSETS` in `graphics.ts`).
 *
 * `icon-registry.js` keeps this name out of the icon picker, so nothing in the
 * interface offers it. This exists because the registry is addressed by name
 * and any element may ask for one, so the glyph behind the name is ours rather
 * than the roundel.
 *
 * `currentColor` and no explicit size, as every icon in the registry: the
 * consumer sets both. The mask id is namespaced because `uui-icon` inlines this
 * markup into the page, where a bare `id="b"` would collide with the marks in
 * the shells.
 */
export default `<svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="16 21 168 168"><defs><mask id="bunbraco-icon-mark"><rect x="16" y="21" width="168" height="168" fill="#fff"/><path d="M83 87V135M88 120a15 15 0 1 0 30 0a15 15 0 1 0-30 0" fill="none" stroke="#000" stroke-width="12" stroke-linecap="round"/></mask></defs><ellipse cx="100" cy="105" rx="78" ry="58" mask="url(#bunbraco-icon-mark)"/></svg>`
