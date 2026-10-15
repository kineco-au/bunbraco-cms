/**
 * Cuts a release: sets every package to the version, commits the bump, tags it
 * and pushes the commit and tag together, which starts the release workflow.
 * When the packages already carry the version there is nothing to commit, and
 * the current commit is tagged instead.
 *
 *   bun run release v0.7.0
 */
import { ROOT } from './packages.ts'

export const USAGE = 'Usage: bun run release <major.minor.patch>  (a leading "v" is optional)'

const RELEASE_VERSION = /^v?(\d+\.\d+\.\d+)$/

export function parseReleaseVersion(argv: readonly string[]): string | { error: string } {
  if (argv.length !== 1) return { error: USAGE }
  const match = RELEASE_VERSION.exec(argv[0] as string)
  if (!match)
    return { error: `"${argv[0]}" is not a three-part version such as 0.7.0.\n\n${USAGE}` }
  return match[1] as string
}

/** Sets the version and stages it: what decides whether there is a bump to commit. */
export function bumpSteps(version: string): string[][] {
  return [
    ['bun', 'run', 'scripts/version.ts', version],
    ['git', 'add', '--update'],
  ]
}

/**
 * What follows the bump, in order. `bumped` is false when the packages already
 * carried the version, so there is nothing to commit and the current commit is
 * the release.
 */
export function releaseSteps(version: string, bumped: boolean): string[][] {
  const tag = `v${version}`
  return [
    ...(bumped ? [['git', 'commit', '--message', `bump version->${tag}`]] : []),
    ['git', 'tag', tag],
    // Atomic, so the tag never reaches the remote without the commit it points at
    // also landing on the branch.
    ['git', 'push', '--atomic', 'origin', 'HEAD', `refs/tags/${tag}`],
  ]
}

function capture(command: string[]): string {
  const result = Bun.spawnSync(command, { cwd: ROOT, stderr: 'inherit' })
  if (result.exitCode !== 0) throw new Error(`${command.join(' ')} failed`)
  return result.stdout.toString().trim()
}

function run(command: string[]): void {
  console.log(`$ ${command.join(' ')}`)
  const result = Bun.spawnSync(command, { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' })
  if (result.exitCode !== 0) throw new Error(`${command.join(' ')} failed`)
}

if (import.meta.main) {
  const version = parseReleaseVersion(Bun.argv.slice(2))
  if (typeof version !== 'string') {
    console.error(version.error)
    process.exit(2)
  }
  const tag = `v${version}`

  try {
    // The bump is committed with `git add --update`, so anything else outstanding
    // would be swept into the release commit.
    if (capture(['git', 'status', '--porcelain']))
      throw new Error('The working tree has uncommitted changes; commit or stash them first.')
    if (capture(['git', 'tag', '--list', tag])) throw new Error(`Tag ${tag} already exists.`)
    if (capture(['git', 'ls-remote', '--tags', 'origin', `refs/tags/${tag}`]))
      throw new Error(`Tag ${tag} already exists on origin.`)

    for (const step of bumpSteps(version)) run(step)
    // `git diff --quiet` exits 1 when something is staged.
    const bumped =
      Bun.spawnSync(['git', 'diff', '--cached', '--quiet'], { cwd: ROOT }).exitCode !== 0
    if (!bumped) console.log(`The packages are already at ${version}; tagging the current commit.`)
    for (const step of releaseSteps(version, bumped)) run(step)
    console.log(`Released ${tag}.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
