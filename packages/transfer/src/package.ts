/**
 * A written bundle as the npm package every bundle is: a `package.json` whose
 * `crombolo` field declares the payload, and the payload under `content/`.
 * `docs/bundles.md`.
 *
 * The payload is `writeBundle`'s output unchanged, so its manifest, integrity
 * hash and sections mean what they always did. The package is what gives it a
 * name, a version and a core it was written for.
 */
import { PEOPLE_DIR } from './people.ts'
import type { BundleFile } from './write.ts'

/** The directory inside a package that holds the `bundle.json` payload. */
export const PAYLOAD_DIR = 'content'

/** The npm keyword a bundle publishes so the marketplace can find it. */
export const BUNDLE_KEYWORD = 'crombolo-bundle'

export interface BundlePackageInfo {
  /** The npm package name. */
  name: string
  version: string
  /** `crombolo.id`. */
  id: string
  /** `crombolo.name`, what a person calls it. */
  label: string
  description?: string
  /** A package that is never published: an environment's export. */
  private?: boolean
  /** The range on `@crombolo/crombolo` it is written for. */
  peerRange: string
}

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/** Lowercase words joined by hyphens, from whatever someone named a thing. */
const slug = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/**
 * The core versions a bundle crombolo writes can be installed on: this release
 * or any later one. A newer node reads every older bundle format, so a later
 * release is never a reason to refuse one; an older node is turned away here,
 * by name, before it meets a format it cannot read. Not `^`: before 1.0 a caret
 * pins the minor, and an environment one minor ahead would refuse its own
 * preview's export.
 */
export const bundlePeerRange = (coreVersion: string): string => `>=${coreVersion}`

/** A name npm would accept. */
export function isPackageName(name: string): boolean {
  return NPM_NAME.test(name) && name.length <= 214
}

/** A bundle id, 2–39 characters, derived from a name: what an unset definition defaults to. */
export function bundleIdFor(text: string): string {
  let id = slug(text).replace(/^[^a-z]+/, '')
  if (id.length < 2) id = `bundle-${id}`.replace(/-$/, '')
  return id.slice(0, 39).replace(/-+$/, '')
}

/** An unscoped package name derived from a name. */
export function packageNameFor(text: string): string {
  return bundleIdFor(text)
}

/** The `package.json` a bundle package is written with. */
export function bundlePackageJson(info: BundlePackageInfo): Record<string, unknown> {
  return {
    name: info.name,
    version: info.version,
    ...(info.description ? { description: info.description } : {}),
    ...(info.private ? { private: true } : { keywords: [BUNDLE_KEYWORD] }),
    files: [PAYLOAD_DIR],
    peerDependencies: { '@crombolo/crombolo': info.peerRange },
    crombolo: { id: info.id, name: info.label, content: PAYLOAD_DIR },
  }
}

/** A payload's files, placed into a package under `content/` beside its `package.json`. */
export function writeBundlePackage(
  payload: readonly BundleFile[],
  info: BundlePackageInfo,
): BundleFile[] {
  if (!isPackageName(info.name)) throw new Error(`"${info.name}" is not a package name npm accepts`)
  // Personal data never goes where `npm publish` can take it, sealed or not;
  // and sealed content would be no use to anyone who installed it.
  if (!info.private && payload.some((file) => file.path.startsWith(`${PEOPLE_DIR}/`)))
    throw new Error('A bundle that carries members or users can only be a private package.')
  if (!info.private && payload.some((file) => file.path.startsWith('values/')))
    throw new Error('A bundle whose content is encrypted can only be a private package.')
  return [
    { path: 'package.json', text: `${JSON.stringify(bundlePackageJson(info), null, 2)}\n` },
    ...payload.map((file) => ({ ...file, path: `${PAYLOAD_DIR}/${file.path}` })),
  ]
}
