/**
 * Reads and drives the Forms endpoints the server keeps at
 * <backoffice>/bunbraco/api/forms/*. The session cookie carries the auth.
 */
const base = () => {
  const href = document.querySelector('base')?.getAttribute('href') ?? '/umbraco/'
  return `${href.replace(/\/$/, '')}/bunbraco/api/forms`
}

const call = async (path, init) => {
  const response = await fetch(`${base()}${path}`, {
    credentials: 'include',
    headers: {
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
    ...init,
  })
  if (response.status === 403) throw new Error('You do not have permission for that.')
  const body = await response.json().catch(() => ({}))
  if (!response.ok && response.status !== 400 && response.status !== 409)
    throw new Error(`forms responded ${response.status}`)
  return { ok: response.ok, status: response.status, body }
}

export const listForms = async () => (await call('')).body.items ?? []

export const readForm = async (key) => (await call(`/${encodeURIComponent(key)}`)).body

export const saveForm = (definition) =>
  call('', { method: 'PUT', body: JSON.stringify(definition) })

export const deleteForm = (key) => call(`/${encodeURIComponent(key)}`, { method: 'DELETE' })

export const listEntries = async (key, query = {}) => {
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(query))
    if (value !== undefined && value !== '') params.set(name, String(value))
  const suffix = params.toString() ? `?${params}` : ''
  return (await call(`/${encodeURIComponent(key)}/entries${suffix}`)).body
}

export const setEntryState = (id, state) =>
  call(`/entries/${encodeURIComponent(id)}/state`, {
    method: 'POST',
    body: JSON.stringify({ state }),
  })

export const deleteEntry = (id) => call(`/entries/${encodeURIComponent(id)}`, { method: 'DELETE' })

/** The CSV is a download, so it is a link rather than a fetch. */
export const entriesCsvUrl = (key) => `${base()}/${encodeURIComponent(key)}/entries.csv`
