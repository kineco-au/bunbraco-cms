/**
 * Value migrations: one construct for a site's `schema/migrations/*.ts` and
 * for the converters the framework ships. `convert` returns the new value —
 * or, for a split, an object keyed by target property — and throws to say a
 * value needs a person. docs/10, "Site-authored value migrations".
 */
import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface ValueMigrationContext {
  documentKey: string
  culture: string | null
  segment: string | null
}

export interface ValueMigration {
  /** Ledger name; the file name by default. */
  id: string
  /** True when the definition named itself; the loader keeps such an id. */
  explicitId?: boolean
  /** Applies from this schema version on; informational. */
  since?: string
  from: { type: string; property: string }
  to: Array<{ property: string }>
  convert(value: unknown, context: ValueMigrationContext): unknown
}

export interface ValueMigrationDefinition {
  id?: string
  since?: string
  from: { type: string; property: string }
  to: { property: string } | Array<{ property: string }>
  convert(value: unknown, context: ValueMigrationContext): unknown
}

export function defineValueMigration(definition: ValueMigrationDefinition): ValueMigration {
  const to = Array.isArray(definition.to) ? definition.to : [definition.to]
  if (to.length === 0) throw new Error('a value migration needs at least one target property')
  const migration: ValueMigration = {
    id:
      definition.id ??
      `${definition.from.type}.${definition.from.property}->${to.map((t) => t.property).join('+')}`,
    explicitId: definition.id !== undefined,
    from: definition.from,
    to,
    convert: definition.convert,
  }
  if (definition.since) migration.since = definition.since
  return migration
}

/** Normalises `convert`'s result to one value per target property. */
export function outputsOf(migration: ValueMigration, result: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>()
  if (migration.to.length === 1) {
    const single = migration.to[0]?.property as string
    const record = result as Record<string, unknown> | null
    out.set(
      single,
      record && typeof record === 'object' && !Array.isArray(record) && single in record
        ? record[single]
        : result,
    )
    return out
  }
  const record = (result ?? {}) as Record<string, unknown>
  for (const target of migration.to) out.set(target.property, record[target.property] ?? null)
  return out
}

/** Every `schema/migrations/*.ts` default export, sorted by file name. */
export async function loadValueMigrations(schemaDir: string): Promise<ValueMigration[]> {
  const dir = join(schemaDir, 'migrations')
  if (!existsSync(dir)) return []
  const out: ValueMigration[] = []
  for (const name of readdirSync(dir)
    .filter((n) => /\.(ts|js)$/.test(n))
    .sort()) {
    const module = (await import(join(dir, name))) as {
      default?: ValueMigration | ValueMigrationDefinition
    }
    const value = module.default
    if (!value) throw new Error(`schema/migrations/${name} has no default export`)
    const migration =
      'id' in value && Array.isArray((value as ValueMigration).to)
        ? (value as ValueMigration)
        : defineValueMigration(value as ValueMigrationDefinition)
    if (!migration.explicitId) migration.id = basename(name).replace(/\.(ts|js)$/, '')
    out.push(migration)
  }
  return out
}

/** A framework converter between two property editors' stored formats. */
export interface ValueConverter {
  from: string
  to: string
  convert(value: unknown, context: ValueMigrationContext): unknown
}

const converters = new Map<string, ValueConverter>()
const key = (from: string, to: string) => `${from}->${to}`

export function registerConverter(converter: ValueConverter): void {
  converters.set(key(converter.from, converter.to), converter)
}

export function findConverter(from: string, to: string): ValueConverter | undefined {
  if (from === to) return { from, to, convert: (v) => v }
  return converters.get(key(from, to))
}

// Editors whose stored text is the same shape: a plain copy converts.
for (const [from, to] of [
  ['Umbraco.TextBox', 'Umbraco.TextArea'],
  ['Umbraco.TextArea', 'Umbraco.TextBox'],
  ['Umbraco.TextBox', 'Umbraco.RichText'],
  ['Umbraco.TextArea', 'Umbraco.RichText'],
  ['Umbraco.TextBox', 'Umbraco.Label'],
]) {
  registerConverter({ from: from as string, to: to as string, convert: (v) => v })
}
