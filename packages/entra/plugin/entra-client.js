/**
 * Reads and drives this bundle's endpoints at
 * `<backoffice>/crombolo/api/bundle/entra/*`. The session cookie carries the
 * auth, as it does for the framework's own plugin endpoints; the base comes from
 * `<base href>`, because the backoffice path is configurable.
 */
const base = () => {
  const href = document.querySelector('base')?.getAttribute('href') ?? '/umbraco/'
  return `${href.replace(/\/$/, '')}/crombolo/api/bundle/entra`
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
  // A refusal carries a message the screen shows.
  if (!response.ok && ![400, 403, 404].includes(response.status))
    throw new Error(`The Entra settings endpoint answered ${response.status}`)
  return body
}

const at = (provider) =>
  `/providers/${encodeURIComponent(provider.audience)}/${encodeURIComponent(provider.id)}`

export const listProviders = () => json('/providers')

export const listGroups = (audience) => json(`/groups/${encodeURIComponent(audience)}`)

export const saveProvider = (provider, changes) =>
  json(at(provider), { method: 'PUT', body: JSON.stringify(changes) })

export const resetProvider = (provider) => json(at(provider), { method: 'DELETE' })

export const testProvider = (provider) => json(`${at(provider)}/test`, { method: 'POST' })
