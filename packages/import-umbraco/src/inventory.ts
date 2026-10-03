/**
 * Everything in the source that is not schema or content: what the importer
 * carries as files, what it does not import yet, and what has no equivalent.
 */
import type { Findings } from './findings.ts'
import type { ConvertedSchema } from './schema.ts'
import type { SiteFiles } from './site-files.ts'
import { key, type Source } from './source.ts'
import { UPGRADE_STATE_KEY } from './version.ts'

/** A dictionary item, in the shape the `.udt` writer takes. */
export interface DictionaryItem {
  key: string
  name: string
  translations: Array<{ isoCode: string; translation: string }>
  children: DictionaryItem[]
}

/** A hostname binding, in the shape `domains.toml` holds. */
export interface DomainEntry {
  /** The page's uuid. */
  node: string
  host: string
  culture?: string
  defaultCulture?: string
}

/** Tables Umbraco itself creates, 15 to 18. Anything else belongs to a package or to the site. */
const CORE_TABLES = new Set(
  [
    '__EFMigrationsHistory',
    'cmsContentNu',
    'cmsContentType',
    'cmsContentType2ContentType',
    'cmsContentTypeAllowedContentType',
    'cmsDictionary',
    'cmsDocumentType',
    'cmsLanguageText',
    'cmsMember',
    'cmsMember2MemberGroup',
    'cmsMemberType',
    'cmsPropertyType',
    'cmsPropertyTypeGroup',
    'cmsTagRelationship',
    'cmsTags',
    'cmsTemplate',
    ...[
      'Access',
      'AccessRule',
      'Audit',
      'CacheInstruction',
      'Consent',
      'Content',
      'ContentSchedule',
      'ContentVersion',
      'ContentVersionCleanupPolicy',
      'ContentVersionCultureVariation',
      'CreatedPackageSchema',
      'DataType',
      'DistributedJob',
      'Document',
      'DocumentCultureVariation',
      'DocumentUrl',
      'DocumentUrlAlias',
      'DocumentVersion',
      'Domain',
      'Element',
      'ElementCultureVariation',
      'ElementVersion',
      'ExternalLogin',
      'ExternalLoginToken',
      'ExternalMember',
      'ExternalMember2MemberGroup',
      'KeyValue',
      'Language',
      'LastSynced',
      'Lock',
      'Log',
      'LogViewerQuery',
      'LongRunningOperation',
      'MediaVersion',
      'Node',
      'OpenIddictApplications',
      'OpenIddictAuthorizations',
      'OpenIddictScopes',
      'OpenIddictTokens',
      'PropertyData',
      'RedirectUrl',
      'Relation',
      'RelationType',
      'RepositoryCacheVersion',
      'Server',
      'TwoFactorLogin',
      'User',
      'User2ClientId',
      'User2NodeNotify',
      'User2UserGroup',
      'UserData',
      'UserGroup',
      'UserGroup2App',
      'UserGroup2GranularPermission',
      'UserGroup2Language',
      'UserGroup2Node',
      'UserGroup2NodePermission',
      'UserGroup2Permission',
      'UserLogin',
      'UserStartNode',
      'Webhook',
      'Webhook2ContentTypeKeys',
      'Webhook2Events',
      'Webhook2Headers',
      'WebhookLog',
      'WebhookRequest',
    ].map((name) => `umbraco${name}`),
  ].map((name) => name.toLowerCase()),
)

/** Packages recognisable from the tables they create. */
const KNOWN_PACKAGES: Array<[prefix: string, name: string, loss: string]> = [
  [
    'umbracocommerce',
    'Umbraco Commerce',
    'the shop: products’ prices and stock, orders, carts, payment and shipping',
  ],
  ['vendr', 'Vendr', 'the shop: orders, carts, payment and shipping'],
  ['ufforms', 'Umbraco Forms', 'forms and their recorded entries'],
  ['ufrecord', 'Umbraco Forms', 'forms and their recorded entries'],
  ['ufworkflow', 'Umbraco Forms', 'forms and their recorded entries'],
  ['ufuser', 'Umbraco Forms', 'forms and their recorded entries'],
  [
    'umbracodeploy',
    'Umbraco Deploy',
    'deployment between environments; content transfer here is `bunbraco content export`',
  ],
  ['umbracoworkflow', 'Umbraco Workflow', 'approval workflows'],
  ['skybrudredirects', 'Skybrud Redirects', 'its redirect rules'],
  ['umbracoproductlicense', 'Umbraco product licences', 'nothing; licences do not apply here'],
  ['seochecker', 'SEO Checker', 'its redirects and validation data'],
]

const NUGET_NOT_PACKAGES = /^(Umbraco\.Cms(\.|\s|$)|Microsoft\.|System\.)/i

export interface Inventory {
  dictionary: DictionaryItem[]
  domains: DomainEntry[]
  /** The paths the source site served, in its default language. */
  urls: string[]
}

/**
 * Every published page's path, from the URL segments Umbraco recorded.
 *
 * Covers the first site in the tree, in the default language, with the root
 * page at `/` — Umbraco's default, and how pages are routed here. A page with
 * no template is left out, as Umbraco does not serve one either. It is the
 * list the imported site is checked against, so parity is measured.
 */
