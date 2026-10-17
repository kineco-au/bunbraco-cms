/**
 * Runs the CLI. A failure inside a command is reported by the command
 * (`BaseCommand.catch`); one before any command runs — an unknown command —
 * is reported here the same way, so every failure has a kind and an exit code.
 */
import { Errors, flush, run } from '@oclif/core'
import { wantsJson } from './base.ts'
import { CliError, exitCodeOf } from './errors.ts'
import { loadCli } from './load.ts'

/** The topic each optional plugin brings, and how to add it. */
const PLUGIN_TOPICS: Record<string, { topic: string; what: string }> = {
  '@crombolo/cloud': { topic: 'cloud', what: 'Crombolo Cloud' },
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    const { config, missing } = await loadCli()
    const absent = missing
      .map((name) => ({ name, ...PLUGIN_TOPICS[name] }))
      .find((plugin) => plugin.topic && argv[0] === plugin.topic)
    if (absent)
      throw new CliError(
        'usage',
        `\`crombolo ${absent.topic}\` comes with the ${absent.what} plugin, which is not installed.`,
        {
          hint: `Add it to the site: bun add -d ${absent.name}`,
        },
      )
    await run(argv, config)
    await flush()
  } catch (error) {
    if (error instanceof Errors.ExitError) process.exit(error.oclif.exit ?? 0)
    const { classify, reportFailure } = await import('./classify.ts')
    const failure = classify(error)
    if (failure.kind === 'usage' && !failure.hint)
      Object.assign(failure, { hint: '`crombolo --help` lists the commands.' })
    reportFailure(failure, wantsJson(argv))
    process.exit(exitCodeOf(failure.kind))
  }
}
