/**
 * The icon picker, with Umbraco's own mark taken out of it.
 *
 * `icon-umbraco` is one of the 700-odd icons the registry offers, so the picker
 * on a document type or a media type listed the Umbraco roundel among the
 * icons a site can label its content with, under a tooltip and an accessible
 * name of `icon-umbraco` (`icon-picker-modal.element.js` renders `icon.name`
 * into both).
 *
 * The icon list is contributed by `icons` extensions, and the context appends
 * each one as its module resolves — so a second `icons` extension naming the
 * same icon wins or loses on import timing, not on registration order. This
 * replaces the context instead, which is a decision rather than a race: it
 * narrows `approvedIcons`, the list the picker reads, and leaves `icons` whole
 * so anything rendering by name still gets a glyph (`icon-mark.js` makes that
 * glyph ours).
 *
 * Registered with `overwrites`, which is resolved where a `globalContext` is
 * instantiated — unlike `byType`, which is why `sign-in.js` cannot use it.
 */

import { map } from '@umbraco-cms/backoffice/external/rxjs'
import { UmbIconRegistryContext } from '@umbraco-cms/backoffice/icon'

/** Icons the picker does not offer, whatever the registry holds. */
export const WITHHELD = new Set(['icon-umbraco'])

export const isOffered = (icon) => !WITHHELD.has(icon.name)

export class BunbracoIconRegistryContext extends UmbIconRegistryContext {
  constructor(host) {
    super(host)
    // `approvedIcons` is the parent's own filter on `hidden`; this composes with
    // it rather than replacing it, so an icon hidden upstream stays hidden.
    const approved = this.approvedIcons
    this.approvedIcons = approved.pipe(map((icons) => icons.filter(isOffered)))
  }
}

export { BunbracoIconRegistryContext as api }
