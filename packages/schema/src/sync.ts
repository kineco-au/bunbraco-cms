/**
 * Files → database. Version-gated, locked, and never destructive: removal is
 * retirement, and a type with content refuses to disappear. The algorithm and
 * the multi-node rules are in docs/09-schema-as-code.md, "Synchronisation".
 */
import { type ContentTypeAggregate, ObjectTypes, type PropertyTypeModel } from '@bunbraco/core'
import {
  appendCacheInstruction,
  appendSchemaState,
  BUILT_IN_MEDIA_TYPES,
  ContentTypeRepository,
  compareStates,
  currentSchemaState,
  DataTypeRepository,
  type Db,
  DbDate,
  FolderRepository,
  LanguageRepository,
  Locks,
  latestPreparedState,
  makeStateCurrent,
  type NodeSchemaState,
  type SchemaStateRow,
  SYSTEM_MEDIA_TYPES,
  SYSTEM_MEMBER_TYPE,
  TemplateRepository,
  updateSchemaStateHash,
} from '@bunbraco/data'
import { BUILTIN_DATA_TYPES, storageTypeFor } from './builtin.ts'
import { hashSchemaSet, type LoadedSchema } from './load.ts'
import {
  allProperties,
  type SchemaDocumentType,
  type SchemaProblem,
  type SchemaProperty,
  type SchemaSet,
  typeFileKey,
} from './model.ts'
import { validateSchemaSet } from './validate.ts'

export interface SyncNode extends NodeSchemaState {
  nodeId: string
}

export interface SyncOptions {
  mode: 'development' | 'production'
  /** Template aliases that exist as view files. */
  templateAliases?: ReadonlySet<string>
  /** Retire a type even though documents of it exist. */
  forceRetireTypes?: boolean
  /** Compute the report and roll back: `schema check`. */
  dryRun?: boolean
  /**
   * `prepared` creates everything under a state no live node has reached, so it
   * is pending everywhere until `upgrade` makes the state current. Default current.
   */
  status?: 'prepared' | 'current'
}

export type SyncAction = 'applied' | 'would-apply' | 'skipped-older' | 'skipped-same' | 'refused'

export interface SyncReportBase {
  /** Existing properties whose data type change was deferred to the cut-over (prepared syncs only). */
  deferred: string[]
}

/** A key the sync minted or recovered for an element whose file has none. */
export interface AssignedKey {
  file: string
  typeAlias: string
  /** Undefined for the type itself. */
  propertyAlias?: string
  key: string
  /** True when the key belongs to a retired property that was revived by alias. */
  revived: boolean
}

export interface SyncReport {
  action: SyncAction
  reason?: string
  problems: SchemaProblem[]
  state?: { id: number; version: string; revision: string }
  created: { types: number; properties: number; dataTypes: number; languages: number }
  updated: { types: number; dataTypes: number; languages: number }
  retired: string[]
  retiredTypes: string[]
  revived: string[]
  assignedKeys: AssignedKey[]
  deferred: string[]
}

export const emptySyncReport = (
  action: SyncAction,
  extra: Partial<SyncReport> = {},
): SyncReport => ({
  action,
  problems: [],
  created: { types: 0, properties: 0, dataTypes: 0, languages: 0 },
  updated: { types: 0, dataTypes: 0, languages: 0 },
  retired: [],
  retiredTypes: [],
  revived: [],
  assignedKeys: [],
  deferred: [],
  ...extra,
})

/** Composition dependencies first. Cycles were rejected by validation. */
function inCompositionOrder(types: readonly SchemaDocumentType[]): SchemaDocumentType[] {
  const byAlias = new Map(types.map((t) => [t.alias, t]))
  const done = new Set<string>()
  const out: SchemaDocumentType[] = []
  const visit = (t: SchemaDocumentType) => {
    if (done.has(t.alias)) return
    done.add(t.alias)
    for (const c of t.compositions) {
      const dep = byAlias.get(c)
      if (dep) visit(dep)
    }
    out.push(t)
  }
  for (const t of types) visit(t)
  return out
}

