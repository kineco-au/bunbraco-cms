/**
 * The Created view, in place of Umbraco's.
 *
 * Its manifest declares `overwrites: ['Umb.SectionView.Packages.Builder']`.
 * Umbraco's view is a router, not a screen: it mounts its own overview at
 * `overview` and every `package-builder` workspace at `package-builder/create`
 * and `package-builder/edit/:unique`. Those two routes are the only way to
 * reach the builder, so this reproduces them exactly — replacing the view
 * without them would have left the builder unreachable rather than renamed.
 *
 * What changes is the overview, which is ours and says bundle.
 */
import { createExtensionElement } from '@umbraco-cms/backoffice/extension-api'
import { umbExtensionsRegistry } from '@umbraco-cms/backoffice/extension-registry'
import { html } from '@umbraco-cms/backoffice/external/lit'
import { UmbLitElement } from '@umbraco-cms/backoffice/lit-element'

/** The entity type Umbraco's builder workspace declares, and the route segment. */
export const BUILDER_ENTITY_TYPE = 'package-builder'

export default class BunbracoBundlesCreatedElement extends UmbLitElement {
  static properties = {
    _routes: { state: true },
  }

  constructor() {
    super()
    this._routes = []
    this.observe(
      umbExtensionsRegistry.byTypeAndFilter(
        'workspace',
        (workspace) => workspace.meta?.entityType === BUILDER_ENTITY_TYPE,
      ),
      (workspaces) => {
        this._routes = routesFor(workspaces ?? [])
      },
      null,
    )
  }

  render() {
    return html`<umb-router-slot .routes=${this._routes}></umb-router-slot>`
  }
}

/** Umbraco's own route table, with our overview in place of its own. */
export function routesFor(workspaces) {
  const routes = [{ path: 'overview', component: () => import('./bundles-created-overview.js') }]
  for (const workspace of workspaces) {
    routes.push({
      path: `${workspace.meta.entityType}/edit/:unique`,
      component: () => createExtensionElement(workspace),
      setup: (component, info) => {
        if (component) component.entityUnique = info.match.params.unique
      },
    })
    routes.push({
      path: `${workspace.meta.entityType}/create`,
      component: () => createExtensionElement(workspace),
    })
  }
  routes.push({ path: '', pathMatch: 'full', redirectTo: 'overview' })
  routes.push({
    path: '**',
    component: async () => (await import('@umbraco-cms/backoffice/router')).UmbRouteNotFoundElement,
  })
  return routes
}

customElements.define('bunbraco-bundles-created', BunbracoBundlesCreatedElement)
