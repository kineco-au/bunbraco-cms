/**
 * The CLI described as a clispec v0.3 document (https://clispec.dev), built
 * from the loaded commands: their args and flags as oclif reads them, and the
 * `spec` each declares. Nothing here touches a site, a network or a sign-in.
 */
import type { Command } from '@oclif/core'
import type { CommandSpec, OutputField } from './base.ts'
import { ERROR_KINDS, OUTCOMES } from './errors.ts'

export const CLISPEC_VERSION = '0.3'

/** The flags every command takes, published once as `global_args`. */
const GLOBAL_FLAGS = new Set(['output', 'json'])

type Arg = Record<string, unknown>

function field(f: Omit<OutputField, 'name'> & { name?: string }): Record<string, unknown> {
  return {
    ...(f.name !== undefined ? { name: f.name } : {}),
    type: f.type,
    ...(f.nullable ? { nullable: true } : {}),
    ...(f.enum ? { enum: f.enum } : {}),
    ...(f.description ? { description: f.description } : {}),
    ...(f.fields ? { fields: f.fields.map(field) } : {}),
    ...(f.type === 'array' ? { items: field(f.items ?? { type: 'string' }) } : {}),
  }
}

function flagArg(name: string, flag: Command.Flag.Cached): Arg {
  const valued = flag.type === 'option'
  const options = valued && 'options' in flag ? flag.options : undefined
  const fallback = flag.default
  const type = !valued
    ? 'boolean'
    : typeof fallback === 'number'
      ? 'integer'
      : flag.multiple
        ? 'string[]'
        : 'string'
  return {
    name: `--${name}`,
    type,
    ...(flag.char ? { short: `-${flag.char}` } : {}),
    ...(flag.required ? { required: true } : {}),
    ...(fallback !== undefined &&
    typeof fallback !== 'function' &&
    !(Array.isArray(fallback) && fallback.length === 0)
      ? { default: fallback }
      : {}),
    ...(options ? { enum: [...options] } : {}),
    ...(flag.summary || flag.description ? { description: flag.summary ?? flag.description } : {}),
  }
}

function positional(name: string, arg: Command.Arg.Cached): Arg {
  return {
    name,
    type: 'string',
    ...(arg.required ? { required: true } : {}),
    ...(arg.options ? { enum: [...arg.options] } : {}),
    ...(arg.description ? { description: arg.description } : {}),
  }
}

function describeCommand(command: Command.Cached): Record<string, unknown> {
  const spec = command.spec as CommandSpec | undefined
  if (!spec) throw new Error(`${command.id} declares no spec`)
  const kind = spec.outputKind ?? 'data'
  const args = [
    ...Object.entries(command.args)
      .filter(([, arg]) => !arg.hidden)
      .map(([name, arg]) => positional(name, arg)),
    ...Object.entries(command.flags)
      .filter(([name, flag]) => !GLOBAL_FLAGS.has(name) && !flag.hidden)
      .map(([name, flag]) => flagArg(name, flag)),
  ]
  const errors = [
    ...new Set([
      'usage',
      'internal',
      ...(spec.errors ?? []),
      ...(spec.confirmationBypassArg ? ['confirmation_required'] : []),
    ]),
  ]
  return {
    name: command.id.replaceAll(':', ' '),
    description: command.summary ?? command.description ?? command.id,
    effects: spec.effects,
    ...(kind !== 'data' ? { output_kind: kind } : {}),
    ...(kind === 'data' ? { cardinality: spec.cardinality ?? 'single' } : {}),
    ...(kind === 'data' && spec.outputFields
      ? { output_fields: spec.outputFields.map(field) }
      : {}),
    ...(kind === 'data' && spec.stdoutSchema ? { stdout_schema: spec.stdoutSchema } : {}),
    ...(kind === 'data' && !spec.outputFields && !spec.stdoutSchema ? { stdout_schema: {} } : {}),
    ...(spec.pagination
      ? {
          pagination: {
            style: spec.pagination.style,
            offset_arg: spec.pagination.offsetArg,
            limit_arg: spec.pagination.limitArg,
          },
        }
      : {}),
    ...(spec.fieldsArg ? { fields_arg: spec.fieldsArg } : {}),
    ...(spec.confirmationBypassArg ? { confirmation_bypass_arg: spec.confirmationBypassArg } : {}),
    ...(spec.requiresTty ? { requires_tty: true } : {}),
    ...(spec.stability ? { stability: spec.stability } : {}),
    ...(args.length > 0 ? { args } : {}),
    errors,
    ...(spec.outcomes?.length ? { outcomes: [...spec.outcomes] } : {}),
  }
}

/** What the document is built from: a loaded oclif config, or the manifest's data. */
export interface CommandSource {
  bin: string
  version: string
  commands: readonly Command.Cached[]
}

/** The whole CLI, or the commands under `path` (`content`, `content import`). */
export function clispecDocument(config: CommandSource, path: readonly string[] = []) {
  const prefix = path.join(' ')
  const commands = config.commands
    .filter((command) => !command.hidden)
    .map(describeCommand)
    .filter((command) => {
      const name = command.name as string
      return prefix === '' || name === prefix || name.startsWith(`${prefix} `)
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
  return {
    clispec: CLISPEC_VERSION,
    name: config.bin,
    version: config.version,
    description: 'The crombolo command line: a site, its schema, content, remotes and upgrades.',
    output: { piped: 'text', tty: 'text' },
    global_args: [
      {
        name: '--output',
        short: '-o',
        type: 'string',
        enum: ['text', 'json'],
        default: 'text',
        description: 'text for people; json for scripts, on stdout',
      },
      { name: '--json', type: 'boolean', description: 'the same as -o json' },
    ],
    commands,
    errors: Object.entries(ERROR_KINDS).map(([kind, e]) => ({
      kind,
      exit_code: e.exitCode,
      ...('retryable' in e ? { retryable: e.retryable } : {}),
      description: e.description,
    })),
    outcomes: Object.entries(OUTCOMES).map(([name, o]) => ({
      code: o.code,
      name,
      description: o.description,
    })),
  }
}
