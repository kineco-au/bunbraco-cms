import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mediaStoreFor, writeRemoteMedia } from '@crombolo/server'
import { Args, Flags } from '@oclif/core'
import { BaseCommand } from '../base.ts'
import * as ops from '../operations/commands.ts'
import { fetchReferencedMedia, pullFile, referencedBlobs } from '../remote/transfer.ts'
import {
  counted,
  describeBytes,
  describeJob,
  findingsOf,
  printTransferFindings,
} from '../support/describe.ts'
import { backupTaken } from '../support/flags.ts'
import { confirm } from '../support/prompt.ts'
import { connectRemote, needEnvironment } from '../support/remote.ts'
import { serveSite, startFromFile } from '../support/serve.ts'
import { cwd, hasSite, siteConfig } from '../support/site.ts'

export default class Pull extends BaseCommand {
  static override summary = 'a copy of a remote environment: started here, or replacing this site'
  static override description = [
    'Sealed and anonymised unless --full. In an empty folder it starts a new site and serves it; in a site it replaces it, saying first what it loses (recycled, and asked about unless --yes).',
    '--media-info-only fetches media files one at a time, only what changed since the last pull; --lazy-media fetches each the first time it is asked for; --no-media leaves them out.',
  ].join('\n\n')
  static override examples = ['<%= config.bin %> pull production --env staging --yes']
  static override args = {
    remote: Args.string({ description: 'the remote; the only one, when there is one' }),
  }
  static override flags = {
    env: Flags.string({ summary: 'the environment to pull', helpValue: '<id>' }),
    full: Flags.boolean({ summary: 'a full copy, people included: needs the permission for it' }),
    yes: Flags.boolean({ summary: 'replace this site without asking' }),
    'no-media': Flags.boolean({ summary: 'leave the media files out' }),
    'media-info-only': Flags.boolean({
      summary: 'fetch media files one at a time, only what changed',
    }),
    'lazy-media': Flags.boolean({
      summary: 'fetch each media file the first time it is asked for',
    }),
    timeout: Flags.integer({
      summary: 'seconds to wait for the remote before giving up',
      default: 1800,
      min: 1,
    }),
    'backup-taken': backupTaken,
  }
  static override spec = {
    effects: 'non_idempotent',
    cardinality: 'single',
    confirmationBypassArg: '--yes',
    outputFields: [
      { name: 'environment', type: 'string' },
      { name: 'size', type: 'integer' },
      { name: 'anonymised', type: 'boolean' },
      { name: 'started', type: 'boolean' },
      { name: 'runId', type: 'string' },
      { name: 'media', type: 'object', nullable: true },
      {
        name: 'serving',
        type: 'object',
        description: 'in an empty folder: where the new site answers',
      },
    ],
    errors: [
      'usage',
      'auth',
      'not_found',
      'refused',
      'timeout',
      'unavailable',
      'confirmation_required',
    ],
  } as const

  async run() {
    const { args, flags } = await this.parse(Pull)
    const { client, environment: env, discovery } = await connectRemote(args.remote, flags.env)
    const environment = needEnvironment(env, discovery)
    const media = flags['no-media']
      ? ('omitted' as const)
      : flags['media-info-only'] || flags['lazy-media']
        ? ('referenced' as const)
        : ('included' as const)
    const incoming = join(cwd(), '.crombolo', 'transfer', 'incoming')
    await mkdir(incoming, { recursive: true })
    const out = join(incoming, `pull-${environment}-${Date.now().toString(36)}.tgz`)
    const pulled = await pullFile(client, {
      environment,
      out,
      full: flags.full,
      media,
      onProgress: (job) => this.progress(describeJob(job)),
      timeoutMs: flags.timeout * 1000,
    })
    this.progress(`  pulled   ${describeBytes(pulled.size)}${flags.full ? '' : ', anonymised'}`)

    const existing = hasSite()
    let runId: string
    if (!existing) {
      const started = await startFromFile(this, out, {
        postgres: false,
        install: true,
        allowMissingMedia: media !== 'included',
        passphrase: pulled.passphrase,
      })
      runId = started.runId
    } else {
      const config = await siteConfig()
      const { summary } = await ops.siteReplaceCheck(config, {
        bundle: out,
        passphrase: pulled.passphrase,
        replace: 'replace',
        allowMissingBlobs: media !== 'included',
      })
      if (Object.keys(summary.leaving).length > 0)
        this.say(`  recycled ${counted(summary.leaving)} here, not in ${environment}`)
      if (summary.filesRemoved.length > 0)
        this.say(`  removes  ${summary.filesRemoved.length} file(s) here, kept for a revert`)
      if (!flags.yes)
        await confirm(`  Replace this site with ${environment}? [y/N]`, { bypass: '--yes' })
      const result = await ops.contentImport(config, {
        bundle: out,
        passphrase: pulled.passphrase,
        replace: 'replace',
        allowMissingBlobs: media !== 'included',
        label: `pull from ${environment}`,
        backupTaken: flags['backup-taken'],
      })
      for (const problem of result.problems) this.warning(`  ${problem}`)
      if (!result.runId) {
        printTransferFindings(this, result.check)
        this.fail(
          'refused',
          'pull refused. Nothing was changed.',
          undefined,
          findingsOf(result.check.outstanding),
        )
      }
      runId = result.runId
      this.say(`  replaced, run ${runId}: \`crombolo content revert ${runId}\` puts it back`)
    }

    let fetched: {
      fetched: number
      skipped: number
      bytes: number
      failed: string[]
      lazy: boolean
    } | null = null
    if (media === 'referenced') {
      const config = await siteConfig()
      const blobs = await referencedBlobs(out)
      if (flags['lazy-media']) {
        writeRemoteMedia(cwd(), { api: discovery.api, environment })
        await writeFile(
          join(cwd(), '.crombolo', 'remote-media-blobs.json'),
          `${JSON.stringify(
            blobs.map((b) => ({ key: b.key, etag: b.etag })),
            null,
            2,
          )}\n`,
        )
        this.say(
          `  media    ${blobs.length} file(s) fetched from ${environment} as they are first asked for`,
        )
        fetched = { fetched: 0, skipped: 0, bytes: 0, failed: [], lazy: true }
      } else {
        const result = await fetchReferencedMedia(client, {
          environment,
          blobs,
          store: await mediaStoreFor(config),
          siteDir: cwd(),
        })
        this.say(
          `  media    ${result.fetched} fetched (${describeBytes(result.bytes)}), ${result.skipped} already here`,
        )
        for (const key of result.failed)
          this.warning(`  missing  ${key}: run the pull again to fetch it`)
        fetched = { ...result, lazy: false }
      }
    }
    const summary = {
      environment,
      size: pulled.size,
      anonymised: !flags.full,
      started: !existing,
      runId,
      media: fetched,
    }
    if (!existing) {
      // A new site serves, as `start --from` does, so its one record is written before it does.
      const serving = await serveSite(this, {
        keepAdmin: true,
        bundles: [],
        backupTaken: false,
        resolve: [],
        'allow-missing-blobs': false,
        publish: false,
        'no-schema': false,
        'no-files': false,
        'replace-files': false,
      })
      if (this.jsonEnabled()) process.stdout.write(`${JSON.stringify({ ...summary, serving })}\n`)
      return
    }
    return summary
  }
}