export function sourceUrls(source: Source): string[] {
  if (!source.hasColumn('umbracoDocumentUrl', 'urlSegment')) return []
  const language = source.one<{ id: number }>(
    'SELECT id FROM umbracoLanguage WHERE isDefaultVariantLang = 1',
  )
  if (!language) return []
  const primary = source.hasColumn('umbracoDocumentUrl', 'isPrimary') ? 'AND u.isPrimary = 1' : ''
  // A page with no template has a URL segment and no URL: Umbraco answers 404 for it.
  const rows = source.all<{
    id: number
    parentId: number
    segment: string
    templateId: number | null
  }>(
    `SELECT n.id AS id, n.parentId AS parentId, u.urlSegment AS segment, dv.templateId AS templateId
     FROM umbracoDocumentUrl u
     JOIN umbracoNode n ON lower(n.uniqueId) = lower(u.uniqueId)
     JOIN umbracoDocument d ON d.nodeId = n.id
     JOIN umbracoContentVersion cv ON cv.nodeId = n.id
     JOIN umbracoDocumentVersion dv ON dv.id = cv.id AND dv.published = 1
     WHERE u.isDraft = 0 AND u.languageId = ? AND d.published = 1 AND n.trashed = 0 ${primary}
     ORDER BY n.level, n.sortOrder, n.id`,
    language.id,
  )
  const byId = new Map(rows.map((row) => [Number(row.id), row]))
  const root = rows.find((row) => Number(row.parentId) === -1)
  if (!root) return []
  const urls: string[] = []
  for (const row of rows) {
    const segments: string[] = []
    let at: (typeof rows)[number] | undefined = row
    for (let depth = 0; at && Number(at.id) !== Number(root.id) && depth < 64; depth++) {
      segments.unshift(at.segment)
      at = byId.get(Number(at.parentId))
    }
    // Reached the root page, so it is part of this site and every ancestor is published.
    if (at && row.templateId !== null) urls.push(`/${segments.join('/')}`)
  }
  return urls
}

