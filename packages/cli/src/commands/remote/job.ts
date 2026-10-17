import { Args, Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import { describeJob } from '../../support/describe.ts'
import { connectRemote } from '../../support/remote.ts'

export default class RemoteJob extends BaseCommand {
  static override summary = 'watch a pull or push job again, after a wait gave up'
  static override description =
    "Exits 0 when the job is done, and with the job's own failure otherwise."
  static override args = {
    id: Args.string({ required: true, description: 'the job id the wait printed' }),
    remote: Args.string({ description: 'the remote; the only one, when there is one' }),
  }
  static override flags = {
    timeout: Flags.integer({ summary: 'seconds to wait before giving up', default: 1800, min: 1 }),
  }
  static override spec = {
    effects: 'read_only',
    cardinality: 'single',
    outputFields: [
      { name: 'id', type: 'string' },
      { name: 'kind', type: 'string' },
      { name: 'state', type: 'string' },
      { name: 'environment', type: 'string' },
      { name: 'runId', type: 'string', nullable: true },
    ],
    errors: ['timeout', 'not_found', 'auth', 'refused', 'unavailable'],
  } as const

  async run() {
    const { args, flags } = await this.parse(RemoteJob)
    const { client } = await connectRemote(args.remote, undefined)
    const job = await client.settle(args.id, {
      onProgress: (j) => this.progress(describeJob(j)),
      timeoutMs: flags.timeout * 1000,
    })
    if (job.state !== 'done')
      this.fail(
        'refused',
        job.problem?.title ?? `The ${job.kind} ended ${job.state}.`,
        undefined,
        job.problem?.items,
      )
    this.say(`  ${job.kind} ${job.state}${job.runId ? `, run ${job.runId}` : ''}`)
    return {
      id: job.id,
      kind: job.kind,
      state: job.state,
      environment: job.environment,
      runId: job.runId ?? null,
    }
  }
}
