import { BaseCommand } from '../base.ts'
import { clispecDocument } from '../clispec.ts'

export default class Schema extends BaseCommand {
  static override summary = 'this CLI described for machines, as a clispec v0.3 document'
  static override description = [
    'Every command, its arguments, what it changes, what it prints and how it fails (https://clispec.dev). Name a command to narrow it. It reads no site, no network and no sign-in.',
    'Until the next release, `schema check`, `schema sync` and the rest still run the `types` commands they were renamed to.',
  ].join('\n\n')
  static override examples = ['<%= config.bin %> schema', '<%= config.bin %> schema content import']
  static override strict = false
  static override usage = 'schema [COMMAND...]'
  static override spec = {
    effects: 'read_only',
    cardinality: 'single',
    stdoutSchema: { $ref: 'https://clispec.dev/schema/v0.3.json' },
    errors: ['not_found'],
  } as const

  async run() {
    const { argv } = await this.parse(Schema)
    const path = argv.filter(
      (arg): arg is string => typeof arg === 'string' && !arg.startsWith('-'),
    )
    const document = clispecDocument(this.config, path)
    if (document.commands.length === 0)
      this.fail('not_found', `There is no command "${path.join(' ')}".`)
    // The document is the output in either mode: JSON is what it is.
    if (!this.jsonEnabled()) process.stdout.write(`${JSON.stringify(document, null, 2)}\n`)
    return document
  }
}
