import { BaseCommand } from '../../base.ts'
import { publishArgs, publishFlags, publishPages, publishSpec } from '../../support/publish.ts'

export default class ContentPublish extends BaseCommand {
  static override summary = 'take a page live; --descendants for the branch below it'
  static override description = '--culture per culture; --at and --until schedule it instead.'
  static override args = publishArgs
  static override flags = publishFlags
  static override audit = {
    category: 'content',
    action: 'Publish',
    entityType: 'Document',
  } as const
  static override spec = publishSpec

  async run() {
    const { args, flags } = await this.parse(ContentPublish)
    this.auditKey = args.page
    return publishPages(this, true, args.page, flags)
  }
}
