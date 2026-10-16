/**
 * A whole site in one file (story 104): every content node, media file, schema
 * file, component, stylesheet, script and dictionary item, as one private npm
 * package tarball — the bundle format with `scope: 'site'`. `docs/bundles.md`.
 *
 * Written as it goes. The media files stream from the store into the gzip, and
 * the integrity hash is computed as each file passes, in the path order
 * `bundleIntegrity` defines; only the small files are held. The tarball is
 * written beside its destination and renamed into place once complete, so a
 * failed export never leaves a file that looks whole.
 */
import { rename, rm } from 'node:fs/promises'
import { discoverBundles } from '@crombolo/backoffice-host'
import { type Db, NodeRepository, type NodeRow, ObjectTypes } from '@crombolo/data'
import {
  BUNDLE_SECTIONS,
  type BundleFile,
  type BundlePackageInfo,
  blobPath,
  bundleIdFor,
  bundlePackageJson,
  exportBundle,
  exportPeople,
  MANIFEST_FILE,
  newSeal,
  PAYLOAD_DIR,
  packageNameFor,
  planStreamedBundle,
  sanitise,
  sealBytes,
  writeManifest,
} from '@crombolo/transfer'
import { createFileSystemPort } from './adapters/file-system.ts'
import { createTemplateFileStore } from './adapters/template-files.ts'
import { type CromboloConfig, VERSION } from './config.ts'
import { mediaStoreFor } from './media-files.ts'
import { type StoredFile, streamOf } from './media-store.ts'
import { siteSections } from './site-sections.ts'
import { TarballWriter } from './tar.ts'

export interface SiteExportOptions {
  /** The `.tgz` to write. */
  out: string
  /**
   * False for `--no-media`: the media nodes travel, their files do not.
   * `referenced`: likewise, for a remote and its CLI to move the files one at a
   * time (story 107).
   */
  media?: boolean | 'referenced'
  /** Carry the latest drafts rather than what is published. */
  drafts?: boolean
  withMembers?: boolean
  withUsers?: boolean
  /** Replace every personal value before anything is written (`sanitise`). */
  anonymise?: boolean
  /**
   * Seal the content data — property values and media files — as well as any
   * people, under `passphrase`: the bundle rule, metadata readable and content
   * not (story 107). Each media file is sealed whole, one at a time.
   */
  sealContent?: boolean
  /** Seals the people, and the content with `sealContent`; needed when either travels sealed. */
  passphrase?: string
  package?: { name?: string; version?: string }
}

export interface SiteExportResult {
  out: string
  bundleId: string
  package: { name: string; version: string }
  counts: Record<string, number>
  sections: Partial<Record<keyof typeof BUNDLE_SECTIONS, number>>
  media: { carried: number; bytes: number; missing: string[]; omitted: boolean }
  people: { members: number; users: number }
  /** How many distinct email addresses `--anonymise` replaced. */
  anonymised?: number
}

/** The content kinds a whole site carries, each from its tree's top. */
const SITE_TREES = [
  ObjectTypes.Document,
  ObjectTypes.Media,
  ObjectTypes.Element,
  ObjectTypes.DocumentBlueprint,
]

async function topLevelNodes(db: Db): Promise<NodeRow[]> {
  const nodes = new NodeRepository(db)
  const roots: NodeRow[] = []
  for (const tree of SITE_TREES) {
    for (let skip = 0; ; skip += 500) {
      const page = await nodes.roots(tree, skip, 500)
      roots.push(...page.items)
      if (skip + 500 >= page.total) break
    }
  }
  return roots
}

/** The server bundles the site wires, by package name and version. */
function requiredPackages(config: CromboloConfig): Record<string, string> {
  if (config.bundles.length === 0) return {}
  const wired = new Set(config.bundles.map((bundle) => bundle.id))
  const required: Record<string, string> = {}
  for (const found of discoverBundles(config.siteDir).bundles)
    if (wired.has(found.id)) required[found.packageName] = found.version
  return required
}

