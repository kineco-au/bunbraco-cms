/**
 * The Workflow screens' calls to <backoffice>/crombolo/api/approvals/ (story 028).
 * The cookie carries the session. Every answer resolves; a refusal carries the
 * server's own words in `message`.
 */
const apiBase = () =>
  `${(document.querySelector('base')?.getAttribute('href') ?? '/umbraco/').replace(/\/$/, '')}/crombolo/api/approvals`

async function call(path, init = {}) {
  const response = await fetch(`${apiBase()}/${path}`, {
    credentials: 'include',
    ...init,
    headers: { accept: 'application/json', 'content-type': 'application/json', ...init.headers },
  })
  const body = await response.json().catch(() => ({}))
  if (response.status === 403 && !body.message)
    return { ok: false, message: 'You are not allowed to do that.' }
  return { ok: response.ok, status: response.status, ...body }
}

const post = (path, body = {}) => call(path, { method: 'POST', body: JSON.stringify(body) })

export const pageApproval = (key) => call(`page/${encodeURIComponent(key)}`)
export const sendForApproval = (key, action, comment) =>
  post(`page/${encodeURIComponent(key)}/send`, { action, comment })
export const decide = (requestKey, verb, body) =>
  post(`request/${encodeURIComponent(requestKey)}/${verb}`, body)
export const waitingForMe = () => call('waiting')
export const inFlight = () => call('in-flight')
export const finished = (skip = 0, take = 25) => call(`history?skip=${skip}&take=${take}`)
export const listWorkflows = () => call('workflows')
export const previewWorkflow = (alias, workflow) =>
  post(`workflows/${encodeURIComponent(alias)}/preview`, { workflow })
export const saveWorkflow = (alias, workflow) =>
  call(`workflows/${encodeURIComponent(alias)}`, {
    method: 'PUT',
    body: JSON.stringify({ workflow }),
  })
export const deleteWorkflow = (alias) =>
  call(`workflows/${encodeURIComponent(alias)}`, { method: 'DELETE' })
