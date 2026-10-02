/**
 * Reads the change report the server keeps at <backoffice>/bunbraco/api/change-report.
 * The cookie carries the session, so no token handling is needed here.
 */
export async function fetchReport() {
  const base = document.querySelector('base')?.getAttribute('href') ?? '/umbraco/'
  const response = await fetch(`${base.replace(/\/$/, '')}/bunbraco/api/change-report`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`change report responded ${response.status}`)
  return response.json()
}
