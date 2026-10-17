/**
 * How a command fails, and what it exits with (story 150). Every failure is a
 * kind with one exit code, so a script can branch on `$?` and a machine can read
 * the envelope; an outcome is a finding the command was asked to look for, which
 * exits non-zero with no envelope.
 */

/** Each kind's exit code. The table in `docs/operations.md` § Exit codes is this one. */
export const ERROR_KINDS = {
  internal: { exitCode: 1, description: 'Something unexpected went wrong.' },
  usage: {
    exitCode: 2,
    description: 'The arguments are wrong: an unknown command or flag, or one missing.',
  },
  timeout: {
    exitCode: 3,
    description: 'Gave up waiting. A remote job carries on at the remote.',
    retryable: true,
  },
  auth: {
    exitCode: 4,
    description: 'Not signed in, the sign-in has lapsed, or a passphrase is missing or wrong.',
  },
  not_found: {
    exitCode: 5,
    description: 'No such remote, environment, page, run, bundle, file or account.',
  },
  conflict: {
    exitCode: 6,
    description: 'Someone else is changing it, or it exists with a different value.',
    retryable: true,
  },
  confirmation_required: {
    exitCode: 7,
    description: 'It would have asked first, and there is no terminal to ask on.',
  },
  refused: {
    exitCode: 8,
    description:
      'The site or the remote said no: findings outstanding, a permission, a protected environment.',
  },
  unavailable: {
    exitCode: 9,
    description: 'The database or the remote could not be reached.',
    retryable: true,
  },
  io: { exitCode: 10, description: 'A file could not be read or written.' },
  interrupted: { exitCode: 130, description: 'Stopped by a signal.' },
} as const satisfies Record<string, { exitCode: number; description: string; retryable?: boolean }>

export type ErrorKind = keyof typeof ERROR_KINDS

/** Findings a command was asked to look for. Their details are the command's normal output. */
export const OUTCOMES = {
  problems_found: {
    code: 20,
    description: 'The check found problems: `status`, `types check`, `components check`.',
  },
  blocked: {
    code: 21,
    description:
      'Something must be resolved by a person first: `content check`, `upgrade check`, `import umbraco report`.',
  },
} as const

export type OutcomeName = keyof typeof OUTCOMES

/** A failure with a kind, a sentence, and what to do about it. */
export class CliError extends Error {
  readonly hint?: string
  readonly details?: unknown
  constructor(
    readonly kind: ErrorKind,
    message: string,
    options: { hint?: string; details?: unknown } = {},
  ) {
    super(message)
    this.hint = options.hint
    this.details = options.details
  }
}

/** The command finished, and found what it reports: exit with the outcome's code, no envelope. */
export class Outcome extends Error {
  constructor(readonly outcome: OutcomeName) {
    super(outcome)
  }
}

export const exitCodeOf = (kind: ErrorKind): number => ERROR_KINDS[kind].exitCode
