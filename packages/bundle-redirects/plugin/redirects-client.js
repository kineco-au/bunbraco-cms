/**
 * Reads and drives this bundle's endpoints at
 * `<backoffice>/bunbraco/api/bundle/redirects/*`. The session cookie carries the
 * auth, exactly as the framework's own plugin endpoints do.
 *
 * The base is read from `<base href>` rather than hard-coded, because the
 * backoffice path is configurable (`BUNBRACO_BACKOFFICE_PATH`).
 */
const base = () => {
  const href = document.querySelector('base')?.getAttribute('href') ?? '/umbraco/'
  return `${href.replace(/\/$/, '')}/bunbraco/api/bundle/redirects`
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
  // A refusal carries a message the screen shows, so 400/404/409 are answers
  // rather than failures; anything else is not something to paraphrase.
  if (!response.ok && ![400, 404, 409].includes(response.status))
    throw new Error(`The redirects endpoint answered ${response.status}`)
  return body
}

export const listRedirects = (filter) =>
  json(`/rules${filter ? `?filter=${encodeURIComponent(filter)}` : ''}`)

export const createRedirect = (rule) =>
  json('/rules', { method: 'POST', body: JSON.stringify(rule) })

export const updateRedirect = (key, rule) =>
  json(`/rules/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify(rule) })

export const deleteRedirect = (key) =>
  json(`/rules/${encodeURIComponent(key)}`, { method: 'DELETE' })