export function takeInventory(
  source: Source,
  schema: ConvertedSchema,
  files: SiteFiles | undefined,
  findings: Findings,
): Inventory {
  // Dictionary
  const dictionary: DictionaryItem[] = []
  let dictionaryCount = 0
  if (source.has('cmsDictionary')) {
    const texts = source.has('cmsLanguageText')
      ? source.all<{ languageId: number; id: string; value: string | null }>(
          'SELECT languageId, UniqueId AS id, value FROM cmsLanguageText',
        )
      : []
    const rows = source.all<{ id: string; parent: string | null; name: string }>(
      'SELECT id, parent, "key" AS name FROM cmsDictionary ORDER BY "key"',
    )
    dictionaryCount = rows.length
    const items = new Map<string, DictionaryItem>()
    for (const row of rows)
      items.set(key(row.id), {
        key: key(row.id),
        name: row.name,
        translations: texts
          .filter((t) => key(t.id) === key(row.id) && t.value !== null)
          .flatMap((t) => {
            const iso = schema.languages.get(Number(t.languageId))?.iso
            return iso ? [{ isoCode: iso, translation: t.value as string }] : []
          }),
        children: [],
      })
    for (const row of rows) {
      const item = items.get(key(row.id)) as DictionaryItem
      const parent = row.parent ? items.get(key(row.parent)) : undefined
      if (parent) parent.children.push(item)
      else dictionary.push(item)
    }
  }
  findings.some({
    class: 'migrates',
    code: 'dictionary',
    title: 'Dictionary items',
    detail: 'Written to import/dictionary.udt; `bunbraco dictionary import` applies it.',
    count: dictionaryCount,
  })

  // Hostnames
  const domains: DomainEntry[] = []
  if (source.has('umbracoDomain')) {
    const nodeKeys = new Map(
      source
        .all<{ id: number; key: string }>('SELECT id, uniqueId AS key FROM umbracoNode')
        .map((row) => [Number(row.id), key(row.key)]),
    )
    for (const row of source.all<{
      languageId: number | null
      nodeId: number | null
      name: string
    }>(
      'SELECT domainDefaultLanguage AS languageId, domainRootStructureID AS nodeId, domainName AS name FROM umbracoDomain ORDER BY sortOrder, id',
    )) {
      const node = row.nodeId === null ? undefined : nodeKeys.get(Number(row.nodeId))
      if (!node) continue
      const culture =
        row.languageId === null ? undefined : schema.languages.get(Number(row.languageId))?.iso
      // A name starting `*` is Umbraco's way of setting a node's culture without a hostname.
      if (row.name.startsWith('*')) domains.push({ node, host: '', defaultCulture: culture })
      else domains.push({ node, host: row.name, culture })
    }
  }
  findings.some({
    class: 'needs-a-person',
    code: 'domains',
    title: 'Hostnames and cultures',
    detail:
      'Written to import/domains.toml, not applied: they are the source site’s hostnames. Review them, then move the file to the site root.',
    count: domains.length,
    items: domains.map((d) => d.host || `(culture ${d.defaultCulture ?? 'default'})`),
  })

  // What a later version of the importer could carry, and this one does not.
  const notYet = (code: string, title: string, count: number, detail: string) =>
    findings.some({ class: 'not-yet', code, title, count, detail })
  notYet(
    'members',
    'Members',
    source.count('cmsMember'),
    'Members, their groups and their passwords are not imported. Member types are.',
  )
  notYet(
    'users',
    'Backoffice users',
    source.count('umbracoUser', 'id > 0'),
    'Users and user groups are not imported. `bunbraco start` creates an administrator.',
  )
  notYet(
    'redirects',
    'Redirects',
    source.count('umbracoRedirectUrl'),
    'Redirects Umbraco recorded when pages moved are not imported.',
  )
  notYet(
    'public-access',
    'Protected pages',
    source.count('umbracoAccess'),
    'Public access rules are not imported: these pages will be public until the rules are set again.',
  )
  notYet(
    'schedules',
    'Scheduled publishes',
    source.count('umbracoContentSchedule'),
    'Pending publish and unpublish dates are not imported.',
  )

  // What has no equivalent.
  findings.some({
    class: 'cannot-migrate',
    code: 'webhooks',
    title: 'Webhooks',
    count: source.count('umbracoWebhook'),
  })
  findings.some({
    class: 'cannot-migrate',
    code: 'external-logins',
    title: 'External and two-factor logins',
    count: source.count('umbracoExternalLogin') + source.count('umbracoTwoFactorLogin'),
  })

  // Packages, from the tables they made and the migration plans they recorded.
  const packages = new Map<string, { loss?: string; tables: string[] }>()
  const other: string[] = []
  for (const table of source.tables) {
    const lower = table.toLowerCase()
    if (CORE_TABLES.has(lower)) continue
    const known = KNOWN_PACKAGES.find(([prefix]) => lower.startsWith(prefix))
    if (!known) {
      other.push(table)
      continue
    }
    const entry = packages.get(known[1]) ?? { loss: known[2], tables: [] }
    entry.tables.push(table)
    packages.set(known[1], entry)
  }
  for (const [name, entry] of packages)
    findings.add({
      class: 'cannot-migrate',
      code: 'package',
      title: `Package: ${name}`,
      detail: `Packages do not run here. What goes with it: ${entry.loss}. Its ${entry.tables.length} table(s) are not imported.`,
      count: entry.tables.length,
      items: entry.tables,
    })
  findings.some({
    class: 'cannot-migrate',
    code: 'other-tables',
    title: 'Tables that are not Umbraco’s own',
    detail: 'Created by a package or by the site’s own code. They are not imported.',
    count: other.length,
    items: other,
  })

  if (source.has('umbracoKeyValue')) {
    const plans = source
      .all<{ key: string }>(
        `SELECT "key" AS key FROM umbracoKeyValue WHERE "key" LIKE 'Umbraco.Core.Upgrader.State+%'`,
      )
      .map((row) => row.key.slice('Umbraco.Core.Upgrader.State+'.length))
      .filter(
        (name) =>
          `Umbraco.Core.Upgrader.State+${name}` !== UPGRADE_STATE_KEY &&
          name !== 'Umbraco.Core.Premigrations',
      )
    findings.some({
      class: 'cannot-migrate',
      code: 'package-migrations',
      title: 'Packages that have run migrations on this database',
      detail: 'Each has installed something server-side. None of it runs here.',
      count: plans.length,
      items: plans,
    })
  }
  findings.some({
    class: 'cannot-migrate',
    code: 'created-packages',
    title: 'Packages created in the backoffice',
    count: source.count('umbracoCreatedPackageSchema'),
  })

  // What only the site's files can say.
  if (files) {
    const nuget = files.packages.filter((name) => !NUGET_NOT_PACKAGES.test(name))
    findings.some({
      class: 'cannot-migrate',
      code: 'nuget-packages',
      title: 'NuGet packages the project references',
      detail:
        '.NET packages do not run here; each one’s behaviour has to be replaced or done without.',
      count: nuget.length,
      items: nuget,
    })
    findings.some({
      class: 'cannot-migrate',
      code: 'app-plugins',
      title: 'Backoffice plugins in App_Plugins',
      detail:
        'A plugin that is client-side only may work if copied into the new site’s App_Plugins; one with a server side will not.',
      count: files.plugins.length,
      items: files.plugins,
    })
    findings.some({
      class: 'cannot-migrate',
      code: 'custom-code',
      title: 'C# source files',
      detail: 'Controllers, composers, notification handlers and view models have to be rewritten.',
      count: files.csharp,
    })
  } else {
    findings.add({
      class: 'needs-a-person',
      code: 'no-site-files',
      title: 'The site’s files were not given',
      detail:
        'Without --site the Razor views, media files, plugins and custom code could not be inspected. Views are stubbed from the database, and media has no files behind it.',
    })
  }

  return { dictionary, domains, urls: sourceUrls(source) }
}
