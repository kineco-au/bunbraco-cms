/**
 * The bundle format: canonical on the way out, strict on the way in.
 *
 * A bundle is reviewed in a diff and committed, so the same content must
 * serialise the same way every time; and it is copied between machines, so a
 * truncated one has to be refused rather than imported as though it were whole.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BUNDLE_FORMAT_VERSION,
  type BundleNode,
  bundleIntegrity,
  type ContentSet,
  loadBundle,
  MANIFEST_FILE,
  referenceCandidates,
  writeBundle,
} from '@bunbraco/transfer'

const KEY_A = '9a1f3c2e-5d4f-4d3e-9d6d-2b7f8a1c9e10'
const KEY_B = '3f2a8b1c-1111-4222-8333-444455556666'

function node(overrides: Partial<BundleNode> = {}): BundleNode {
  return {
    key: KEY_A,
    kind: 'document',
    contentType: { key: '0b1c8e3a-4444-4a5b-9c1d-000000000001', alias: 'campaignPage' },
    parent: null,
    sortOrder: 0,
    template: 'campaignPage',
    variants: [{ culture: null, segment: null, name: 'Landing', published: true }],
    values: [
      {
        property: 'title',
        culture: null,
        segment: null,
        editor: 'Umbraco.TextBox',
        value: 'Autumn',
      },
    ],
    ...overrides,
  }
}

function set(nodes: BundleNode[]): ContentSet {
  return {
    manifest: {
      formatVersion: BUNDLE_FORMAT_VERSION,
      id: 'bundle-1',
      createdAt: '2026-10-01T09:12:04.000Z',
      createdBy: 'test',
      integrity: '',
      snapshot: 'published',
      provenance: {
        siteName: 'Test',
        schemaVersion: '1.0.0',
        schemaRevision: '0',
        schemaHash: null,
      },
      selector: { roots: [KEY_A], descendants: true, asGiven: ['/Landing'] },
      counts: { document: nodes.length },
      dependencies: {
        carried: nodes.map((n) => n.key),
        expected: [],
        schema: {
          contentTypes: [{ key: '0b1c8e3a-4444-4a5b-9c1d-000000000001', alias: 'campaignPage' }],
          templates: ['campaignPage'],
          languages: [],
        },
      },
      blobs: [],
    },
    nodes,
  }
}

function onDisk(content: ContentSet, blobs?: Map<string, Uint8Array>): string {
  const dir = mkdtempSync(join('output', 'bundle-'))
  for (const file of writeBundle(content, blobs)) {
    const target = join(dir, file.path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, file.bytes ?? (file.text as string))
  }
  return dir
}

describe('the bundle format', () => {
  test('writes one file per node, named after its key, plus a manifest', () => {
    const files = writeBundle(set([node(), node({ key: KEY_B })]))
    expect(files.map((f) => f.path)).toEqual([
      MANIFEST_FILE,
      `nodes/${KEY_B}.json`,
      `nodes/${KEY_A}.json`,
    ])
  })

  test('is canonical: the same content always serialises identically', () => {
    // Same node, fields and collections given in a different order.
    const one = node()
    const other = node({
      variants: [{ segment: null, culture: null, published: true, name: 'Landing' }],
      values: [
        {
          segment: null,
          culture: null,
          editor: 'Umbraco.TextBox',
          property: 'title',
          value: 'Autumn',
        },
      ],
    })
    expect(writeBundle(set([one]))).toEqual(writeBundle(set([other])))
  })

  test('passes an editor payload through untouched rather than reordering inside it', () => {
    // A block editor's value is JSON in a string. Rewriting it to sort keys
    // would change somebody else's data for no benefit.
    const payload = '{"zeta":1,"alpha":2}'
    const files = writeBundle(
      set([
        node({
          values: [
            {
              property: 'blocks',
              culture: null,
              segment: null,
              editor: 'Umbraco.BlockList',
              value: payload,
            },
          ],
        }),
      ]),
    )
    expect(files.find((f) => f.path.startsWith('nodes/'))?.text).toContain(JSON.stringify(payload))
  })

  test('round trips through disk', () => {
    const original = set([node(), node({ key: KEY_B, parent: KEY_A, sortOrder: 1 })])
    const dir = onDisk(original)
    try {
      const { set: read, problems } = loadBundle(dir)
      expect(problems).toEqual([])
      expect(read?.nodes).toEqual([...original.nodes].sort((a, b) => a.key.localeCompare(b.key)))
      expect(read?.manifest.selector).toEqual(original.manifest.selector)
      expect(read?.manifest.integrity).toBe(
        bundleIntegrity(writeBundle(original).filter((f) => f.path !== MANIFEST_FILE)),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('refuses a bundle whose node files do not match its integrity', () => {
    const dir = onDisk(set([node(), node({ key: KEY_B })]))
    try {
      // What a half-finished copy looks like.
      rmSync(join(dir, 'nodes', `${KEY_B}.json`))
      const { problems } = loadBundle(dir)
      expect(problems.map((p) => p.message).join(' ')).toContain('integrity does not match')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('refuses a format newer than it understands, and says to upgrade', () => {
    const dir = onDisk(set([node()]))
    try {
      writeFileSync(
        join(dir, MANIFEST_FILE),
        JSON.stringify({ formatVersion: BUNDLE_FORMAT_VERSION + 1 }),
      )
      const { set: read, problems } = loadBundle(dir)
      expect(read).toBeUndefined()
      expect(problems[0]?.message).toContain('upgrade bunbraco')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('names the file when a node is malformed', () => {
    const dir = onDisk(set([node()]))
    try {
      writeFileSync(join(dir, 'nodes', `${KEY_A}.json`), '{"kind":"document"}')
      const { problems } = loadBundle(dir)
      expect(problems.some((p) => p.file === `nodes/${KEY_A}.json` && p.message === 'no key')).toBe(
        true,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('reports a missing bundle rather than throwing', () => {
    const { set: read, problems } = loadBundle(join('output', 'no-such-bundle'))
    expect(read).toBeUndefined()
    expect(problems[0]?.message).toContain('no bundle at')
  })
})

describe('outbound reference extraction', () => {
  test('finds both spellings, in strings, arrays, objects and JSON in a string', () => {
    expect(referenceCandidates(`umb://document/${KEY_A.replaceAll('-', '')}`)).toEqual([KEY_A])
    expect(referenceCandidates(KEY_A.toUpperCase())).toEqual([KEY_A])
    // An element picker stores a bare Guid[].
    expect(referenceCandidates([KEY_A, KEY_B]).sort()).toEqual([KEY_B, KEY_A].sort())
    expect(referenceCandidates(JSON.stringify([{ mediaKey: KEY_A }]))).toEqual([KEY_A])
    expect(referenceCandidates({ nested: { deeper: [`umb://media/${KEY_B}`] } })).toEqual([KEY_B])
  })

  test('does not mistake a longer hex string for an undashed key', () => {
    // A sha256 is 64 hex characters and contains no key. Matching a bare 32-hex
    // run inside it would invent two references that resolve to nothing.
    const sha = 'a'.repeat(64)
    expect(referenceCandidates(sha)).toEqual([])
    expect(referenceCandidates(`sha256-${sha}`)).toEqual([])
  })

  test('ignores what cannot hold a key', () => {
    expect(referenceCandidates(null)).toEqual([])
    expect(referenceCandidates(42)).toEqual([])
    expect(referenceCandidates('no keys here')).toEqual([])
    expect(referenceCandidates('{not json after all')).toEqual([])
  })
})

describe('the media a bundle carries', () => {
  const BLOB = '3f2a1c9d/hero.jpg'
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
  const withBlob = (): ContentSet => {
    const content = set([node()])
    return {
      ...content,
      manifest: {
        ...content.manifest,
        blobs: [{ key: BLOB, node: KEY_A, etag: null, size: null, included: false }],
      },
    }
  }

  test('writes the bytes beside the nodes, and records their size', () => {
    const files = writeBundle(withBlob(), new Map([[BLOB, bytes]]))
    const blob = files.find((file) => file.path === `blobs/${BLOB}`)
    expect(blob?.bytes).toEqual(bytes)

    const manifest = JSON.parse(
      files.find((file) => file.path === MANIFEST_FILE)?.text as string,
    ) as { blobs: Array<{ included: boolean; size: number }> }
    // `included` is decided by whether the bytes were there to write, not by
    // the flag that asked for them: a file the store had not got is not carried,
    // and the destination is told so rather than finding nothing.
    expect(manifest.blobs[0]?.included).toBe(true)
    expect(manifest.blobs[0]?.size).toBe(bytes.length)
  })

  test('leaves the manifest honest when the bytes were not there to carry', () => {
    const files = writeBundle(withBlob())
    expect(files.some((file) => file.path.startsWith('blobs/'))).toBe(false)
    const manifest = JSON.parse(
      files.find((file) => file.path === MANIFEST_FILE)?.text as string,
    ) as { blobs: Array<{ included: boolean }> }
    expect(manifest.blobs[0]?.included).toBe(false)
  })

  test('reads them back, and hands the reader where each one is', () => {
    const dir = onDisk(withBlob(), new Map([[BLOB, bytes]]))
    const loaded = loadBundle(dir)
    expect(loaded.problems).toEqual([])
    expect(loaded.blobs.get(BLOB)).toBe(join(dir, 'blobs', BLOB))
    rmSync(dir, { recursive: true, force: true })
  })

  test('refuses a bundle whose media was edited, or never arrived', () => {
    const dir = onDisk(withBlob(), new Map([[BLOB, bytes]]))
    writeFileSync(join(dir, 'blobs', BLOB), new Uint8Array([0, 0, 0, 0]))
    // The hash covers the bytes, so `--with-blobs` is a claim the reader checks
    // rather than a line in a manifest.
    expect(
      loadBundle(dir)
        .problems.map((p) => p.message)
        .join('\n'),
    ).toContain('integrity')

    rmSync(join(dir, 'blobs', BLOB))
    const gone = loadBundle(dir)
    expect(gone.problems.map((p) => p.message).join('\n')).toContain('carried')
    rmSync(dir, { recursive: true, force: true })
  })
})
