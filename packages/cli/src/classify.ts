/**
 * Any error a command lets go of, as a `CliError`: the kind it is, so the exit
 * code and the envelope follow from one table.
 */
import { MigrationStepError, UpgradeStateError } from '@crombolo/data'
import { CommandError, PassphraseError, setting } from '@crombolo/server'
import { CliError, ERROR_KINDS, type ErrorKind } from './errors.ts'
import { RemoteError, TimedOut } from './remote/client.ts'

const REMOTE_CODES: Record<string, ErrorKind> = {
  'sign-in-required': 'auth',
  unreachable: 'unavailable',
  'not-a-remote': 'not_found',
}

function remoteKind(error: RemoteError): ErrorKind {
  const { code, status } = error.problem
  const known = REMOTE_CODES[code]
  if (known) return known
  if (status === 401) return 'auth'
  if (status === 403) return 'refused'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 429 || status >= 500) return 'unavailable'
  return 'refused'
}

const SYSTEM_CODES: Record<string, ErrorKind> = {
  ENOENT: 'io',
  EACCES: 'io',
  EPERM: 'io',
  ENOSPC: 'io',
  EISDIR: 'io',
  ENOTDIR: 'io',
  ECONNREFUSED: 'unavailable',
  ECONNRESET: 'unavailable',
  ETIMEDOUT: 'unavailable',
  ENOTFOUND: 'unavailable',
  EAI_AGAIN: 'unavailable',
  SQLITE_BUSY: 'conflict',
}

/**
 * The parser's sentence without its advice: the note about a repeatable flag
 * swallowing arguments does not apply, since every repeatable flag here takes
 * one value each time, and the pointer to --help is the hint.
 */
function parserMessage(message: string): string {
  return (
    message
      .split(/\n\s*\nNote: /)[0]
      ?.split('\n')
      .filter((line) => !/^See more help with/.test(line))
      .join('\n')
      .trim() ?? message
  )
}

export function classify(error: unknown): CliError {
  if (error instanceof CliError) return error
  if (error instanceof TimedOut)
    return new CliError('timeout', error.message, {
      hint: `The job carries on at the remote: \`crombolo remote job ${error.job.id}\` watches it again.`,
    })
  if (error instanceof RemoteError)
    return new CliError(remoteKind(error), error.message, {
      details: error.problem.items,
    })
  if (error instanceof PassphraseError)
    return new CliError('auth', error.message, { details: error.problems })
  if (error instanceof CommandError)
    return new CliError('refused', error.message, {
      details: error.problems.length > 0 ? error.problems : undefined,
    })
  if (error instanceof UpgradeStateError) return new CliError('refused', error.message)
  if (error instanceof MigrationStepError) return new CliError('internal', error.message)
  // The parser's own errors: an unknown flag, a missing argument, a bad value;
  // and, before any command runs, an unknown command.
  if (error instanceof Error && ('parse' in error || /^command .* not found$/.test(error.message)))
    return new CliError('usage', parserMessage(error.message), {
      hint: 'Pass --help to see what it takes.',
    })
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && SYSTEM_CODES[code])
    return new CliError(SYSTEM_CODES[code], (error as Error).message)
  return new CliError('internal', error instanceof Error ? error.message : String(error), {
    details: setting('CROMBOLO_DEBUG') && error instanceof Error ? error.stack : undefined,
  })
}

/**
 * Says a failure. In JSON mode stderr's last line is the envelope; in text mode
 * a person reads sentences, and when stderr is not a terminal the envelope
 * follows them as the last line, so a script reading a pipe can branch on it
 * without asking for JSON.
 */
export function reportFailure(failure: CliError, json: boolean): void {
  if (!json) {
    if (Array.isArray(failure.details))
      for (const item of failure.details) process.stderr.write(`  ${String(item)}\n`)
    else if (typeof failure.details === 'string') process.stderr.write(`${failure.details}\n`)
    process.stderr.write(`${failure.message}\n`)
    if (failure.hint) process.stderr.write(`  ${failure.hint}\n`)
    if (process.stderr.isTTY) return
  }
  const kind = ERROR_KINDS[failure.kind]
  process.stderr.write(
    `${JSON.stringify({
      error: {
        kind: failure.kind,
        message: failure.message,
        ...(failure.hint ? { hint: failure.hint } : {}),
        ...(failure.details !== undefined ? { details: failure.details } : {}),
        exit_code: kind.exitCode,
        ...('retryable' in kind ? { retryable: kind.retryable } : {}),
      },
    })}\n`,
  )
}
