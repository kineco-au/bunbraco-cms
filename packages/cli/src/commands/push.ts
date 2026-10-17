import { Args, Flags } from '@oclif/core'
import { BaseCommand } from '../base.ts'
import { pushSite } from '../remote/transfer.ts'
import { counted, describeJob } from '../support/describe.ts'
import { confirm } from '../support/prompt.ts'
import { connectRemote, needEnvironment, openInBrowser } from '../support/remote.ts'
import { siteConfig } from '../support/site.ts'

export default class Push extends BaseCommand {
  static override summary = 'replace a remote environment with this site'
  static override description = [
    'Shows what it would replace first; --dry-run stops there.',
    "A protected environment needs --force and its name typed back (--auto-approve skips that), and the remote may also hold it for someone else's approval.",
  ].join('\n\n')
  static override examples = [
    '<%= config.bin %> push production --env staging --dry-run',
    '<%= config.bin %> push production --env live --force --auto-approve',
  ]
  static override args = {
    remote: Args.string({ description: 'the remote; the only one, when there is one' }),
  }
  static override flags = {
    env: Flags.string({ summary: 'the environment to replace', helpValue: '<id>' }),
    force: Flags.boolean({ summary: 'go on to a protected environment' }),
    'auto-approve': Flags.boolean({ summary: "with --force: don't ask for its name" }),
    'media-info-only': Flags.boolean({
      summary: 'send media files one at a time, only what the remote lacks',
    }),
    'dry-run': Flags.boolean({ summary: 'say what it would replace, and send nothing' }),
    timeout: Flags.integer({
      summary: 'seconds to wait for the remote before giving up',
      default: 1800,
      min: 1,
    }),
    'no-browser': Flags.boolean({ summary: "don't open an approval page" }),
  }
  static override spec = {
    effects: 'non_idempotent',
    cardinality: 'single',
    confirmationBypassArg: '--auto-approve',
    outputFields: [
      { name: 'environment', type: 'string' },
      { name: 'check', type: 'object' },
      { name: 'job', type: 'object', nullable: true },
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
    const { args, flags } = await this.parse(Push)
    const { client, environment: env, discovery } = await connectRemote(args.remote, flags.env)
    const environment = needEnvironment(env, discovery)
    if (flags['dry-run']) this.changedNothing = true
    const { check, job } = await pushSite(await siteConfig(), client, {
      environment,
      force: flags.force,
      autoApprove: flags['auto-approve'],
      mediaInfoOnly: flags['media-info-only'],
      dryRun: flags['dry-run'],
      timeoutMs: flags.timeout * 1000,
      onCheck: (c) => {
        this.say(
          `  sending  ${counted(c.sending.counts, 'no content')}, ${c.sending.files} file(s)`,
        )
        if (c.fromRemote) {
          if (Object.keys(c.recycles).length > 0)
            this.say(`  recycles ${counted(c.recycles)} on ${environment}`)
          if (c.removesFiles.length > 0)
            this.say(`  removes  ${c.removesFiles.join(', ')} on ${environment}`)
        }
      },
      confirm: async () => {
        await confirm(`  This replaces ${environment}. Type its name to go on:`, {
          bypass: '--auto-approve',
          answer: environment,
          declined: 'Nothing was sent.',
        })
        return true
      },
      onProgress: (j) => this.progress(describeJob(j)),
      onApproval: (j) => {
        this.progress(`  waiting  for someone else to approve it: ${j.approvalUrl}`)
        if (j.approvalUrl) openInBrowser(j.approvalUrl, flags['no-browser'])
      },
    })
    if (!job) {
      this.say('\n  Nothing was sent: that is what a push would replace.')
      return { environment, check, job: null }
    }
    if (job.state !== 'done')
      this.fail(
        'refused',
        job.problem?.title ?? `the push ended ${job.state}`,
        undefined,
        job.problem?.items,
      )
    this.say(`\n  pushed   ${environment} replaced, run ${job.runId ?? '—'}`)
    return { environment, check, job }
  }
}
