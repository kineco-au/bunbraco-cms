/**
 * Talks to the assistant endpoints under <backoffice>/bunbraco/api/assistant.
 * The session cookie carries the identity, so there is no token handling here —
 * and the server re-issues every CMS call as that same user.
 */
function base() {
  const href = document.querySelector('base')?.getAttribute('href') ?? '/umbraco/'
  return `${href.replace(/\/$/, '')}/bunbraco/api/assistant`
}

async function send(path, init = {}) {
  const response = await fetch(`${base()}${path}`, {
    credentials: 'include',
    headers: { accept: 'application/json', ...(init.headers ?? {}) },
    ...init,
  })
  const text = await response.text()
  const body = text === '' ? undefined : JSON.parse(text)
  if (!response.ok) {
    const error = new Error(body?.error ?? `The assistant responded ${response.status}`)
    error.body = body
    throw error
  }
  return body
}

const json = (method, body) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

export const ask = (message, { changesetKey, history, viewing } = {}) =>
  send('/chat', json('POST', { message, changesetKey, history, viewing }))

export const changesets = () => send('/changesets')

/** Whether the model is usable. `refresh` asks the provider again, model included. */
export const status = (refresh = false) => send(`/status${refresh ? '?refresh=1' : ''}`)

/** One proposal in full, body included — what the editing pane works on. */
export const change = (key) => send(`/changes/${key}`)

/** Replaces what approving would send. The kind and its parameters do not move. */
export const edit = (key, body) => send(`/changes/${key}`, json('PUT', { body }))

/** The proposal against what is there now, read fresh so a stale one says so. */
export const diff = (key) => send(`/changes/${key}/diff`)

/** Approving is the only thing here that changes the CMS, and only a person calls it. */
export const approve = (key) => send(`/changes/${key}/approve`, { method: 'POST' })

export const discard = (key) => send(`/changes/${key}/discard`, { method: 'POST' })
