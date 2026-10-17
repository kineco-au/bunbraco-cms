/**
 * Runs the CLI. A failure inside a command is reported by the command
 * (`BaseCommand.catch`); one before any command runs — an unknown command —
 * is reported here the same way, so every failure has a kind and an exit code.
 */
import { Errors, flush, run } from '@oclif/core'
import { wantsJson } from './base.ts'
import { classify, reportFailure } from './classify.ts'
import { exitCodeOf } from './errors.ts'

export async function main(dir: string, argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    await run(argv, dir)
    await flush()
  } catch (error) {
    if (error instanceof Errors.ExitError) process.exit(error.oclif.exit ?? 0)
    const failure = classify(error)
    if (failure.kind === 'usage' && !failure.hint)
      Object.assign(failure, { hint: '`crombolo --help` lists the commands.' })
    reportFailure(failure, wantsJson(argv))
    process.exit(exitCodeOf(failure.kind))
  }
}
