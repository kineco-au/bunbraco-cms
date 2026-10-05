/**
 * Reads and drives the Bundles endpoints the server keeps at
 * <backoffice>/bunbraco/api/bundles/*. The session cookie carries the auth.
 */
const base = () => {
  const href = document.querySelector('base')?.getAttribute('href') ?? '/umbraco/'
  return `${href.replace(/\/$/, '')}/bunbraco/api/bundles`
}

const json = async (path, init) => {
  const response = await fetch(`${base()}${path}`, {
    credentials: 'include',
    headers: {
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
    ...init,
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok && response.status !== 400)
    throw new Error(`bundles responded ${response.status}`)
  return body
}

export const searchMarketplace = (query) =>
  json(`/marketplace${query ? `?q=${encodeURIComponent(query)}` : ''}`)

export const listInstalled = () => json('/installed')

export const installBundle = (name, version) =>
  json('/install', { method: 'POST', body: JSON.stringify({ name, version }) })

export const uninstallBundle = (name) =>
  json('/uninstall', { method: 'POST', body: JSON.stringify({ name }) })
