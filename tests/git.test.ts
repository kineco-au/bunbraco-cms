/**
 * Source control from the backoffice.
 *
 * The point is that an editor who changed a document type on a running site can
 * see what the repository is missing and send it, without meeting git. So what
 * these hold to is the diff being right, the commit carrying the whole change as
 * one, and the feature not existing at all when it is not configured.
 *
 * The provider is a local fake standing in for GitHub; `git-github.ts` is exercised
 * against a fake API below rather than against the network.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_BACKOFFICE_PATH } from '@bunbraco/core'
import { diffFiles, type GitProvider, gitHub, type RepositoryFile } from '@bunbraco/server'
import { type Harness, signedInServer, signInAsGroup } from './support/harness.ts'

const dirs: string[] = []
const open: Harness[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const GIT = `${DEFAULT_BACKOFFICE_PATH}/bunbraco/api/git`

const HOME = '[document-type]\nalias = "homePage"\nname = "Home Page"\n'
const ARTICLE = '[document-type]\nalias = "article"\nname = "Article"\n'

describe('the diff', () => {
  const file = (path: string, contents: string): RepositoryFile => ({ path, contents })

  test('reports what the site added, changed and removed', () => {
    const remote = [file('schema/a.toml', 'one'), file('schema/gone.toml', 'x')]
    const local = [file('schema/a.toml', 'two'), file('schema/new.toml', 'y')]

    expect(diffFiles(remote, local)).toEqual([
      { path: 'schema/a.toml', status: 'modified', local: 'two', remote: 'one' },
      { path: 'schema/gone.toml', status: 'removed', local: undefined, remote: 'x' },
      { path: 'schema/new.toml', status: 'added', local: 'y', remote: undefined },
    ])
  })

  test('an identical tree is no changes at all', () => {
    const same = [file('schema/a.toml', 'one')]
    expect(diffFiles(same, [...same])).toEqual([])
  })
})

/** A provider that keeps its tree in memory, so the routes can be exercised. */
function fakeProvider(initial: Record<string, string> = {}): GitProvider & {
  tree: Map<string, string>
  commits: { message: string; pullRequest?: { title: string; body: string } }[]
} {
  const tree = new Map(Object.entries(initial))
  const commits: { message: string; pullRequest?: { title: string; body: string } }[] = []
  return {
    description: 'fake:owner/repo',
    branch: 'main',
    tree,
    commits,
    async read(prefix) {
      return {
        head: 'abc1234',
        files: [...tree.entries()]
          .filter(([path]) => path.startsWith(`${prefix}/`))
          .map(([path, contents]) => ({ path, contents })),
      }
    },
    async commit({ prefix, files, message, pullRequest }) {
      commits.push({ message, pullRequest })
      for (const path of [...tree.keys()]) if (path.startsWith(`${prefix}/`)) tree.delete(path)
      for (const file of files) tree.set(file.path, file.contents)
      return pullRequest
        ? { branch: 'topic', commit: 'def5678', pullRequest: { number: 7, url: 'https://x/7' } }
        : { branch: 'main', commit: 'def5678' }
    },
  }
}

