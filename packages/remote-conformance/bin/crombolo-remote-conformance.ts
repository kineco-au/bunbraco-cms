#!/usr/bin/env bun
/**
 * `crombolo-remote-conformance <url> --token <token> [--environment <id>] [--push]`
 *
 * Runs the remote protocol's conformance suite against a server and prints each
 * check. Exits non-zero when any fails. `--push` replaces the environment with a
 * copy of itself, so point it at one that may be replaced.
 */
import { runConformance } from '../src/index.ts'

const args = process.argv.slice(2)
const value = (flag: string) => {
  const at = args.indexOf(flag)
  return at >= 0 ? args[at + 1] : undefined
}
const url = args.find((arg, i) => !arg.startsWith('--') && !args[i - 1]?.startsWith('--'))
const token = value('--token') ?? process.env.CROMBOLO_REMOTE_TOKEN
if (!url || !token) {
  console.error(
    'usage: crombolo-remote-conformance <url> --token <token> [--environment <id>] [--push]\n' +
      '       (or CROMBOLO_REMOTE_TOKEN for the token)',
  )
  process.exit(2)
}

const report = await runConformance({
  url,
  token,
  environment: value('--environment'),
  push: args.includes('--push'),
})
for (const check of report.checks) {
  const mark = check.skipped ? 'skip' : check.ok ? 'pass' : 'FAIL'
  console.log(`  ${mark}  ${check.name}${check.detail ? `\n        ${check.detail}` : ''}`)
}
console.log(report.passed ? '\nConforms.' : '\nDoes not conform.')
process.exit(report.passed ? 0 : 1)
