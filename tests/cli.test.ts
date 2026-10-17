/**
 * The CLI as a script drives it (story 150): arguments parsed per command, help
 * that runs nothing, exit codes from one table, a JSON envelope on failure, and
 * `crombolo schema` valid against clispec v0.3.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020'
import { ERROR_KINDS, OUTCOMES } from '../packages/cli/src/errors.ts'
import { buildManifest } from '../packages/cli/src/manifest.ts'
import { ROOT, sharedVersion } from '../scripts/packages.ts'

const BIN = join(ROOT, 'packages/cli/bin/crombolo.ts')
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crombolo-cli-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function run(args: string[], stdin?: string) {
  const proc = Bun.spawnSync(['bun', BIN, ...args], {
    cwd: dir,
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    env: { ...process.env, NO_COLOR: '1' },
  })
  const err = proc.stderr.toString()
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err,
    /** The JSON envelope: the last line of stderr. */
    envelope: () =>
      (JSON.parse(err.trim().split('\n').at(-1) ?? '{}') as { error?: Record<string, unknown> })
        .error ?? {},
  }
}

describe('arguments', () => {
  test('--help prints that command’s help and runs nothing', () => {
    const result = run(['upgrade', '--help'])
    expect(result.code).toBe(0)
    expect(result.out).toContain('--plan')
    expect(result.out).not.toContain('maintenance')
  })

  test('the root help lists the commands, schema among them', () => {
    const result = run(['--help'])
    expect(result.code).toBe(0)
    expect(result.out).toContain('schema')
    expect(result.out).toContain('types')
  })

  test('--version prints the version', () => {
    expect(run(['--version']).out).toContain(sharedVersion())
  })

  test('an unknown flag is a usage error, exit 2, before anything runs', () => {
    const result = run(['import', 'site.tgz', '--dyr-run'])
    expect(result.code).toBe(2)
    expect(result.err).toContain('--dyr-run')
  })

  test('an unknown command exits 2', () => {
    expect(run(['nonsense']).code).toBe(2)
  })

  test("a flag's value is never an argument", () => {
    // `prod` belongs to --env; the URL is still the second argument, and the
    // failure is about reaching it.
    const result = run([
      'remote',
      'add',
      '--env',
      'prod',
      'origin',
      'http://127.0.0.1:9',
      '-o',
      'json',
    ])
    expect(result.code).toBe(ERROR_KINDS.unavailable.exitCode)
    expect(result.envelope()).toMatchObject({ kind: 'unavailable' })
    expect(String(result.envelope().message)).toContain('127.0.0.1:9')
  })
})

describe('failures and outcomes', () => {
  test('in JSON mode a failure ends stderr with one envelope line, and stdout is empty', () => {
    const result = run(['content', 'import', '-o', 'json'])
    expect(result.code).toBe(2)
    expect(result.out).toBe('')
    expect(result.envelope()).toMatchObject({ kind: 'usage' })
  })

  test('in text mode a failure says what to do, and a pipe still ends with the envelope', () => {
    const result = run(['content', 'import'])
    expect(result.code).toBe(2)
    expect(result.err).toContain('bundle')
    expect(result.err).toContain('--help')
    expect(result.envelope()).toMatchObject({ kind: 'usage', exit_code: 2 })
  })

  test('an unknown command fails the same way, before any command runs', () => {
    const result = run(['__nonexistent_command__'])
    expect(result.code).toBe(2)
    expect(result.envelope()).toMatchObject({ kind: 'usage' })
  })

  test('a different URL for a remote already named is a conflict, decided before any network', () => {
    writeFileSync(join(dir, 'remotes.toml'), '[remotes.origin]\nurl = "https://one.example"\n')
    const result = run(['remote', 'add', 'origin', 'https://two.example', '--json'])
    expect(result.code).toBe(ERROR_KINDS.conflict.exitCode)
    expect(result.envelope()).toMatchObject({ kind: 'conflict' })
    expect(readFileSync(join(dir, 'remotes.toml'), 'utf8')).toContain('one.example')
  })

  test('removing a remote that is not there changes nothing, and says so', () => {
    const result = run(['remote', 'remove', 'nowhere', '-o', 'json'])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.out)).toEqual({ name: 'nowhere', changed: false })
  })

  test('a list is an items envelope', () => {
    const result = run(['remote', 'list', '-o', 'json'])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.out)).toEqual({ items: [] })
  })

  test('a renamed command still runs under its old name, and says it is deprecated', () => {
    const result = run(['schema', 'check'])
    expect(result.err).toContain('types check')
    expect(result.code).toBe(ERROR_KINDS.not_found.exitCode)
  })

  test('a check that finds problems exits with its outcome, its findings on stdout and no envelope', () => {
    // An empty folder has no database yet: status reports it as a problem.
    const result = run(['status', '-o', 'json'])
    const report = JSON.parse(result.out) as { problems: string[] }
    if (report.problems.length > 0) {
      expect(result.code).toBe(OUTCOMES.problems_found.code)
      expect(result.err).not.toContain('"kind"')
    } else expect(result.code).toBe(0)
  }, 30_000)

  test('a confirmation with no terminal refuses at once, naming the flag that answers it', () => {
    const result = run(['bundle', 'purge', 'demo', '-o', 'json'], '')
    expect(result.code).toBe(ERROR_KINDS.confirmation_required.exitCode)
    expect(result.envelope()).toMatchObject({ kind: 'confirmation_required' })
    expect(String(result.envelope().hint)).toContain('--yes')
  })

  test('--dry-run on a purge says what it would drop and drops nothing', () => {
    const result = run(['bundle', 'purge', 'demo', '--dry-run', '-o', 'json'])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.out)).toMatchObject({ id: 'demo', dropped: [], changed: false })
  })
})