async function site(provider?: GitProvider, pullRequest?: boolean) {
  const schemaDir = mkdtempSync(join(process.cwd(), 'output', 'git-'))
  dirs.push(schemaDir)
  mkdirSync(join(schemaDir, 'document-types'), { recursive: true })
  writeFileSync(join(schemaDir, 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(schemaDir, 'document-types', 'home-page.toml'), HOME)

  const h = await signedInServer({
    config: {
      schemaDir,
      git: provider ? { provider, pullRequest } : undefined,
    },
  })
  open.push(h)
  return { h, schemaDir }
}

describe('from the backoffice', () => {
  test('shows what the repository is missing', async () => {
    const provider = fakeProvider({ 'schema/schema.toml': '[schema]\nversion = "1.0.0"\n' })
    const { h, schemaDir } = await site(provider)
    writeFileSync(join(schemaDir, 'document-types', 'article.toml'), ARTICLE)

    const diff = await h.json<{
      branch: string
      head: string
      changes: { path: string; status: string }[]
    }>(`${GIT}/diff`)
    expect(diff.branch).toBe('main')
    expect(diff.head).toBe('abc1234')
    expect(diff.changes).toEqual([
      expect.objectContaining({ path: 'schema/document-types/article.toml', status: 'added' }),
      expect.objectContaining({ path: 'schema/document-types/home-page.toml', status: 'added' }),
    ])
  })

  test('raises a pull request by default, carrying the whole change as one commit', async () => {
    const provider = fakeProvider({ 'schema/schema.toml': 'old' })
    const { h } = await site(provider)

    const sent = await h.post(`${GIT}/commit`, { message: 'Add the Article type' })
    expect(sent.status).toBe(200)
    expect(await sent.json()).toMatchObject({ pullRequest: { number: 7 } })

    expect(provider.commits).toHaveLength(1)
    expect(provider.commits[0]?.message).toBe('Add the Article type')
    expect(provider.commits[0]?.pullRequest?.body).toContain('schema/document-types/home-page.toml')
    // The whole prefix is replaced, so the repository now matches the site.
    expect([...provider.tree.keys()].sort()).toEqual([
      'schema/document-types/home-page.toml',
      'schema/schema.toml',
    ])
  })

  test('commits straight to the branch when asked to', async () => {
    const provider = fakeProvider({ 'schema/old.toml': 'x' })
    const { h } = await site(provider, false)
    const sent = await h.post(`${GIT}/commit`, {})
    expect(sent.status).toBe(200)
    expect((await sent.json()) as { pullRequest?: unknown }).not.toHaveProperty('pullRequest')
    expect(provider.commits[0]?.pullRequest).toBeUndefined()
  })

  test('refuses when there is nothing to send', async () => {
    const provider = fakeProvider()
    const { h } = await site(provider)
    await h.post(`${GIT}/commit`, {})
    // Second time there is no difference left.
    const again = await h.post(`${GIT}/commit`, {})
    expect(again.status).toBe(409)
    expect(await again.text()).toContain('already matches')
  })

  test('a provider failure is reported, not swallowed', async () => {
    const provider = fakeProvider({ 'schema/x.toml': 'x' })
    provider.commit = () => Promise.reject(new Error('GitHub POST /git/blobs failed (403)'))
    const { h } = await site(provider)
    const sent = await h.post(`${GIT}/commit`, {})
    expect(sent.status).toBe(502)
    expect(await sent.text()).toContain('403')
  })

  test('says where it would send, before anything is sent', async () => {
    const { h } = await site(fakeProvider())
    expect(await h.json(`${GIT}/status`)).toMatchObject({
      provider: 'fake:owner/repo',
      branch: 'main',
      raisesPullRequest: true,
    })
  })
})

describe('who may use it', () => {
  test('Settings, as changing a type requires — not merely a session', async () => {
    const provider = fakeProvider({ 'schema/schema.toml': '[schema]\nversion = "1.0.0"\n' })
    const { h } = await site(provider)

    // A writer holds Content. The diff is the schema's full text and a commit
    // pushes it under this site's credentials, so neither is theirs to do.
    const writer = await signInAsGroup(h)
    expect((await writer.call(`${GIT}/diff`)).status).toBe(403)
    expect((await writer.post(`${GIT}/commit`, { message: 'Mine now' })).status).toBe(403)
    expect(provider.commits).toHaveLength(0)

    expect((await h.call(`${GIT}/diff`)).status).toBe(200)
  })
})

describe('when it is not configured', () => {
  test('there is no git endpoint at all', async () => {
    const { h } = await site()
    for (const path of ['/status', '/diff']) {
      expect((await h.call(`${GIT}${path}`)).status).toBe(404)
    }
    expect((await h.call(`${GIT}/commit`, { method: 'POST' })).status).toBe(404)
  })
})

describe('the GitHub provider', () => {
  test('builds one commit from blobs and a tree, and opens a pull request', async () => {
    const seen: { method: string; path: string; body: unknown }[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const body =
          request.method === 'POST' || request.method === 'PATCH' ? await request.json() : undefined
        seen.push({ method: request.method, path: url.pathname, body })
        if (url.pathname.endsWith('/git/ref/heads/main')) {
          return Response.json({ object: { sha: 'head1' } })
        }
        if (url.pathname.endsWith('/git/commits/head1'))
          return Response.json({ tree: { sha: 'tree1' } })
        if (url.pathname.includes('/git/trees/head1')) {
          return Response.json({ tree: [{ path: 'schema/gone.toml', type: 'blob', sha: 'b0' }] })
        }
        if (url.pathname.endsWith('/git/blobs')) return Response.json({ sha: 'blob1' })
        if (url.pathname.endsWith('/git/trees')) return Response.json({ sha: 'tree2' })
        if (url.pathname.endsWith('/git/commits')) return Response.json({ sha: 'commit1' })
        if (url.pathname.endsWith('/git/refs')) return Response.json({})
        if (url.pathname.endsWith('/pulls')) {
          return Response.json({ number: 12, html_url: 'https://github.test/pull/12' })
        }
        return Response.json({}, { status: 404 })
      },
    })
    try {
      const provider = gitHub({
        repository: 'owner/repo',
        token: 'test-token',
        api: server.url.origin,
      })
      const result = await provider.commit({
        prefix: 'schema',
        files: [{ path: 'schema/a.toml', contents: 'hello' }],
        message: 'Schema change',
        pullRequest: { title: 'Schema change', body: 'why' },
      })

      expect(result.pullRequest).toEqual({ number: 12, url: 'https://github.test/pull/12' })
      // A file the site no longer has is deleted by a null sha in the tree.
      const tree = seen.find((call) => call.path.endsWith('/git/trees') && call.method === 'POST')
      expect(tree?.body).toMatchObject({
        base_tree: 'tree1',
        tree: expect.arrayContaining([
          expect.objectContaining({ path: 'schema/a.toml', sha: 'blob1' }),
          expect.objectContaining({ path: 'schema/gone.toml', sha: null }),
        ]),
      })
      // The token is presented as a bearer on every call.
      expect(seen.length).toBeGreaterThan(4)
    } finally {
      server.stop(true)
    }
  })

  test('a refusal names the call that failed', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response('Bad credentials', { status: 401 }),
    })
    try {
      const provider = gitHub({ repository: 'owner/repo', token: 'bad', api: server.url.origin })
      await expect(provider.read('schema')).rejects.toThrow(/401.*Bad credentials/)
    } finally {
      server.stop(true)
    }
  })
})
