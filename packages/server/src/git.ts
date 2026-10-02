/**
 * Getting schema changes made on a running site back into source control,
 * without an editor ever meeting git.
 *
 * Optional, like everything else here: absent from the configuration there is no
 * route and no credentials anywhere. Configured, the backoffice can show what the
 * live schema has that the repository does not, and send it — as a commit on a
 * branch, or as a pull request for somebody to review.
 *
 * Over the provider's HTTP API rather than a `git` binary, because the CMS image
 * has no git and should not grow one, and because a shallow clone per diff to
 * compare a handful of TOML files would be absurd. `GitProvider` is the seam;
 * GitHub is the implementation that ships.
 */

export interface RepositoryFile {
  /** Repository-relative, e.g. `schema/document-types/home-page.toml`. */
  path: string
  contents: string
}

export type FileChange =
  | { path: string; status: 'added'; local: string; remote: undefined }
  | { path: string; status: 'modified'; local: string; remote: string }
  | { path: string; status: 'removed'; local: undefined; remote: string }

export interface GitDiff {
  branch: string
  /** The commit the comparison was made against. */
  head: string
  changes: FileChange[]
}

export interface PushResult {
  /** The branch the commit landed on. */
  branch: string
  commit: string
  /** Present when a pull request was opened. */
  pullRequest?: { number: number; url: string }
}

export interface GitProvider {
  /** Named in logs and in the backoffice, e.g. `github:kineco-au/site`. */
  readonly description: string
  /** The branch changes are compared against and sent to. */
  readonly branch: string
  /** Every file under `prefix`, at the head of `branch`. */
  read(prefix: string): Promise<{ head: string; files: RepositoryFile[] }>
  /** Commits `files`, replacing what is under `prefix`, and optionally raises a PR. */
  commit(input: {
    prefix: string
    files: readonly RepositoryFile[]
    message: string
    /** Raise a pull request instead of committing straight to `branch`. */
    pullRequest?: { title: string; body: string }
  }): Promise<PushResult>
}

/** What `git status` would say, comparing the repository against what is on disk now. */
export function diffFiles(
  remote: readonly RepositoryFile[],
  local: readonly RepositoryFile[],
): FileChange[] {
  const byPath = new Map(remote.map((file) => [file.path, file.contents]))
  const changes: FileChange[] = []

  for (const file of local) {
    const previous = byPath.get(file.path)
    if (previous === undefined) {
      changes.push({ path: file.path, status: 'added', local: file.contents, remote: undefined })
    } else if (previous !== file.contents) {
      changes.push({
        path: file.path,
        status: 'modified',
        local: file.contents,
        remote: previous,
      })
    }
  }

  const here = new Set(local.map((file) => file.path))
  for (const file of remote) {
    if (here.has(file.path)) continue
    changes.push({ path: file.path, status: 'removed', local: undefined, remote: file.contents })
  }

  return changes.sort((a, b) => a.path.localeCompare(b.path))
}