export async function syncSchema(
  db: Db,
  loaded: LoadedSchema,
  node: SyncNode,
  options: SyncOptions,
): Promise<SyncReport> {
  const problems = [
    ...loaded.problems,
    ...validateSchemaSet(loaded.set, { templateAliases: options.templateAliases }),
  ]
  if (problems.length > 0)
    return emptySyncReport('refused', { reason: 'the schema has problems', problems })

  const set = loaded.set
  if (options.mode === 'production') {
    const missing = elementsWithoutKeys(set)
    if (missing.length > 0)
      return emptySyncReport('refused', {
        reason: `production requires every element to carry a key; run \`bunbraco schema sync\` in development to assign them: ${missing.join(', ')}`,
      })
  }
  const hash = hashSchemaSet(set)
  const fileState: NodeSchemaState = { version: set.version, revision: node.revision }

  return db.locks
    .withLock(Locks.Schema, async () =>
      db.transaction(async (tx) => {
        const current = await currentSchemaState(tx, true)
        const prepared = await latestPreparedState(tx)
        const preparedHere =
          prepared && prepared.id > current.id && compareStates(prepared, fileState) === 0
            ? prepared
            : undefined
        const status = options.status ?? 'current'
        // An early fix already created this state: a second fix is a no-op, and a
        // current sync of the same files is the cut-over.
        if (preparedHere && status === 'prepared' && preparedHere.hash === hash)
          return emptySyncReport('skipped-same', {
            state: {
              id: preparedHere.id,
              version: preparedHere.version,
              revision: preparedHere.revision,
            },
          })
        const cutOver = preparedHere !== undefined && status === 'current'
        const cmp = compareStates(fileState, current)
        const neverSynced = current.hash === null
        if (cmp < 0)
          return emptySyncReport('skipped-older', {
            reason: `files are at ${fileState.version}+${fileState.revision}, database at ${current.version}+${current.revision}; running in compatibility mode`,
          })
        if (cmp === 0 && !neverSynced && !cutOver) {
          if (hash === current.hash) return emptySyncReport('skipped-same')
          if (options.mode === 'production')
            return emptySyncReport('refused', {
              reason: `schema changed without a version bump (still ${set.version}); bump schema/schema.toml or deploy with a newer revision`,
            })
        }

        const report = emptySyncReport('applied')
        const state = cutOver
          ? (preparedHere as SchemaStateRow)
          : await appendSchemaState(tx, {
              version: set.version,
              revision: node.revision,
              hash,
              status,
              by: node.nodeId,
            })
        report.state = { id: state.id, version: state.version, revision: state.revision }

        const dataTypes = new DataTypeRepository(tx)
        const typeFolders = new FolderRepository(
          tx,
          ObjectTypes.DocumentTypeContainer,
          ObjectTypes.DocumentType,
        )
        const dataTypeFolders = new FolderRepository(
          tx,
          ObjectTypes.DataTypeContainer,
          ObjectTypes.DataType,
        )
        const folderKey = (repo: FolderRepository, folder: string | undefined) =>
          folder
            ? repo.ensurePath(
                folder
                  .split('/')
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            : Promise.resolve(null)
        const types = new ContentTypeRepository(tx)
        const templates = new TemplateRepository(tx)
        const languages = new LanguageRepository(tx)

        // ---- data types: built-ins are seeded; files add or override by alias
        for (const d of set.dataTypes) {
          const existing = await dataTypes.byAlias(d.alias)
          const builtin = BUILTIN_DATA_TYPES.find((b) => b.alias === d.alias)
          const key = d.key ?? existing?.key ?? crypto.randomUUID()
          if (!d.key && !existing)
            report.assignedKeys.push({
              file: loaded.files.get(`data-type:${d.alias}`) ?? '',
              typeAlias: d.alias,
              key,
              revived: false,
            })
          await dataTypes.save({
            key,
            alias: d.alias,
            name: d.name,
            editorAlias: d.editor,
            editorUiAlias: d.editorUi ?? builtin?.editorUi ?? null,
            dbType: existing?.dbType ?? storageTypeFor(d.editor),
            values: Object.entries(d.config).map(([alias, value]) => ({ alias, value })),
            parentKey: existing?.parentKey ?? (await folderKey(dataTypeFolders, d.folder)),
          })
          if (existing) report.updated.dataTypes += 1
          else report.created.dataTypes += 1
        }
        const dataTypeKeyByAlias = new Map<string, string>()
        for (const alias of new Set([
          ...BUILTIN_DATA_TYPES.map((b) => b.alias),
          ...set.dataTypes.map((d) => d.alias),
        ])) {
          const found = await dataTypes.byAlias(alias)
          if (found) dataTypeKeyByAlias.set(alias, found.key)
        }

        // ---- languages
        if (set.languages.length > 0) {
          const result = await languages.upsertAll(
            set.languages.map((l) => ({
              isoCode: l.iso,
              cultureName: l.name,
              isDefault: l.default,
              isMandatory: l.mandatory,
              fallbackIsoCode: l.fallback ?? null,
            })),
          )
          report.created.languages += result.created
          report.updated.languages += result.updated
        }

        // ---- templates referenced by types must have a row
        const templateKeyByAlias = new Map<string, string>()
        for (const alias of new Set(set.documentTypes.flatMap((t) => t.templates))) {
          const existing = await templates.byAlias(alias)
          const key = existing?.key ?? crypto.randomUUID()
          if (!existing) await templates.save({ key, name: alias, alias, content: null })
          templateKeyByAlias.set(alias, key)
        }

        // Document types, then media types: one table, two kinds, the same rules.
        const kinds = [
          {
            name: 'document' as const,
            types: set.documentTypes,
            repo: types,
            folders: typeFolders,
            noun: 'document type',
            items: 'document(s)',
          },
          {
            name: 'media' as const,
            types: set.mediaTypes ?? [],
            repo: new ContentTypeRepository(tx, { kind: 'media' }),
            folders: new FolderRepository(
              tx,
              ObjectTypes.MediaTypeContainer,
              ObjectTypes.MediaType,
            ),
            noun: 'media type',
            items: 'media item(s)',
          },
          {
            name: 'member' as const,
            types: set.memberTypes ?? [],
            repo: new ContentTypeRepository(tx, { kind: 'member' }),
            folders: new FolderRepository(
              tx,
              ObjectTypes.MemberTypeContainer,
              ObjectTypes.MemberType,
            ),
            noun: 'member type',
            items: 'member(s)',
          },
        ]
        // Umbraco's fixed keys for the built-in media types' groups, so a site's
        // video.toml keeps the key Umbraco gave its "Video" group.
        const fixedGroupKeys = new Map(
          BUILT_IN_MEDIA_TYPES.flatMap((t) =>
            t.group ? [[`${t.alias}|${t.group.name}`, t.group.key] as const] : [],
          ),
        )
        for (const kind of kinds) {
          // ---- types: resolve keys, then save in composition order, twice
          // (allowed children may reference types created later in the order)
          const typeKeyByAlias = new Map<string, string>(
            kind.name === 'media'
              ? SYSTEM_MEDIA_TYPES.map((t) => [t.alias, t.key])
              : kind.name === 'member'
                ? [[SYSTEM_MEMBER_TYPE.alias, SYSTEM_MEMBER_TYPE.key]]
                : [],
          )
          const aggregates: Array<{
            file: string
            type: SchemaDocumentType
            aggregate: ContentTypeAggregate
          }> = []
          for (const t of inCompositionOrder(kind.types)) {
            const file = loaded.files.get(typeFileKey(kind.name, t.alias)) ?? ''
            const existing = t.key
              ? await kind.repo.byKey(t.key)
              : await kind.repo.byAlias(t.alias, { includeRetired: true })
            const key = t.key ?? existing?.key ?? crypto.randomUUID()
            if (!t.key && !existing)
              report.assignedKeys.push({ file, typeAlias: t.alias, key, revived: false })
            typeKeyByAlias.set(t.alias, key)
            const retired = existing ? await kind.repo.retiredProperties(existing.key) : []
            const liveByAlias = new Map((existing?.properties ?? []).map((p) => [p.alias, p]))

            const containers: ContentTypeAggregate['containers'] = []
            const properties: PropertyTypeModel[] = []
            let sortOrder = 0
            const resolveProperty = (
              p: SchemaProperty,
              containerKey: string | null,
            ): PropertyTypeModel => {
              let key = p.key
              let revived = false
              if (!key) {
                const live = liveByAlias.get(p.alias)
                const back = retired.find((r) => r.alias === p.alias)
                key = live?.key ?? back?.key ?? crypto.randomUUID()
                revived = !live && back !== undefined
                if (!live)
                  report.assignedKeys.push({
                    file,
                    typeAlias: t.alias,
                    propertyAlias: p.alias,
                    key,
                    revived,
                  })
                if (revived) report.revived.push(`${t.alias}.${p.alias}`)
              } else if (retired.some((r) => r.key === key)) {
                report.revived.push(`${t.alias}.${p.alias}`)
              }
              // Under a prepared state an existing property keeps its editor: the old
              // nodes still edit it, and the converted values wait for the cut-over.
              let dataTypeKey = dataTypeKeyByAlias.get(p.type) ?? ''
              const liveProperty = liveByAlias.get(p.alias)
              if (
                status === 'prepared' &&
                liveProperty &&
                liveProperty.dataTypeKey !== dataTypeKey
              ) {
                report.deferred.push(`${t.alias}.${p.alias}`)
                dataTypeKey = liveProperty.dataTypeKey
              }
              // Likewise a property becoming mandatory: old nodes must keep publishing.
              let mandatory = p.mandatory
              if (status === 'prepared' && liveProperty && !liveProperty.mandatory && p.mandatory) {
                report.deferred.push(`${t.alias}.${p.alias} (mandatory)`)
                mandatory = false
              }
              return {
                key,
                alias: p.alias,
                name: p.name,
                description: p.description ?? null,
                dataTypeKey,
                containerKey,
                sortOrder: sortOrder++,
                variesByCulture: p.variesByCulture,
                variesBySegment: p.variesBySegment,
                mandatory,
                mandatoryMessage: p.mandatoryMessage ?? null,
                regEx: p.regex ?? null,
                sinceVersion: p.since ?? null,
                regExMessage: p.regexMessage ?? null,
                labelOnTop: p.labelOnTop,
                memberCanView: p.memberCanView === true,
                memberCanEdit: p.memberCanEdit === true,
                isSensitive: p.sensitive === true,
              }
            }
            // Groups have no key in the file; they match an existing group of the same name.
            const existingContainers = existing?.containers ?? []
            const containerKeyFor = (
              name: string,
              parentKey: string | null,
              type: 'Tab' | 'Group' = parentKey ? 'Group' : 'Tab',
            ): string =>
              existingContainers.find(
                (c) => c.name === name && (c.parentKey ?? null) === parentKey && c.type === type,
              )?.key ??
              fixedGroupKeys.get(`${t.alias}|${name}`) ??
              crypto.randomUUID()
            for (const p of t.properties) properties.push(resolveProperty(p, null))
            let rootGroupOrder = 0
            for (const g of t.groups ?? []) {
              const groupKey = containerKeyFor(g.name, null, 'Group')
              containers.push({
                key: groupKey,
                name: g.name,
                alias: g.alias ?? null,
                type: 'Group',
                sortOrder: rootGroupOrder++,
                parentKey: null,
              })
              for (const p of g.properties) properties.push(resolveProperty(p, groupKey))
            }
            let tabOrder = 0
            for (const tab of t.tabs) {
              const tabKey = containerKeyFor(tab.name, null)
              containers.push({
                key: tabKey,
                name: tab.name,
                alias: tab.alias ?? null,
                type: 'Tab',
                sortOrder: tabOrder++,
                parentKey: null,
              })
              for (const p of tab.properties) properties.push(resolveProperty(p, tabKey))
              let groupOrder = 0
              for (const g of tab.groups) {
                const groupKey = containerKeyFor(g.name, tabKey)
                containers.push({
                  key: groupKey,
                  name: g.name,
                  alias: g.alias ?? null,
                  type: 'Group',
                  sortOrder: groupOrder++,
                  parentKey: tabKey,
                })
                for (const p of g.properties) properties.push(resolveProperty(p, groupKey))
              }
            }
            aggregates.push({
              file,
              type: t,
              aggregate: {
                key,
                alias: t.alias,
                name: t.name,
                description: t.description ?? null,
                icon: t.icon,
                allowedAsRoot: t.allowAtRoot,
                variesByCulture: t.variesByCulture,
                variesBySegment: t.variesBySegment,
                isElement: t.isElement,
                allowedInLibrary: t.allowInLibrary,
                collectionKey: t.collection ? (dataTypeKeyByAlias.get(t.collection) ?? null) : null,
                sinceVersion: t.since ?? null,
                cleanup: {
                  preventCleanup: t.cleanup.prevent,
                  keepAllVersionsNewerThanDays: t.cleanup.keepAllNewerThanDays ?? null,
                  keepLatestVersionPerDayForDays: t.cleanup.keepLatestPerDayForDays ?? null,
                },
                properties,
                containers,
                compositions: t.compositions.map((alias) => ({
                  contentTypeKey: typeKeyByAlias.get(alias) ?? '',
                  compositionType: 'Composition' as const,
                })),
                allowedContentTypes: [],
                allowedTemplateKeys: t.templates.map(
                  (alias) => templateKeyByAlias.get(alias) ?? '',
                ),
                defaultTemplateKey: t.defaultTemplate
                  ? (templateKeyByAlias.get(t.defaultTemplate) ?? null)
                  : null,
                parentKey:
                  t.folder !== undefined
                    ? await folderKey(kind.folders, t.folder)
                    : (existing?.parentKey ?? null),
              },
            })
            const before = existing
              ? new Set(existing.properties.map((p) => p.alias))
              : new Set<string>()
            if (existing) report.updated.types += 1
            else report.created.types += 1
            report.created.properties += properties.filter((p) => !before.has(p.alias)).length
            for (const alias of before) {
              if (allProperties(t).some((p) => p.alias === alias)) continue
              if (status === 'prepared') {
                // Old nodes keep editing it until the cut-over retires it.
                const live = existing?.properties.find((p) => p.alias === alias)
                if (live) properties.push({ ...live, sortOrder: sortOrder++ })
                report.deferred.push(`${t.alias}.${alias} (retire)`)
              } else report.retired.push(`${t.alias}.${alias}`)
            }
          }
          for (const { aggregate } of aggregates)
            await kind.repo.save(aggregate, { sinceStateId: state.id })
          for (const { type, aggregate } of aggregates) {
            if (type.allowChildren.length === 0) continue
            await kind.repo.save(
              {
                ...aggregate,
                allowedContentTypes: type.allowChildren.map((alias, sortOrder) => ({
                  contentTypeKey: typeKeyByAlias.get(alias) ?? '',
                  sortOrder,
                })),
              },
              { sinceStateId: state.id },
            )
          }

          // ---- types in the database but not in files: retire, unless they have content
          const inFiles = new Set(typeKeyByAlias.values())
          const dbTypes = await tx.query<{ unique_id: string; alias: string }>(
            'SELECT n.unique_id, ct.alias FROM content_type ct JOIN node n ON n.id = ct.node_id WHERE ct.retired_at IS NULL AND n.node_object_type = ?',
            [kind.repo.objectType],
          )
          for (const row of dbTypes) {
            const key = String(row.unique_id).toLowerCase()
            if (inFiles.has(key)) continue
            // Shipped with the framework: present whether or not a file defines it.
            if (SYSTEM_MEDIA_TYPES.some((t) => t.key === key)) continue
            if (key === SYSTEM_MEMBER_TYPE.key) continue
            if (status === 'prepared') {
              report.deferred.push(`${row.alias} (retire type)`)
              continue
            }
            const count = await kind.repo.contentCount(key)
            if (count > 0 && !options.forceRetireTypes) {
              throw new SchemaSyncRefused(
                `${kind.noun} "${row.alias}" was removed from schema/ but ${count} ${kind.items} of it exist; restore the file, or retire it deliberately with --force-retire-types`,
              )
            }
            await tx.exec(
              'UPDATE content_type SET retired_at = ? WHERE node_id = (SELECT id FROM node WHERE unique_id = ?)',
              [DbDate.toDb(new Date()), key],
            )
            report.retiredTypes.push(String(row.alias))
          }
        }

        if (cutOver) {
          await makeStateCurrent(tx, state.id)
          await updateSchemaStateHash(tx, state.id, hash)
        }
        await appendCacheInstruction(tx, {
          kind: 'schema',
          payload: { stateId: state.id },
          by: node.nodeId,
        })
        if (options.dryRun) throw new DryRun(report)
        return report
      }),
    )
    .catch((error: unknown) => {
      if (error instanceof SchemaSyncRefused)
        return emptySyncReport('refused', { reason: error.message })
      if (error instanceof DryRun) return { ...error.report, action: 'would-apply' as const }
      throw error
    })
}

export class SchemaSyncRefused extends Error {}

class DryRun extends Error {
  constructor(readonly report: SyncReport) {
    super('dry run')
  }
}

function elementsWithoutKeys(set: SchemaSet): string[] {
  const missing: string[] = []
  for (const t of [...set.documentTypes, ...(set.mediaTypes ?? []), ...(set.memberTypes ?? [])]) {
    if (!t.key) missing.push(t.alias)
    for (const p of allProperties(t)) if (!p.key) missing.push(`${t.alias}.${p.alias}`)
  }
  for (const d of set.dataTypes) if (!d.key) missing.push(`data-type ${d.alias}`)
  return missing
}
