/**
 * What every crombolo command shares (story 150): the output flag, the failure
 * envelope and exit codes, the audit entry, and the description `crombolo
 * schema` publishes. A command's `run()` returns its result; in JSON mode that
 * result is the output, and in text mode the command says it as it goes.
 */
import { Command, Errors, Flags } from '@oclif/core'
import { CliError, type ErrorKind, exitCodeOf, OUTCOMES, type OutcomeName } from './errors.ts'
import type * as ops from './operations/commands.ts'
import type { Io } from './support/site.ts'

/** A field of one output record, in clispec's closed set of types. */
export interface OutputField {
  name: string
  type: 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array'
  nullable?: boolean
  description?: string
  enum?: readonly unknown[]
  fields?: readonly OutputField[]
  items?: Omit<OutputField, 'name'>
}

/** The clispec v0.3 properties of a command, beyond its args and flags. */
export interface CommandSpec {
  effects: 'read_only' | 'idempotent' | 'non_idempotent'
  outputKind?: 'data' | 'stream' | 'opaque'
  cardinality?: 'single' | 'bounded' | 'unbounded'
  outputFields?: readonly OutputField[]
  /** For a shape that depends on the input: `{}` says exactly that. */
  stdoutSchema?: Record<string, unknown>
  errors?: readonly ErrorKind[]
  outcomes?: readonly OutcomeName[]
  confirmationBypassArg?: string
  requiresTty?: boolean
  pagination?: { style: 'offset'; offsetArg: string; limitArg: string }
  fieldsArg?: string
  stability?: 'stable' | 'beta' | 'experimental' | 'deprecated'
}

export interface AuditSpec {
  category: ops.CommandAudit['category']
  action: string
  entityType?: string
}

/** `-o json`, `-ojson`, `-o=json`, `--output json`, `--output=json` or `--json`, before any `--`. */
export function wantsJson(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--') return false
    if (arg === '--json' || arg === '-ojson' || arg === '-o=json' || arg === '--output=json')
      return true
    if ((arg === '-o' || arg === '--output') && argv[i + 1] === 'json') return true
  }
  return false
}

export abstract class BaseCommand extends Command implements Io {
  static override baseFlags = {
    output: Flags.option({
      char: 'o',
      options: ['text', 'json'] as const,
      default: 'text' as const,
      summary: 'text for people; json for scripts, on stdout',
      helpGroup: 'GLOBAL',
    })(),
    json: Flags.boolean({ hidden: true, summary: 'the same as -o json' }),
  }

  static spec: CommandSpec
  static audit?: AuditSpec

  /** Set by a command whose check found what it reports: the exit code, with no envelope. */
  protected outcome?: OutcomeName
  /** The entity an audit entry names, when the command acted on one. */
  protected auditKey?: string
  /** A dry run or a plan changes nothing, so it writes no audit entry. */
  protected changedNothing = false

  override jsonEnabled(): boolean {
    return wantsJson(this.argv)
  }

  protected override logJson(json: unknown): void {
    process.stdout.write(`${JSON.stringify(json, null, 2)}\n`)
  }

  say = (line = ''): void => {
    this.log(line)
  }

  progress = (line: string): void => {
    process.stderr.write(`${line}\n`)
  }

  warning = (line: string): void => {
    process.stderr.write(`${line}\n`)
  }

  protected override async _run<T>(): Promise<T> {
    const result = await super._run<T>()
    if (this.outcome) this.exit(OUTCOMES[this.outcome].code)
    return result
  }

  protected override async catch(error: Error): Promise<never> {
    if (error instanceof Errors.ExitError) throw error
    // Loaded when something fails, so a command — or a plugin's — that succeeds
    // never pays for the site packages it knows how to name.
    const { classify, reportFailure } = await import('./classify.ts')
    const failure = classify(error)
    reportFailure(failure, this.jsonEnabled())
    throw new Errors.ExitError(exitCodeOf(failure.kind))
  }

  protected override async finally(error: Error | undefined): Promise<void> {
    const audit = (this.constructor as typeof BaseCommand).audit
    if (error || !audit || this.changedNothing) return
    const [{ recordCommand }, { siteConfig }] = await Promise.all([
      import('./operations/commands.ts'),
      import('./support/site.ts'),
    ])
    await recordCommand(await siteConfig(), {
      ...audit,
      command: `crombolo ${(this.id ?? '').replaceAll(':', ' ')}`,
      entityKey: this.auditKey,
    })
  }

  /** A failure, as the command's own sentence. */
  protected fail(kind: ErrorKind, message: string, hint?: string, details?: unknown): never {
    throw new CliError(kind, message, { hint, details })
  }
}
