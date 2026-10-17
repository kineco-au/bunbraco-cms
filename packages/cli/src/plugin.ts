/**
 * `@crombolo/cli/plugin`: what a plugin's commands are built from (story 158),
 * so that they behave like the CLI's own — the global flags, the JSON envelope,
 * the exit codes, an entry in `crombolo schema` — and sign in where `crombolo
 * login` does. Covered by semver like the main entry. It loads none of the
 * CLI's commands, and none of the site packages until a command fails.
 *
 *   import { Args, BaseCommand, Flags } from '@crombolo/cli/plugin'
 *
 *   export default class CloudStatus extends BaseCommand {
 *     static override summary = 'what the platform says about this site'
 *     static override spec = { effects: 'read_only', cardinality: 'single', outputFields: [...] } as const
 *     async run() { … return result }
 *   }
 */
export { Args, Flags } from '@oclif/core'
export type { AuditSpec, CommandSpec, OutputField } from './base.ts'
export { BaseCommand } from './base.ts'
export {
  CliError,
  ERROR_KINDS,
  type ErrorKind,
  exitCodeOf,
  OUTCOMES,
  type OutcomeName,
} from './errors.ts'
export {
  type Discovery,
  discover,
  type Job,
  problemOf,
  RemoteClient,
  RemoteError,
  signIn,
  TimedOut,
} from './remote/client.ts'
export { keychain, openInBrowser } from './support/remote.ts'
export type { Io } from './support/site.ts'
