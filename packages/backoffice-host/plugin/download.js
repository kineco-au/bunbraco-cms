/**
 * Saves a file the server serves, for a button that downloads one. Fetched
 * rather than linked: the backoffice router takes over every link click, a
 * `download` one included, and answers an address it has no page for with
 * "route could not be found".
 */
export async function downloadFile(url, fallbackName) {
  const response = await fetch(url, { credentials: 'include' })
  if (response.status === 403) throw new Error('You do not have permission for that.')
  if (!response.ok) throw new Error(`The download responded ${response.status}.`)
  const named = /filename="?([^";]+)"?/.exec(response.headers.get('content-disposition') ?? '')
  const objectUrl = URL.createObjectURL(await response.blob())
  // Never added to the page, so its click reaches no router.
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = named?.[1] ?? fallbackName
  link.click()
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
}
