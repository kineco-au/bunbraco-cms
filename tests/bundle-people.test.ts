/**
 * Story 071: a bundle's metadata in the open and anything personal sealed —
 * people in `people/`, values in `values/`, media files in place — counted in
 * the manifest without naming anyone, covered by the integrity hash, and
 * opened only with the passphrase.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BUNDLE_FORMAT_VERSION,
  type BundleNode,
  type BundlePeople,
  type ContentSet,
  loadBundle,
  MANIFEST_FILE,
  newSeal,
  openBundle,
  type WriteOptions,
  WrongPassphraseError,
  writeBundle,
  writeBundlePackage,
} from '@crombolo/transfer'

const CHEAP = { n: 2 ** 10, r: 8, p: 1 }
const PASS = 'a long and private passphrase'

const PEOPLE: BundlePeople = {
  memberGroups: [{ key: '0b6c1a3e-0000-4000-8000-000000000001', name: 'Staff' }],
  members: [
    {
      key: '0b6c1a3e-0000-4000-8000-000000000002',
      name: 'Ada Lovelace',
      memberTypeAlias: 'Member',
      email: 'ada@example.test',
      username: 'ada',
      isApproved: true,
      isLockedOut: false,
      passwordHash:
        'AQAAAAIAAYagAAAAEJBorDjt+UEvw55UJVsbgAS6T2IGao+2XpCBbO3EKZoAMzoN+CNOpPdu1c0qrFcJVw==',
      passwordConfig: '{"hashAlgorithm":"PBKDF2.ASPNETCORE.V3"}',
      groupKeys: ['0b6c1a3e-0000-4000-8000-000000000001'],
      values: [],
    },
  ],
  userGroups: [],
  users: [],
}

const emptySet: ContentSet = {
  manifest: {
    formatVersion: BUNDLE_FORMAT_VERSION,
    id: 'bundle-people',
    createdAt: '2026-10-15T00:00:00Z',
    createdBy: 'test',
    integrity: '',
    snapshot: 'published',
    provenance: {
      siteName: 'Source',
      schemaVersion: '1.0.0',
      schemaRevision: '0',
      schemaHash: null,
    },
    selector: { roots: [], descendants: true, asGiven: [] },
    counts: {},
    dependencies: {
      carried: [],
      expected: [],
      schema: { contentTypes: [], components: [], languages: [] },
    },
    blobs: [],
  },
  nodes: [],
}

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const PAGE: BundleNode = {
  key: '0b6c1a3e-0000-4000-8000-0000000000a1',
  kind: 'document',
  contentType: { key: '', alias: 'staffPage' },
  parent: null,
  sortOrder: 0,
  template: null,
  variants: [{ culture: null, segment: null, name: 'Our team', published: true }],
  values: [
    {
      property: 'bio',
      culture: null,
      segment: null,
      editor: 'Umbraco.TextArea',
      value: 'Ada was born in 1815',
    },
    {
      property: 'title',
      culture: 'en-US',
      segment: null,
      editor: 'Umbraco.TextBox',
      value: 'Team',
    },
  ],
  access: {
    loginNode: '0b6c1a3e-0000-4000-8000-0000000000a2',
    errorNode: '0b6c1a3e-0000-4000-8000-0000000000a2',
    memberGroups: ['Staff'],
    memberUserNames: ['ada'],
  },
  schedule: [{ culture: null, action: 'unpublish', date: '2027-01-01T00:00:00.000Z' }],
  redirects: [{ path: '/people', root: null, culture: null }],
}
const BLOB = 'a1/photo.jpg'
const PHOTO = new Uint8Array(Buffer.from('a photograph of ada'))
const pageSet: ContentSet = {
  ...emptySet,
  manifest: {
    ...emptySet.manifest,
    blobs: [{ key: BLOB, node: PAGE.key, etag: null, size: null, included: true }],
  },
  nodes: [PAGE],
}

function write(set: ContentSet, options: WriteOptions, blobs = new Map<string, Uint8Array>()) {
  const dir = mkdtempSync(join(process.cwd(), 'output', 'bundle-people-'))
  dirs.push(dir)
  for (const file of writeBundle(set, blobs, [], options)) {
    mkdirSync(join(dir, file.path, '..'), { recursive: true })
    writeFileSync(join(dir, file.path), file.bytes ?? (file.text as string))
  }
  return dir
}

const written = () => write(emptySet, { seal: newSeal(PASS, CHEAP), people: PEOPLE })

/** Every file of a bundle directory, as one string. */
const everything = (dir: string): string =>
  [...new Bun.Glob('**/*').scanSync({ cwd: dir })]
    .map((path) => readFileSync(join(dir, path)).toString('latin1'))
    .join('\n')

