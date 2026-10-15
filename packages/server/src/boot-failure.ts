/**
 * Why a server could not start, said so a person can fix it, and how long to
 * wait before trying again. Pure: `crombolo start` serves the page and does the
 * waiting. Nothing here may carry a secret — the database is named by host and
 * database only, never by its URL.
 */
import { MigrationStepError } from '@crombolo/data'
import { DatabaseNotReadyError, UpgradePendingError } from './database.ts'
import { SchemaBootError } from './schema.ts'

export interface BootFailure {
  title: string
  detail: string
  /** The setting or command that fixes it. */
  remedy: string
}

const sqlState = (error: { code?: unknown; errno?: unknown }) =>
  typeof error.errno === 'string' ? error.errno : typeof error.code === 'string' ? error.code : ''

export function describeBootFailure(error: unknown, database: string): BootFailure {
  if (error instanceof UpgradePendingError)
    return {
      title: 'An upgrade is waiting',
      detail: `The database at ${database} needs upgrading before this version can use it.`,
      remedy: 'Run `crombolo upgrade check`, then `crombolo upgrade`. This page retries by itself.',
    }
  if (error instanceof DatabaseNotReadyError)
    return {
      title: 'The database has not been prepared yet',
      detail: `The database at ${database} is behind this version, and this server only reads.`,
      remedy: 'Start the server that edits the site first, or run `crombolo upgrade`.',
    }
  if (error instanceof MigrationStepError)
    return {
      title: 'An upgrade step failed',
      detail: error.message,
      remedy: 'Fix the cause named above; the next attempt carries on from that step.',
    }
  if (error instanceof SchemaBootError)
    return {
      title: "The site's content types could not be loaded",
      detail: error.message,
      remedy: 'Correct the files named above in `schema/`, then deploy again.',
    }
  const e = (error ?? {}) as { code?: unknown; errno?: unknown; message?: unknown }
  const state = sqlState(e)
  if (state === 'ERR_POSTGRES_CONNECTION_REFUSED' || state === 'ECONNREFUSED')
    return {
      title: "Can't reach the database",
      detail: `Nothing answered at ${database}.`,
      remedy:
        'Check the host and port in `CROMBOLO_POSTGRES_URL`, and that the database server is running and reachable from here.',
    }
  if (state === '28P01' || state === '28000')
    return {
      title: 'The database refused the sign-in',
      detail: `${database} did not accept the user name and password it was given.`,
      remedy: 'Check the user name and password in `CROMBOLO_POSTGRES_URL`.',
    }
  if (state === '3D000')
    return {
      title: 'The database does not exist',
      detail: `The server at ${database} has no database by that name.`,
      remedy: 'Create the database, or correct its name in `CROMBOLO_POSTGRES_URL`.',
    }
  if (state === 'SQLITE_CANTOPEN')
    return {
      title: "Can't open the database file",
      detail: `${database} could not be opened or created.`,
      remedy:
        'Check `CROMBOLO_SQLITE_FILE`, and that its folder exists and this server may write to it.',
    }
  if (/no connection string/i.test(String(e.message ?? '')))
    return {
      title: 'No database is configured',
      detail: 'Postgres was selected, but no connection string was given.',
      remedy: 'Set `CROMBOLO_POSTGRES_URL`, or unset `CROMBOLO_DB` to use SQLite.',
    }
  return {
    title: 'The site could not start',
    detail: 'Something unexpected stopped it. The server log has the details.',
    remedy: 'Read the latest error in the server log.',
  }
}

/** Waits between attempts: doubling from `baseMs`, never longer than `capMs`. */
export function bootRetryDelays(attempts: number, baseMs = 2_000, capMs = 60_000): number[] {
  return Array.from({ length: Math.max(0, attempts - 1) }, (_, i) =>
    Math.min(capMs, baseMs * 2 ** i),
  )
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )

const withCode = (value: string) =>
  escapeHtml(value).replace(/`([^`]+)`/g, (_, code: string) => `<code>${code}</code>`)

/** The page a starting server serves while it cannot start. */
export function bootFailurePage(
  failure: BootFailure | undefined,
  progress: { attempt: number; attempts: number; retryInSeconds: number | undefined },
): string {
  const title = failure?.title ?? 'The site is starting'
  const next =
    progress.retryInSeconds === undefined
      ? 'It will not try again; the server is stopping.'
      : `Trying again in ${progress.retryInSeconds} seconds (attempt ${progress.attempt} of ${progress.attempts}).`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="10">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #f6f5f3; color: #1b1b1b; }
  main { max-width: 34rem; padding: 2.5rem 1rem; }
  h1 { font-size: 1.6rem; margin: 0 0 .75rem; }
  p { margin: 0 0 1rem; white-space: pre-line; }
  code { font-size: .9em; background: #e9e7e2; padding: .1em .35em; border-radius: 3px; }
  .fine { font-size: .85rem; color: #6b6b63; }
  @media (prefers-color-scheme: dark) {
    body { background: #16171a; color: #e8e6e3; }
    code { background: #26282c; }
    .fine { color: #9a9a93; }
  }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  ${failure ? `<p>${withCode(failure.detail)}</p>\n  <p><strong>To fix it:</strong> ${withCode(failure.remedy)}</p>` : '<p>This takes a few seconds.</p>'}
  <p class="fine">${escapeHtml(next)}</p>
</main>
</body>
</html>
`
}
