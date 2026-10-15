/**
 * Reads the change report the server keeps at <backoffice>/crombolo/api/change-report.
 * The cookie carries the session, so no token handling is needed here.
 */
export async function fetchReport() {
  const base = document.querySelector('base')?.getAttribute('href') ?? '/umbraco/'
  const response = await fetch(`${base.replace(/\/$/, '')}/crombolo/api/change-report`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`change report responded ${response.status}`)
  return response.json()
}

const apiBase = () =>
  `${(document.querySelector('base')?.getAttribute('href') ?? '/umbraco/').replace(/\/$/, '')}/crombolo/api`

/** Where a pending import's answers download as the file the bundle can carry. */
export const answersUrl = (bundleId) =>
  `${apiBase()}/transfers/${encodeURIComponent(bundleId)}/resolutions`

/** Answers, re-checks or imports a pending content bundle; the body says how it went. */
export async function transferAction(bundleId, verb, body = {}) {
  const response = await fetch(`${apiBase()}/transfers/${encodeURIComponent(bundleId)}/${verb}`, {
    method: 'POST',
    credentials: 'include',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const result = await response.json().catch(() => ({}))
  if (response.status === 403)
    return { ok: false, message: 'You are not allowed to import content.' }
  return { ok: response.ok, ...result }
}
