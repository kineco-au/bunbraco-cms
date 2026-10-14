/**
 * Reads and saves search and sharing at `<backoffice>/crombolo/api/seo/*`. The
 * session cookie carries the auth, as it does for the framework's other plugin
 * endpoints; the base comes from `<base href>` because the backoffice path is
 * configurable.
 */
const base = () => {
  const href = document.querySelector('base')?.getAttribute('href') ?? '/umbraco/'
  return `${href.replace(/\/$/, '')}/crombolo/api/seo`
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
  if (!response.ok) throw new Error(body.message ?? 'Search and sharing could not be loaded.')
  return body
}

export const readSettings = () => json('/settings')

export const saveSettings = (changes) =>
  json('/settings', { method: 'PUT', body: JSON.stringify(changes) })

export const readPreview = (documentKey, culture) => {
  const query = new URLSearchParams({ document: documentKey })
  if (culture) query.set('culture', culture)
  return json(`/preview?${query}`)
}
