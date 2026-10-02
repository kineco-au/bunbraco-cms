/**
 * The backoffice's view of source control: what the live schema has that the
 * repository does not, and a way to send it.
 *
 * Mounted only when `git` is configured. Every route needs a signed-in user, and
 * sending is a deliberate act — nothing here happens on a timer, because a commit
 * nobody asked for is a commit nobody reviewed.
 */
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { Principal } from '@bunbraco/api-management'
import { diffFiles, type GitProvider, type RepositoryFile } from './git.ts'
import { logger } from './logging.ts'

const log = logger('Git')

export interface GitConfig {
  provider: GitProvider
  /**
   * Where the schema lives in the repository. The live directory is a cache when a
   * schema store is configured, so its path is not the repository's.
   */
  schemaPath?: string
  /**
   * Raise a pull request rather than committing to the branch. On by default: a
   * schema change arriving as a PR is reviewable, and one arriving as a commit on
   * main is not.
   */
  pullRequest?: boolean
}

export interface GitHost {
  handle(request: Request, pathname: string, principal: Principal): Promise<Response | undefined>
}

export interface GitHostOptions {
  config: GitConfig
  /** The directory the live schema is loaded from. */
  schemaDir: string
  siteName: string
}

/** Every `.toml` under `dir`, as repository paths. */
async function localSchema(dir: string, prefix: string): Promise<RepositoryFile[]> {
  if (!existsSync(dir)) return []
  const files: RepositoryFile[] = []
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.toLowerCase().endsWith('.toml')) {
        files.push({
          path: `${prefix}/${relative(dir, path).split(sep).join('/')}`,
          contents: await readFile(path, 'utf8'),
        })
      }
    }
  }
  await walk(dir)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

export function createGitHost(options: GitHostOptions): GitHost {
  const prefix = (options.config.schemaPath ?? 'schema').replace(/^\/+|\/+$/g, '')
  const provider = options.config.provider

  return {
    async handle(request, pathname, principal) {
      if (pathname === '/status' && request.method === 'GET') {
        return Response.json({
          provider: provider.description,
          branch: provider.branch,
          schemaPath: prefix,
          raisesPullRequest: options.config.pullRequest !== false,
        })
      }

      if (pathname === '/diff' && request.method === 'GET') {
        const local = await localSchema(options.schemaDir, prefix)
        const { head, files } = await provider.read(prefix)
        return Response.json({
          branch: provider.branch,
          head,
          changes: diffFiles(files, local),
        })
      }

      if (pathname === '/commit' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as {
          message?: unknown
          description?: unknown
        }
        const local = await localSchema(options.schemaDir, prefix)
        const { files } = await provider.read(prefix)
        const changes = diffFiles(files, local)
        if (changes.length === 0) {
          return Response.json(
            { error: 'The repository already matches this site’s schema.' },
            { status: 409 },
          )
        }

        const message =
          typeof body.message === 'string' && body.message.trim() !== ''
            ? body.message.trim()
            : `Schema changes from ${options.siteName}`
        const description =
          typeof body.description === 'string' ? body.description : summarise(changes)

        try {
          const result = await provider.commit({
            prefix,
            files: local,
            message,
            pullRequest:
              options.config.pullRequest === false
                ? undefined
                : { title: message, body: description },
          })
          log.info('{user} sent {count} schema change(s) to {provider} as {what}', {
            user: principal.userName,
            count: changes.length,
            provider: provider.description,
            what: result.pullRequest
              ? `PR #${result.pullRequest.number}`
              : `commit ${result.commit.slice(0, 8)}`,
          })
          return Response.json(result)
        } catch (error) {
          log.error('Could not send schema to {provider}: {message}', {
            provider: provider.description,
            message: (error as Error).message,
          })
          return Response.json({ error: (error as Error).message }, { status: 502 })
        }
      }

      return undefined
    },
  }
}

/** A plain description of the change, which becomes the pull request's body. */
function summarise(changes: readonly { path: string; status: string }[]): string {
  const lines = changes.map((change) => `- ${change.status}: ${change.path}`)
  return [
    'Schema changed in the backoffice and sent from there.',
    '',
    ...lines,
    '',
    'Review as you would any schema change: these files are what the next deploy syncs.',
  ].join('\n')
}
