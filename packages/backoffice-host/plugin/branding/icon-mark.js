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
export default `<svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 345 345"><defs><mask id="bunbraco-icon-mark"><rect width="345" height="345" fill="#fff"/><rect x="114" y="92" width="30" height="166" rx="15" fill="#000"/><circle cx="184" cy="206" r="42" fill="none" stroke="#000" stroke-width="30"/></mask></defs><path d="M10 243C10 134 83 55 172.5 55C262 55 335 134 335 243C335 272 313 290 283 290L62 290C32 290 10 272 10 243Z" mask="url(#bunbraco-icon-mark)"/></svg>`
