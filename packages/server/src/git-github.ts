/**
 * GitHub, over its REST API.
 *
 * A commit is built the long way — blobs, a tree, a commit, then moving a ref —
 * rather than with the contents API, because that writes one file per request and
 * a schema change is usually several. Built this way the whole change is one
 * commit, which is what a reviewer wants to see, and a partly-applied change is
 * not a state that can happen.
 *
 * Needs a token with `contents: write`, and `pull_requests: write` to raise a PR.
 * A fine-grained personal access token or a GitHub App installation token both
 * work; the token is the CMS's own identity, so its commits are attributable to
 * the CMS rather than to whoever was signed in.
 */
import {
  diffFiles,
  type GitDiff,
  type GitProvider,
  type PushResult,
  type RepositoryFile,
} from './git.ts'

export interface GitHubOptions {
  /** `owner/repo`. */
  repository: string
  token: string
  /** The branch to compare against and commit to. Default `main`. */
  branch?: string
  /** For GitHub Enterprise; default is github.com's API. */
  api?: string
  /** The commit author; defaults to a bot identity naming the site. */
  author?: { name: string; email: string }
}

interface TreeEntry {
  path: string
  mode: '100644'
  type: 'blob'
  sha: string
}

export function gitHub(options: GitHubOptions): GitProvider {
  const api = (options.api ?? 'https://api.github.com').replace(/\/$/, '')
  const branch = options.branch ?? 'main'
  const base = `${api}/repos/${options.repository}`
  const author = options.author ?? { name: 'bunbraco', email: 'bunbraco@users.noreply.github.com' }

  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${options.token}`,
        'x-github-api-version': '2022-11-28',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300)
      throw new Error(
        `GitHub ${init.method ?? 'GET'} ${path} failed (${response.status}): ${detail}`,
      )
    }
    return (await response.json()) as T
  }

  return {
    description: `github:${options.repository}`,
    branch,

    async read(prefix) {
      const ref = await call<{ object: { sha: string } }>(`/git/ref/heads/${branch}`)
      const head = ref.object.sha
      // One recursive call for the whole tree beats walking it a directory at a time.
      const tree = await call<{ tree: { path: string; type: string; sha: string }[] }>(
        `/git/trees/${head}?recursive=1`,
      )
      const wanted = tree.tree.filter(
        (entry) => entry.type === 'blob' && entry.path.startsWith(`${prefix}/`),
      )
      const files: RepositoryFile[] = []
      for (const entry of wanted) {
        const blob = await call<{ content: string; encoding: string }>(`/git/blobs/${entry.sha}`)
        const contents =
          blob.encoding === 'base64'
            ? new TextDecoder().decode(
                Uint8Array.from(atob(blob.content.replace(/\n/g, '')), (c) => c.charCodeAt(0)),
              )
            : blob.content
        files.push({ path: entry.path, contents })
      }
      return { head, files }
    },

    async commit({ prefix, files, message, pullRequest }) {
      const ref = await call<{ object: { sha: string } }>(`/git/ref/heads/${branch}`)
      const head = ref.object.sha
      const headCommit = await call<{ tree: { sha: string } }>(`/git/commits/${head}`)

      const entries: TreeEntry[] = []
      for (const file of files) {
        const blob = await call<{ sha: string }>('/git/blobs', {
          method: 'POST',
          body: JSON.stringify({ content: file.contents, encoding: 'utf-8' }),
        })
        entries.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha })
      }

      // Files the site no longer has are deleted by giving them a null sha, which
      // is how the tree API spells "remove this path".
      const existing = await call<{ tree: { path: string; type: string }[] }>(
        `/git/trees/${head}?recursive=1`,
      )
      const keeping = new Set(files.map((file) => file.path))
      const removals = existing.tree
        .filter((entry) => entry.type === 'blob' && entry.path.startsWith(`${prefix}/`))
        .filter((entry) => !keeping.has(entry.path))
        .map((entry) => ({ path: entry.path, mode: '100644', type: 'blob', sha: null }))

      const tree = await call<{ sha: string }>('/git/trees', {
        method: 'POST',
        body: JSON.stringify({ base_tree: headCommit.tree.sha, tree: [...entries, ...removals] }),
      })
      const commit = await call<{ sha: string }>('/git/commits', {
        method: 'POST',
        body: JSON.stringify({ message, tree: tree.sha, parents: [head], author }),
      })

      if (!pullRequest) {
        await call(`/git/refs/heads/${branch}`, {
          method: 'PATCH',
          body: JSON.stringify({ sha: commit.sha }),
        })
        return { branch, commit: commit.sha }
      }

      const topic = `bunbraco/schema-${commit.sha.slice(0, 8)}`
      await call('/git/refs', {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${topic}`, sha: commit.sha }),
      })
      const raised = await call<{ number: number; html_url: string }>('/pulls', {
        method: 'POST',
        body: JSON.stringify({
          title: pullRequest.title,
          body: pullRequest.body,
          head: topic,
          base: branch,
        }),
      })
      return {
        branch: topic,
        commit: commit.sha,
        pullRequest: { number: raised.number, url: raised.html_url },
      }
    },
  }
}

/** The live files against the repository, for the backoffice to show before sending. */
export async function diffAgainst(
  provider: GitProvider,
  prefix: string,
  local: readonly RepositoryFile[],
): Promise<GitDiff> {
  const { head, files } = await provider.read(prefix)
  return { branch: provider.branch, head, changes: diffFiles(files, local) }
}

export type { PushResult }
