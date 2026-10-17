/**
 * A hosting plugin for the CLI (story 158): `@crombolo/cloud`, when it is
 * installed, adds `crombolo cloud …`, built from `@crombolo/cli/plugin` and
 * behaving like the CLI's own commands; when it is not, nothing changes. The
 * plugin here is a stand-in under tests/fixtures, never shipped.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryKeychain, readSignIn } from '@crombolo/server'
import Ajv2020 from 'ajv/dist/2020'
import { ERROR_KINDS } from '../packages/cli/src/errors.ts'
import { loadCli } from '../packages/cli/src/load.ts'
import { manifestOf } from '../packages/cli/src/manifest.ts'
import * as plugin from '../packages/cli/src/plugin.ts'
import { cliReferenceHtml } from '../packages/cli/src/reference.ts'
import * as client from '../packages/cli/src/remote/client.ts'
import { keychain } from '../packages/cli/src/support/remote.ts'
import { ROOT } from '../scripts/packages.ts'
import { type Harness, ORIGIN, signedInServer, V1 } from './support/harness.ts'

const BIN = join(ROOT, 'packages/cli/bin/crombolo.ts')
const FIXTURE = join(ROOT, 'tests/fixtures/cloud-plugin')

let withPlugin: string
let without: string
beforeEach(() => {
  withPlugin = mkdtempSync(join(tmpdir(), 'crombolo-plugin-'))
  mkdirSync(join(withPlugin, 'node_modules', '@crombolo'), { recursive: true })
  symlinkSync(FIXTURE, join(withPlugin, 'node_modules', '@crombolo', 'cloud'))
  without = mkdtempSync(join(tmpdir(), 'crombolo-plugin-'))
})
afterEach(() => {
  rmSync(withPlugin, { recursive: true, force: true })
  rmSync(without, { recursive: true, force: true })
})

function run(cwd: string, args: string[]) {
  const proc = Bun.spawnSync(['bun', BIN, ...args], { cwd, stdin: 'ignore' })
  const err = proc.stderr.toString()
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err,
    envelope: () =>
      (JSON.parse(err.trim().split('\n').at(-1) ?? '{}') as { error?: Record<string, unknown> })
        .error ?? {},
  }
}

describe('installed', () => {
  test('its topic is in the help, and its commands under it', () => {
    expect(run(withPlugin, ['--help']).out).toContain('cloud')
    const topic = run(withPlugin, ['cloud', '--help'])
    expect(topic.code).toBe(0)
    expect(topic.out).toContain('cloud hello')
  })

  test('a plugin command takes the global flags, and fails with the envelope and exit codes', () => {
    const ok = run(withPlugin, ['cloud', 'hello', '--name', 'Ada', '-o', 'json'])
    expect(ok.code).toBe(0)
    expect(JSON.parse(ok.out)).toEqual({ greeting: 'Hello, Ada' })
    const failed = run(withPlugin, ['cloud', 'hello', '--fail', '--json'])
    expect(failed.code).toBe(ERROR_KINDS.not_found.exitCode)
    expect(failed.envelope()).toMatchObject({ kind: 'not_found', hint: 'Try another --name.' })
    expect(run(withPlugin, ['cloud', 'hello', '--bogus']).code).toBe(ERROR_KINDS.usage.exitCode)
  })

  test('it is in crombolo schema, which stays valid clispec', () => {
    const result = run(withPlugin, ['schema'])
    const document = JSON.parse(result.out) as {
      commands: Array<{ name: string; effects: string }>
    }
    expect(document.commands.find((c) => c.name === 'cloud hello')?.effects).toBe('read_only')
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
      JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/clispec-v0.3.json'), 'utf8')),
    )
    expect(validate(document), JSON.stringify(validate.errors)).toBe(true)
  })

  test('it is on the reference page, under its topic', async () => {
    const { config } = await loadCli(withPlugin)
    const html = cliReferenceHtml(manifestOf(config))
    expect(html).toContain('<h2 id="cloud">cloud</h2>')
    expect(html).toContain('<code>crombolo cloud hello</code>')
  })
})

describe('not installed', () => {
  test('nothing changes, and no command warns', async () => {
    const { missing } = await loadCli(without)
    expect(missing).toEqual(['@crombolo/cloud'])
    const help = run(without, ['--help'])
    expect(help.code).toBe(0)
    expect(help.out).not.toMatch(/^\s+cloud\s/m)
    expect(help.err).toBe('')
    expect(run(without, ['schema']).err).toBe('')
  })

  test('crombolo cloud says how to add it, and exits as an unknown command does', () => {
    const result = run(without, ['cloud', 'hello', '-o', 'json'])
    expect(result.code).toBe(ERROR_KINDS.usage.exitCode)
    expect(result.code).toBe(run(without, ['nonsense']).code)
    expect(String(result.envelope().hint)).toContain('bun add -d @crombolo/cloud')
  })
})

describe('@crombolo/cli/plugin', () => {
  test('is what a plugin command needs, and the same objects the CLI uses', () => {
    for (const name of ['BaseCommand', 'Flags', 'Args', 'CliError', 'ERROR_KINDS', 'OUTCOMES'])
      expect(plugin, name).toHaveProperty(name)
    expect(plugin.signIn).toBe(client.signIn)
    expect(plugin.discover).toBe(client.discover)
    expect(plugin.RemoteClient).toBe(client.RemoteClient)
    expect(plugin.keychain).toBe(keychain)
    const pjson = JSON.parse(readFileSync(join(ROOT, 'packages/cli/package.json'), 'utf8'))
    expect(pjson.exports['./plugin']).toBe('./src/plugin.ts')
    expect(pjson.oclif.optionalPlugins).toEqual(['@crombolo/cloud'])
  })

  test('loads none of the CLI commands, and none of the site packages', () => {
    const probe = Bun.spawnSync(
      [
        'bun',
        '-e',
        `await import(${JSON.stringify(join(ROOT, 'packages/cli/src/plugin.ts'))}); console.log(JSON.stringify(Object.keys(require.cache)))`,
      ],
      { cwd: ROOT },
    )
    const loaded = JSON.parse(probe.stdout.toString()) as string[]
    expect(loaded.filter((file) => file.includes('/packages/cli/src/commands/'))).toEqual([])
    expect(loaded.filter((file) => file.includes('/packages/cli/src/operations/'))).toEqual([])
    expect(loaded.filter((file) => file.endsWith('/packages/server/src/index.ts'))).toEqual([])
  })
})

describe(`one sign-in for the CLI and a plugin (${process.env.CROMBOLO_DB ?? 'sqlite'})`, () => {
  const open: Harness[] = []
  afterEach(async () => {
    while (open.length > 0)
      await open
        .pop()
        ?.db.close()
        .catch(() => {})
  })

  async function remote() {
    const root = mkdtempSync(join(process.cwd(), 'output', 'plugin-remote-'))
    mkdirSync(join(root, 'schema'), { recursive: true })
    const h = await signedInServer({
      config: {
        siteDir: root,
        schemaDir: join(root, 'schema'),
        remote: {
          enabled: true,
          environment: 'production',
          protected: false,
          approvals: false,
          maxUploadBytes: 1024 ** 2,
        },
      },
    })
    open.push(h)
    const http = ((input: RequestInfo | URL, init?: RequestInit) =>
      h.server.fetch(new Request(input, init))) as unknown as typeof fetch
    const approve = async (code: string) => {
      await h.post(`${V1}/security/back-office/device/decide`, { userCode: code, approve: true })
    }
    return { h, http, approve }
  }

  test('a plugin uses the sign-in crombolo login made, and the other way round', async () => {
    const { http, approve } = await remote()
    const shared = memoryKeychain()
    const options = { clientName: 'test', http, sleep: () => Bun.sleep(5), onCode: approve }

    // Signed in as `crombolo login` does it; used through the plugin's exports.
    const viaLogin = await client.discover(ORIGIN, http)
    await client.signIn(viaLogin, shared, options)
    const fromPlugin = new plugin.RemoteClient(await plugin.discover(ORIGIN, http), shared, http)
    expect((await fromPlugin.environments()).map((e) => e.id)).toEqual(['production'])

    // Signed in through the plugin; the CLI's client finds it under the same key.
    const second = memoryKeychain()
    const viaPlugin = await plugin.discover(ORIGIN, http)
    await plugin.signIn(viaPlugin, second, options)
    expect(await readSignIn(second, viaLogin.api)).toBeDefined()
    const fromCli = new client.RemoteClient(viaLogin, second, http)
    expect((await fromCli.environments()).map((e) => e.id)).toEqual(['production'])
  }, 60_000)
})
