/**
 * What a site cannot do because it has no e-mail, said once at boot.
 *
 * The alternative is an operator finding out when an invitation never arrives,
 * which is the worst moment and the hardest to diagnose: nothing errored.
 */
import type { EmailAvailability } from './email.ts'

export interface EmailNoticeLog {
  info(message: string, properties?: Record<string, unknown>): void
  warning(message: string, properties?: Record<string, unknown>): void
}

export function noticeAboutEmail(
  availability: EmailAvailability,
  log: EmailNoticeLog,
  /** Whether anything would actually be blocked; a developer is told, not warned. */
  options: { development?: boolean } = {},
): void {
  if (availability.available) {
    log.info('E-mail is sent through {provider}.', { provider: availability.description })
    return
  }
  // The console stand-in is development's expected state, and it prints every
  // message it is given. Announcing it on each boot is noise in the one place
  // the noise is loudest.
  if (availability.provider === 'log') return
  const message = 'No e-mail provider is configured, so {affected} unavailable. {hint}'
  const properties = {
    affected: `${availability.affects.join(', ')} ${availability.affects.length === 1 ? 'is' : 'are'}`,
    hint: availability.reason,
  }
  // In development this is the expected state and not worth a warning.
  if (options.development) log.info(message, properties)
  else log.warning(message, properties)
}