export async function exportSite(
  db: Db,
  config: CromboloConfig,
  options: SiteExportOptions,
): Promise<SiteExportResult> {
  const withMedia = options.media !== false && options.media !== 'referenced'
  const carryMembers = Boolean(options.withMembers)
  // Anonymised users are removed, so there are none to carry.
  const carryUsers = Boolean(options.withUsers) && !options.anonymise
  if ((carryMembers || carryUsers) && !options.passphrase)
    throw new Error('Members and users travel sealed: give a passphrase.')
  if (options.sealContent && !options.passphrase)
    throw new Error('Sealed content needs a passphrase.')

  const exported = await exportBundle(db, {
    roots: await topLevelNodes(db),
    asGiven: [],
    descendants: true,
    snapshot: options.drafts ? 'drafts' : 'published',
    blueprints: true,
    withBlobs: withMedia,
    siteName: config.siteName,
    nodeId: config.nodeId,
  })

  let sections: BundleFile[] = await siteSections(
    {
      db,
      componentFiles: createTemplateFileStore(config.componentsDir),
      components: createFileSystemPort(config.componentsDir, {
        extension: '.tsx',
        rewrites: ['.cshtml'],
      }),
      stylesheets: createFileSystemPort(config.stylesheetsDir, { extension: '.css' }),
      scripts: createFileSystemPort(config.scriptsDir, { extension: '.js' }),
      schemaDir: config.schemaDir,
    },
    'all',
  )

  let set = exported.set
  let people =
    carryMembers || carryUsers
      ? await exportPeople(db, { members: carryMembers, users: carryUsers })
      : undefined
  let anonymised: number | undefined
  if (options.anonymise) {
    const dictionaryPath = `${BUNDLE_SECTIONS.dictionary}.udt`
    const dictionary = sections.find((file) => file.path === dictionaryPath)
    const clean = sanitise({ set, people, dictionary: dictionary?.text })
    set = clean.set
    people = clean.people
    anonymised = clean.emails
    if (dictionary && clean.dictionary !== undefined)
      sections = sections.map((file) =>
        file.path === dictionaryPath ? { ...file, text: clean.dictionary } : file,
      )
  }

  // Each media file is looked up once: its size goes in the manifest now, its
  // bytes stream into the tarball later.
  const store = await mediaStoreFor(config)
  const stored = new Map<string, StoredFile>()
  const missing: string[] = []
  // Referenced, each file is named with its size and etag, so the far side can
  // fetch it — or skip it, holding one with the same etag already.
  const described = new Map<string, { size: number; etag: string }>()
  if (withMedia || options.media === 'referenced')
    for (const key of exported.blobKeys) {
      const file = await store.get(key)
      if (!file) missing.push(key)
      else if (withMedia) stored.set(key, file)
      else described.set(key, { size: file.size, etag: file.etag })
    }

  const site = {
    ...set,
    manifest: {
      ...set.manifest,
      blobs: set.manifest.blobs.map((blob) => {
        const found = described.get(blob.key)
        return found ? { ...blob, size: found.size, etag: found.etag } : blob
      }),
      label: `${config.siteName} (whole site)`,
      provenance: { ...set.manifest.provenance, cmsVersion: VERSION },
      scope: 'site' as const,
      ...(withMedia
        ? {}
        : {
            media: options.media === 'referenced' ? ('referenced' as const) : ('omitted' as const),
          }),
      requires: requiredPackages(config),
    },
  }
  const seal =
    (people || options.sealContent) && options.passphrase ? newSeal(options.passphrase) : undefined
  const planned = planStreamedBundle(
    site,
    new Map([...stored].map(([key, file]) => [key, file.size])),
    sections,
    { people, seal, content: options.sealContent ? 'sealed' : 'open' },
  )

  const name = options.package?.name ?? packageNameFor(`${config.siteName}-site`)
  const info: BundlePackageInfo = {
    name,
    version: options.package?.version ?? '1.0.0',
    id: bundleIdFor(name.replace(/^@[^/]+\//, '')),
    label: site.manifest.label,
    private: true,
    peerRange: `>=${VERSION}`,
  }

  const partial = `${options.out}.partial`
  const writer = TarballWriter.create(partial)
  const encoder = new TextEncoder()
  const hasher = new Bun.CryptoHasher('sha256')
  let bytes = 0
  try {
    const small = new Map(planned.files.map((file) => [file.path, file]))
    const blobs = new Map(planned.blobs.map((key) => [blobPath(key), key]))
    const paths = [...small.keys(), ...blobs.keys()].sort((a, b) => a.localeCompare(b))
    for (const path of paths) {
      hasher.update(path)
      hasher.update('\0')
      const file = small.get(path)
      if (file) {
        const body = file.bytes ?? encoder.encode(file.text ?? '')
        hasher.update(body)
        await writer.add(`${PAYLOAD_DIR}/${path}`, body)
      } else {
        const media = stored.get(blobs.get(path) as string) as StoredFile
        if (planned.sealing && seal) {
          const sealed = sealBytes(seal.key, path, await media.bytes())
          hasher.update(sealed)
          hasher.update('\n')
          await writer.add(`${PAYLOAD_DIR}/${path}`, sealed)
          bytes += media.size
          continue
        }
        async function* hashed() {
          for await (const chunk of streamOf(media)) {
            hasher.update(chunk)
            yield chunk
          }
        }
        await writer.addStream(`${PAYLOAD_DIR}/${path}`, media.size, hashed())
        bytes += media.size
      }
      hasher.update('\n')
    }
    const manifest = { ...planned.manifest, integrity: `sha256-${hasher.digest('hex')}` }
    await writer.add(`${PAYLOAD_DIR}/${MANIFEST_FILE}`, encoder.encode(writeManifest(manifest)))
    await writer.add(
      'package.json',
      encoder.encode(`${JSON.stringify(bundlePackageJson(info), null, 2)}\n`),
    )
    await writer.close()
    await rename(partial, options.out)
  } catch (error) {
    await writer.close().catch(() => {})
    await rm(partial, { force: true })
    throw error
  }

  const counted: SiteExportResult['sections'] = {}
  for (const file of sections) {
    const section = (Object.keys(BUNDLE_SECTIONS) as (keyof typeof BUNDLE_SECTIONS)[]).find(
      (s) => file.path === `${BUNDLE_SECTIONS[s]}.udt` || file.path.startsWith(`${s}/`),
    )
    if (section) counted[section] = (counted[section] ?? 0) + 1
  }
  return {
    out: options.out,
    bundleId: site.manifest.id,
    package: { name: info.name, version: info.version },
    counts: { ...site.manifest.counts },
    sections: counted,
    media: { carried: stored.size, bytes, missing, omitted: !withMedia },
    people: { members: people?.members.length ?? 0, users: people?.users.length ?? 0 },
    ...(anonymised !== undefined ? { anonymised } : {}),
  }
}
