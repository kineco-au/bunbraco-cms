/**
 * The pre-upgrade check: what would this change do to the data, and what does
 * it need? One function behind `bunbraco upgrade check` and `bunbraco schema
 * check`. Read-only. docs/10-packaging-and-upgrades.md, "Three kinds of finding".
 */
import type { ContentTypeAggregate, PropertyTypeModel } from '@bunbraco/core'
import { DEFAULT_BACKOFFICE_PATH } from '@bunbraco/core'
import {
  bunbracoPlan,
  ContentTypeRepository,
  currentSchemaState,
  DataTypeRepository,
  type Db,
  DocumentRepository,
  type Finding,
  LanguageRepository,
  latestPreparedState,
  pendingMigrations,
  readLedger,
} from '@bunbraco/data'
import { BUILTIN_DATA_TYPES, storageTypeFor } from './builtin.ts'
import type { LoadedSchema } from './load.ts'
import { allProperties, type SchemaDocumentType, type SchemaProperty } from './model.ts'
import {
  emptySyncReport,
  type SyncNode,
  type SyncOptions,
  type SyncReport,
  syncSchema,
} from './sync.ts'
import { findConverter, outputsOf, type ValueMigration } from './value-migrations.ts'

export type ChangeClass = 'none' | 'additive' | 'data-requiring' | 'breaking'

export interface CheckOptions extends Omit<SyncOptions, 'dryRun' | 'status'> {
  /** `--set type.property=value`: a value to apply wherever the property is missing. */
  set?: Record<string, unknown>
  migrations?: readonly ValueMigration[]
  /** Where finding links point. */
  backOfficePath?: string
}

export interface CheckReport {
  findings: Finding[]
  /** Findings an upgrade must not proceed over (everything but the framework's own pending steps). */
  outstanding: Finding[]
  classification: ChangeClass
  /** The dry-run sync of the site diff. */
  sync: SyncReport
  frameworkPending: string[]
  /** False when framework migrations are pending: the site part runs once they have. */
  siteChecked: boolean
}

/** The ledger name of an editor conversion, so a re-run knows it ran. */
export function conversionLedgerName(
  type: string,
  property: string,
  from: string,
  to: string,
): string {
  return `convert:${type}.${property}:${from}->${to}`
}

export interface AffectedProperty {
  type: SchemaDocumentType
  typeAggregate: ContentTypeAggregate
  property: SchemaProperty
  live: PropertyTypeModel | undefined
  /** Editor aliases when the property's editor changes. */
  editorChange?: { from: string; to: string; toStorage: ReturnType<typeof storageTypeFor> }
  /** True when the property is newly mandatory on a type with content — or still pending from an early fix. */
  newlyMandatory: boolean
  /** True when the property has been mandatory and live all along. */
  liveMandatory: boolean
}

/** Every file property whose change needs data work, with what the database has now. */
export async function affectedProperties(
  db: Db,
  loaded: LoadedSchema,
): Promise<AffectedProperty[]> {
  // Relative to the database's own current state, so what an early fix created is still pending.
  const types = new ContentTypeRepository(db, { nodeState: await currentSchemaState(db) })
  const dataTypes = new DataTypeRepository(db)
  const out: AffectedProperty[] = []
  const editorOf = async (dataTypeAlias: string): Promise<string | undefined> =>
    loaded.set.dataTypes.find((d) => d.alias === dataTypeAlias)?.editor ??
    BUILTIN_DATA_TYPES.find((b) => b.alias === dataTypeAlias)?.editor ??
    (await dataTypes.byAlias(dataTypeAlias))?.editorAlias
  for (const t of loaded.set.documentTypes) {
    const existing = t.key
      ? await types.byKey(t.key)
      : await types.byAlias(t.alias, { includeRetired: true })
    if (!existing) continue
    for (const p of allProperties(t)) {
      const live = existing.properties.find((x) => x.alias === p.alias)
      const incoming = !live?.mandatory || live.pending !== null
      const entry: AffectedProperty = {
        type: t,
        typeAggregate: existing,
        property: p,
        live,
        newlyMandatory: p.mandatory && incoming,
        liveMandatory: p.mandatory && !incoming,
      }
      if (live) {
        const toEditor = await editorOf(p.type)
        const fromEditor = (await dataTypes.byKey(live.dataTypeKey))?.editorAlias
        if (toEditor && fromEditor && toEditor !== fromEditor)
          entry.editorChange = {
            from: fromEditor,
            to: toEditor,
            toStorage: storageTypeFor(toEditor),
          }
      }
      if (entry.newlyMandatory || entry.liveMandatory || entry.editorChange) out.push(entry)
    }
  }
  return out
}