describe('a bundle with people', () => {
  test('is format 3, counts its people, and names nobody in the clear', () => {
    const dir = written()
    const manifest = readFileSync(join(dir, MANIFEST_FILE), 'utf8')
    expect(JSON.parse(manifest)).toMatchObject({
      formatVersion: 3,
      people: { counts: { members: 1, memberGroups: 1, users: 0, userGroups: 0 } },
    })
    expect(manifest).not.toContain('ada')
    const member = readFileSync(
      join(dir, 'people/members/0b6c1a3e-0000-4000-8000-000000000002.json'),
    )
    expect(member.includes(Buffer.from('ada@example.test'))).toBe(false)
  })

  test('reads back whole with the passphrase, and not at all without it', () => {
    const loaded = loadBundle(written())
    expect(loaded.problems).toEqual([])
    const people = loaded.people as NonNullable<typeof loaded.people>
    expect(people.block.counts.members).toBe(1)
    expect(openBundle(loaded, PASS).people).toEqual(PEOPLE)
    expect(() => openBundle(loaded, 'guess')).toThrow(WrongPassphraseError)
    expect(() => openBundle(loaded, undefined)).toThrow(WrongPassphraseError)
  })

  test('a sealed file that changed fails the integrity check before anything is opened', () => {
    const dir = written()
    const path = join(dir, 'people/members/0b6c1a3e-0000-4000-8000-000000000002.json')
    const bytes = readFileSync(path)
    bytes[30] = (bytes[30] as number) ^ 1
    writeFileSync(path, bytes)
    expect(
      loadBundle(dir)
        .problems.map((p) => p.message)
        .join(' '),
    ).toContain('integrity')
  })

  test('people need a seal: writing them without one is refused', () => {
    expect(() => writeBundle(emptySet, undefined, [], { people: PEOPLE })).toThrow('passphrase')
  })

  test('a bundle without people stays format 1 and has no people block', () => {
    const dir = mkdtempSync(join(process.cwd(), 'output', 'bundle-people-'))
    dirs.push(dir)
    const manifest = JSON.parse(writeBundle(emptySet)[0]?.text as string)
    expect(manifest.formatVersion).toBe(1)
    expect(manifest.people).toBeUndefined()
  })
})

describe('sealed content', () => {
  test('names and structure stay readable; values, usernames and media files do not', () => {
    const dir = write(pageSet, { seal: newSeal(PASS, CHEAP) }, new Map([[BLOB, PHOTO]]))
    const node = JSON.parse(readFileSync(join(dir, `nodes/${PAGE.key}.json`), 'utf8'))
    expect(node.variants[0].name).toBe('Our team')
    expect(node.values).toEqual([
      { property: 'bio', culture: null, segment: null, editor: 'Umbraco.TextArea' },
      { property: 'title', culture: 'en-US', segment: null, editor: 'Umbraco.TextBox' },
    ])
    expect(node.access).toEqual({
      loginNode: PAGE.access?.loginNode,
      errorNode: PAGE.access?.errorNode,
      memberGroups: ['Staff'],
    })
    expect(node.schedule).toEqual(PAGE.schedule)
    expect(node.redirects).toEqual(PAGE.redirects)
    const all = everything(dir)
    for (const secret of ['born in 1815', '"ada"', 'a photograph'])
      expect(all).not.toContain(secret)
    expect(JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8'))).toMatchObject({
      formatVersion: 3,
      content: 'sealed',
      seal: { kdf: 'scrypt' },
    })
  })

  test('opens to what was exported, and the media file to its bytes', () => {
    const loaded = loadBundle(
      write(pageSet, { seal: newSeal(PASS, CHEAP) }, new Map([[BLOB, PHOTO]])),
    )
    expect(loaded.problems).toEqual([])
    expect(loaded.set?.sealed).toBe(true)
    expect(loaded.set?.nodes[0]?.values.map((v) => v.value)).toEqual([undefined, undefined])
    const opened = openBundle(loaded, PASS)
    expect(opened.set.sealed).toBeUndefined()
    expect(opened.set.nodes).toEqual([PAGE])
    const file = loaded.blobs.get(BLOB) as string
    expect(Buffer.from(opened.openBlob(BLOB, readFileSync(file))).toString()).toBe(
      'a photograph of ada',
    )
  })

  test('a missing sealed file is refused', () => {
    const dir = write(pageSet, { seal: newSeal(PASS, CHEAP) })
    rmSync(join(dir, `values/${PAGE.key}.json`))
    expect(loadBundle(dir).problems.map((p) => p.file)).toContain(`values/${PAGE.key}.json`)
  })

  test('omitted content carries names and rules, and no value, username or media file', () => {
    const dir = write(pageSet, { content: 'omitted' }, new Map([[BLOB, PHOTO]]))
    const loaded = loadBundle(dir)
    expect(loaded.problems).toEqual([])
    expect(loaded.set?.sealed).toBeUndefined()
    expect(loaded.set?.manifest.content).toBe('omitted')
    expect(loaded.set?.manifest.blobs).toEqual([])
    const node = loaded.set?.nodes[0] as BundleNode
    expect(node.values).toEqual([])
    expect(node.access?.memberUserNames).toBeUndefined()
    expect(node.redirects).toEqual(PAGE.redirects)
    expect(everything(dir)).not.toContain('a photograph')
  })

  test('open content is readable as it always was, but rules on a node still need format 3', () => {
    const loaded = loadBundle(write(pageSet, {}))
    expect(loaded.set?.manifest.formatVersion).toBe(3)
    expect(openBundle(loaded, undefined).set.nodes).toEqual([PAGE])
  })
})

describe('a package for anyone to install', () => {
  const info = {
    name: 'starter',
    version: '1.0.0',
    id: 'starter',
    label: 'Starter',
    peerRange: '*',
  }

  test('carries open content, and refuses people or sealed content', () => {
    expect(() => writeBundlePackage(writeBundle(pageSet, undefined, [], {}), info)).not.toThrow()
    expect(() =>
      writeBundlePackage(writeBundle(pageSet, undefined, [], { seal: newSeal(PASS, CHEAP) }), info),
    ).toThrow('encrypted')
    expect(() =>
      writeBundlePackage(
        writeBundle(emptySet, undefined, [], { seal: newSeal(PASS, CHEAP), people: PEOPLE }),
        info,
      ),
    ).toThrow('members or users')
    // A private one, an environment's export, may carry either.
    expect(() =>
      writeBundlePackage(writeBundle(pageSet, undefined, [], { seal: newSeal(PASS, CHEAP) }), {
        ...info,
        private: true,
      }),
    ).not.toThrow()
  })
})