describe('crombolo schema', () => {
  const schema = () => {
    const result = run(['schema'])
    expect(result.code).toBe(0)
    return JSON.parse(result.out) as {
      commands: Array<{ name: string; args?: Array<{ name: string }>; [key: string]: unknown }>
      errors: Array<{ kind: string; exit_code: number }>
      outcomes: Array<{ name: string; code: number }>
      global_args: Array<{ name: string }>
    }
  }

  test('validates against clispec v0.3, in a folder with no site', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    const validate = ajv.compile(
      JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/clispec-v0.3.json'), 'utf8')),
    )
    const document = schema()
    expect(validate(document), JSON.stringify(validate.errors, null, 2)).toBe(true)
  })

  test('keeps the rules JSON Schema cannot: unique codes and names, and every reference declared', () => {
    const document = schema()
    const outcomeCodes = document.outcomes.map((o) => o.code)
    const errorCodes = document.errors.map((e) => e.exit_code)
    expect(outcomeCodes.filter((code) => errorCodes.includes(code))).toEqual([])
    expect(new Set(outcomeCodes).size).toBe(outcomeCodes.length)
    const names = document.commands.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
    const kinds = new Set(document.errors.map((e) => e.kind))
    const outcomes = new Set(document.outcomes.map((o) => o.name))
    const globals = new Set(document.global_args.map((a) => a.name))
    for (const command of document.commands) {
      for (const kind of (command.errors as string[]) ?? [])
        expect(kinds.has(kind), `${command.name}: ${kind}`).toBe(true)
      for (const name of (command.outcomes as string[]) ?? []) expect(outcomes.has(name)).toBe(true)
      const declared = new Set([...(command.args ?? []).map((a) => a.name), ...globals])
      for (const key of ['confirmation_bypass_arg', 'fields_arg'])
        if (command[key])
          expect(declared.has(command[key] as string), `${command.name}: ${key}`).toBe(true)
      const pagination = command.pagination as Record<string, string> | undefined
      for (const arg of Object.entries(pagination ?? {}).filter(([k]) => k.endsWith('_arg')))
        expect(declared.has(arg[1]), `${command.name}: ${arg[0]}`).toBe(true)
      if (command.confirmation_bypass_arg)
        expect(command.errors as string[]).toContain('confirmation_required')
    }
  })

  test('declares an explicit JSON flag globally, and text as the piped default', () => {
    const document = schema() as unknown as {
      output: { piped: string }
      global_args: Array<{ name: string; enum?: string[] }>
    }
    expect(document.output.piped).toBe('text')
    expect(document.global_args.find((a) => a.name === '--output')?.enum).toContain('json')
  })

  test('narrows to a command path, and refuses one that is not there', () => {
    const narrowed = JSON.parse(run(['schema', 'content', 'import']).out) as {
      commands: { name: string }[]
    }
    expect(narrowed.commands.map((c) => c.name)).toEqual(['content import'])
    expect(run(['schema', 'nothing', 'here']).code).toBe(ERROR_KINDS.not_found.exitCode)
  })

  test('every command has a description and declares its effects', () => {
    for (const command of schema().commands) {
      expect(String(command.description).length, command.name).toBeGreaterThan(0)
      expect(['read_only', 'idempotent', 'non_idempotent']).toContain(command.effects as string)
    }
  })
})

describe('the oclif manifest', () => {
  test('caches every command with its clispec spec, at the package version', async () => {
    const manifest = await buildManifest()
    expect(manifest.version).toBe(sharedVersion())
    const ids = Object.keys(manifest.commands)
    for (const id of ['start', 'types:check', 'content:import', 'push', 'schema'])
      expect(ids).toContain(id)
    for (const [id, command] of Object.entries(manifest.commands))
      expect((command as { spec?: { effects?: string } }).spec?.effects, id).toBeDefined()
  })
})

describe('components new', () => {
  test("writes an e-mail template when a form's Send email names the alias", () => {
    mkdirSync(join(dir, 'schema', 'forms'), { recursive: true })
    writeFileSync(join(dir, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    writeFileSync(
      join(dir, 'schema', 'forms', 'contact-us.toml'),
      `[form]
alias = "contactUs"
name = "Contact us"

[[page]]

  [[page.group]]

    [[page.group.field]]
    alias = "email"
    type = "email"
    caption = "Email"

[[workflow]]
type = "sendEmail"
name = "Tell the team"

  [workflow.settings]
  to = "team@example.com"
  subject = "Hello"
  template = "emails/receipt"
`,
    )
    const email = run(['components', 'new', 'emails/receipt', '-o', 'json'])
    expect(email.code).toBe(0)
    const result = JSON.parse(email.out) as { created: string }
    expect(result).toMatchObject({ template: false, email: true })
    // Wherever the environment puts components/: the suite's own container moves it.
    expect(result.created).toEndWith('emails/receipt.tsx')
    const written = readFileSync(resolve(dir, result.created), 'utf8')
    expect(written).toContain("import type { EmailProps } from '@crombolo/crombolo'")
    expect(written).toContain('export default function Receipt(')

    const plain = run(['components', 'new', 'shared/header', '-o', 'json'])
    expect(JSON.parse(plain.out)).toMatchObject({ template: false, email: false })
  })
})