/** A type's node id plus every type that composes it, transitively: their documents carry its properties. */
export async function typeNodeIdsCarrying(db: Db, typeKey: string): Promise<number[]> {
  const rows = await db.query<{ id: number }>(
    `WITH RECURSIVE carriers(id) AS (
       SELECT id FROM node WHERE unique_id = ?
       UNION
       SELECT c.child_content_type_id FROM content_type_composition c JOIN carriers p ON p.id = c.parent_content_type_id
     )
     SELECT id FROM carriers`,
    [typeKey],
  )
  return rows.map((r) => Number(r.id))
}

function documentLink(backOfficePath: string, key: string): string {
  return `${backOfficePath}/section/content/workspace/document/edit/${key}`
}

export async function runCheck(
  db: Db,
  loaded: LoadedSchema,
  node: SyncNode,
  options: CheckOptions,
): Promise<CheckReport> {
  const findings: Finding[] = []
  const backOfficePath = options.backOfficePath ?? DEFAULT_BACKOFFICE_PATH
  const set = options.set ?? {}
  const migrations = options.migrations ?? []

  // ---- the framework's own steps
  const frameworkPending = (await pendingMigrations(db, bunbracoPlan)).map((m) => m.name)
  for (const name of frameworkPending)
    findings.push({
      kind: 'auto',
      code: 'framework-migration',
      subjectType: 'migration',
      subjectKey: name,
      subjectName: name,
      propertyAlias: null,
      culture: null,
      message: `framework migration ${name} will run at upgrade`,
      link: null,
    })

  // A database behind the framework's own schema cannot be read for the site
  // part yet; `--fix` and `upgrade` run those steps first, then check again.
  if (frameworkPending.length > 0)
    return {
      findings,
      outstanding: [],
      classification: 'none',
      sync: emptySyncReport('skipped-same', {
        reason: 'framework migrations pending; the site schema is checked once they have run',
      }),
      frameworkPending,
      siteChecked: false,
    }

  // ---- the files themselves, and what the sync would do
  const sync = await syncSchema(db, loaded, node, { ...options, dryRun: true, status: 'prepared' })
  for (const problem of sync.problems)
    findings.push({
      kind: 'blocking',
      code: 'schema-problem',
      subjectType: 'file',
      subjectKey: problem.file,
      subjectName: problem.file,
      propertyAlias: problem.path || null,
      culture: null,
      message: problem.message,
      link: null,
    })
  if (sync.action === 'refused' && sync.problems.length === 0)
    findings.push({
      kind: 'blocking',
      code: 'sync-refused',
      subjectType: 'file',
      subjectKey: 'schema',
      subjectName: 'schema/',
      propertyAlias: null,
      culture: null,
      message: sync.reason ?? 'the sync refused',
      link: null,
    })

  const types = new ContentTypeRepository(db)
  const docs = new DocumentRepository(db)
  const languages = await new LanguageRepository(db).all()
  const cultures = languages.map((l) => l.isoCode)
  const ledger = await readLedger(db)
  const ledgered = new Set(ledger.filter((r) => r.kind === 'value').map((r) => r.name))
  const prepared = await latestPreparedState(db)

  // ---- types removed while they have content
  const inFiles = new Set(loaded.set.documentTypes.map((t) => t.alias))
  const dbTypes = await db.query<{ unique_id: string; alias: string }>(
    'SELECT n.unique_id, ct.alias FROM content_type ct JOIN node n ON n.id = ct.node_id WHERE ct.retired_at IS NULL',
  )
  for (const row of dbTypes) {
    if (inFiles.has(String(row.alias))) continue
    const count = await types.contentCount(String(row.unique_id).toLowerCase())
    if (count === 0) continue
    findings.push({
      kind: 'blocking',
      code: 'type-removed-with-content',
      subjectType: 'document-type',
      subjectKey: String(row.unique_id).toLowerCase(),
      subjectName: String(row.alias),
      propertyAlias: null,
      culture: null,
      message: `document type "${row.alias}" was removed from schema/ but ${count} document(s) of it exist`,
      link: null,
    })
  }

  // ---- properties that need data: newly mandatory, or changing editor
  let breaking = false
  let dataRequiring = false
  for (const affected of await affectedProperties(db, loaded)) {
    const { type: t, property: p, typeAggregate } = affected
    const carriers = await typeNodeIdsCarrying(db, typeAggregate.key)
    const documents = await docs.documentsOfTypes(carriers)
    const propertySubject = `${typeAggregate.key}:${p.alias}`
    const perCulture = p.variesByCulture ? cultures : [null]

    if (affected.newlyMandatory && documents.length > 0) {
      dataRequiring = true
      const supplied = p.default !== undefined || set[`${t.alias}.${p.alias}`] !== undefined
      let missing = 0
      for (const doc of documents) {
        const values = await docs.currentValuesByAlias(doc.nodeId, [p.alias])
        for (const culture of perCulture) {
          const has = values.some(
            (v) =>
              v.culture === culture && v.value !== null && v.value !== undefined && v.value !== '',
          )
          if (has) continue
          missing += 1
          if (!supplied)
            findings.push({
              kind: 'person',
              code: 'mandatory-missing',
              subjectType: 'document',
              subjectKey: doc.key,
              subjectName: doc.name,
              propertyAlias: p.alias,
              culture,
              message: `"${p.name}" is required from ${loaded.set.version} and "${doc.name}"${culture ? ` (${culture})` : ''} has no value`,
              link: documentLink(backOfficePath, doc.key),
            })
        }
      }
      if (supplied && missing > 0)
        findings.push({
          kind: 'auto',
          code: 'mandatory-default',
          subjectType: 'property',
          subjectKey: propertySubject,
          subjectName: `${t.alias}.${p.alias}`,
          propertyAlias: p.alias,
          culture: null,
          message: `"${p.name}" is required and ${missing} value(s) will be filled with ${p.default !== undefined ? 'its default' : '--set'}`,
          link: null,
        })
    }

    // A live mandatory property a published page lacks: it will fail its next publish.
    // Reported for the dashboard, never a reason to refuse an upgrade.
    if (affected.liveMandatory) {
      for (const doc of documents) {
        if (!doc.published) continue
        const values = await docs.currentValuesByAlias(doc.nodeId, [p.alias])
        for (const culture of perCulture) {
          if (
            values.some(
              (v) =>
                v.culture === culture &&
                v.value !== null &&
                v.value !== undefined &&
                v.value !== '',
            )
          )
            continue
          findings.push({
            kind: 'person',
            code: 'mandatory-unfilled',
            subjectType: 'document',
            subjectKey: doc.key,
            subjectName: doc.name,
            propertyAlias: p.alias,
            culture,
            message: `"${p.name}" is required and published page "${doc.name}"${culture ? ` (${culture})` : ''} has no value`,
            link: documentLink(backOfficePath, doc.key),
          })
        }
      }
    }

    if (affected.editorChange && affected.live) {
      breaking = true
      const { from, to } = affected.editorChange
      const converter = findConverter(from, to)
      if (!converter) {
        findings.push({
          kind: 'blocking',
          code: 'no-converter',
          subjectType: 'property',
          subjectKey: propertySubject,
          subjectName: `${t.alias}.${p.alias}`,
          propertyAlias: p.alias,
          culture: null,
          message: `"${p.name}" changes editor from ${from} to ${to} and no converter exists; write one in schema/migrations/ or keep the editor`,
          link: null,
        })
        continue
      }
      const ran = ledgered.has(conversionLedgerName(t.alias, p.alias, from, to))
      let convertible = 0
      for (const doc of documents) {
        for (const v of await docs.currentValuesByAlias(doc.nodeId, [p.alias])) {
          if (v.value === null || v.value === undefined) continue
          // After the fix ran, a value still at an older state was written by an old node since.
          const stale = ran && prepared !== undefined && v.schemaStateId < prepared.id
          if (ran && !stale) continue
          try {
            converter.convert(v.value, {
              documentKey: doc.key,
              culture: v.culture,
              segment: v.segment,
            })
            if (stale)
              findings.push({
                kind: 'auto',
                code: 'unconverted-value',
                subjectType: 'document',
                subjectKey: doc.key,
                subjectName: doc.name,
                propertyAlias: p.alias,
                culture: v.culture,
                message: `"${doc.name}" was edited after the fix; "${p.name}" needs converting again — run check --fix`,
                link: documentLink(backOfficePath, doc.key),
              })
            else convertible += 1
          } catch (error) {
            findings.push({
              kind: 'person',
              code: 'value-conversion',
              subjectType: 'document',
              subjectKey: doc.key,
              subjectName: doc.name,
              propertyAlias: p.alias,
              culture: v.culture,
              message: `"${p.name}" on "${doc.name}"${v.culture ? ` (${v.culture})` : ''} cannot be converted from ${from} to ${to}: ${(error as Error).message}`,
              link: documentLink(backOfficePath, doc.key),
            })
          }
        }
      }
      if (!ran && convertible > 0)
        findings.push({
          kind: 'auto',
          code: 'value-conversion',
          subjectType: 'property',
          subjectKey: propertySubject,
          subjectName: `${t.alias}.${p.alias}`,
          propertyAlias: p.alias,
          culture: null,
          message: `"${p.name}": ${convertible} value(s) convert from ${from} to ${to}`,
          link: null,
        })
    }
  }

  // ---- the site's value migrations
  for (const m of migrations) {
    const fileType = loaded.set.documentTypes.find((t) => t.alias === m.from.type)
    const existing = await types.byAlias(m.from.type, { includeRetired: true })
    if (!fileType || !existing) continue
    const targets = m.to.map((x) => x.property)
    const fileProps = allProperties(fileType).map((p) => p.alias)
    if (!targets.every((alias) => fileProps.includes(alias))) {
      findings.push({
        kind: 'blocking',
        code: 'migration-target-missing',
        subjectType: 'migration',
        subjectKey: m.id,
        subjectName: m.id,
        propertyAlias: null,
        culture: null,
        message: `migration ${m.id} writes to ${targets.join(', ')} but ${fileType.alias} does not define them all`,
        link: null,
      })
      continue
    }
    const carriers = await typeNodeIdsCarrying(db, existing.key)
    const documents = await docs.documentsOfTypes(carriers)
    const ran = ledgered.has(m.id)
    let convertible = 0
    for (const doc of documents) {
      for (const v of await docs.currentValuesByAlias(doc.nodeId, [m.from.property])) {
        if (v.value === null || v.value === undefined) continue
        let stale = false
        if (ran) {
          // Row order is the whole signal: a target written after this source
          // value is up to date. Requiring the prepared state as well reported
          // every surviving source value as stale once the cut-over had made that
          // state current, so re-running `upgrade` on an upgraded database refused.
          const targetsWritten = (await docs.currentValuesByAlias(doc.nodeId, targets)).some(
            (tv) => tv.rowId > v.rowId,
          )
          stale = !targetsWritten
          if (!stale) continue
        }
        try {
          outputsOf(
            m,
            m.convert(v.value, { documentKey: doc.key, culture: v.culture, segment: v.segment }),
          )
          if (stale)
            findings.push({
              kind: 'auto',
              code: 'unconverted-value',
              subjectType: 'document',
              subjectKey: doc.key,
              subjectName: doc.name,
              propertyAlias: m.from.property,
              culture: v.culture,
              message: `"${doc.name}" changed "${m.from.property}" after migration ${m.id} ran — run check --fix again`,
              link: documentLink(backOfficePath, doc.key),
            })
          else convertible += 1
        } catch (error) {
          findings.push({
            kind: 'person',
            code: 'value-migration',
            subjectType: 'document',
            subjectKey: doc.key,
            subjectName: doc.name,
            propertyAlias: m.from.property,
            culture: v.culture,
            message: `migration ${m.id} cannot convert "${m.from.property}" on "${doc.name}": ${(error as Error).message}`,
            link: documentLink(backOfficePath, doc.key),
          })
        }
      }
    }
    if (!ran) {
      dataRequiring = true
      findings.push({
        kind: 'auto',
        code: 'value-migration',
        subjectType: 'migration',
        subjectKey: m.id,
        subjectName: m.id,
        propertyAlias: m.from.property,
        culture: null,
        message: `migration ${m.id} moves ${convertible} value(s) from ${m.from.type}.${m.from.property} to ${targets.join(', ')}`,
        link: null,
      })
    }
  }

  const classification: ChangeClass = breaking
    ? 'breaking'
    : dataRequiring
      ? 'data-requiring'
      : sync.action === 'would-apply' || sync.action === 'applied'
        ? 'additive'
        : 'none'
  return {
    findings,
    outstanding: findings.filter(
      (f) => f.code !== 'framework-migration' && f.code !== 'mandatory-unfilled',
    ),
    classification,
    sync,
    frameworkPending,
    siteChecked: true,
  }
}
