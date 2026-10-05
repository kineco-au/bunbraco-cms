/**
 * Whole-set validation. Every problem is reported, not just the first, because
 * a person fixing a schema wants the full list.
 */
import { SYSTEM_MEDIA_TYPES, SYSTEM_MEMBER_TYPE } from '@bunbraco/data'
import { BUILTIN_DATA_TYPE_ALIASES, SYSTEM_MEDIA_TYPE_ALIASES } from './builtin.ts'
import {
  allProperties,
  type SchemaDocumentType,
  type SchemaProblem,
  type SchemaSet,
  TYPE_KIND_FILES,
} from './model.ts'
import { type ValidateFormsOptions, validateForms } from './validate-forms.ts'

export interface ValidateOptions extends ValidateFormsOptions {
  /** Template aliases that exist as view files; omit to skip template checks. */
  componentAliases?: ReadonlySet<string>
}

const VERSION = /^\d+(\.\d+)*$/

export function validateSchemaSet(set: SchemaSet, options: ValidateOptions = {}): SchemaProblem[] {
  const problems: SchemaProblem[] = []
  const add = (file: string, path: string, message: string) =>
    problems.push({ file, path, message })

  if (!VERSION.test(set.version))
    add('schema/schema.toml', 'schema.version', `"${set.version}" is not a dotted number`)

  const dataTypeAliases = new Set(BUILTIN_DATA_TYPE_ALIASES)
  const seenDataTypes = new Set<string>()
  for (const d of set.dataTypes) {
    const file = `schema/data-types/${d.alias}`
    if (seenDataTypes.has(d.alias))
      add(file, 'data-type.alias', `duplicate data type alias "${d.alias}"`)
    seenDataTypes.add(d.alias)
    dataTypeAliases.add(d.alias)
    if (d.since && !VERSION.test(d.since))
      add(file, 'data-type.since', `"${d.since}" is not a dotted number`)
  }

  // Both kinds share one alias space (Umbraco's content_type.alias is unique);
  // compositions and allowed children stay within a kind.
  const typeAliases = new Set<string>()
  const keys = new Map<string, string>()
  const kinds: Array<{ types: readonly SchemaDocumentType[]; header: string; dir: string }> = [
    { types: set.documentTypes, ...TYPE_KIND_FILES.document },
    { types: set.mediaTypes ?? [], ...TYPE_KIND_FILES.media },
    { types: set.memberTypes ?? [], ...TYPE_KIND_FILES.member },
  ]
  for (const { types, header, dir } of kinds) {
    for (const t of types) {
      const file = `schema/${dir}/${t.alias}`
      // A system type's alias belongs to it; a file may override it only by its key.
      const system = SYSTEM_MEDIA_TYPES.find((s) => s.alias.toLowerCase() === t.alias.toLowerCase())
      if (system && (dir !== 'media-types' || (t.key && t.key.toLowerCase() !== system.key)))
        add(
          file,
          `${header}.alias`,
          `"${t.alias}" is the system media type ${system.alias}; choose another alias, or override ${system.alias} with key "${system.key}"`,
        )
      const isSystemMember = t.alias.toLowerCase() === SYSTEM_MEMBER_TYPE.alias.toLowerCase()
      if (
        isSystemMember &&
        (dir !== 'member-types' || (t.key && t.key.toLowerCase() !== SYSTEM_MEMBER_TYPE.key))
      )
        add(
          file,
          `${header}.alias`,
          `"${t.alias}" is the built-in member type; choose another alias, or override it with key "${SYSTEM_MEMBER_TYPE.key}"`,
        )
      if (typeAliases.has(t.alias))
        add(file, `${header}.alias`, `duplicate type alias "${t.alias}"`)
      typeAliases.add(t.alias)
      if (t.key) {
        const owner = keys.get(t.key)
        if (owner) add(file, `${header}.key`, `key already used by "${owner}"`)
        keys.set(t.key, t.alias)
      }
      if (t.since && !VERSION.test(t.since))
        add(file, `${header}.since`, `"${t.since}" is not a dotted number`)
      const propertyAliases = new Set<string>()
      for (const p of allProperties(t)) {
        const path = `property "${p.alias}"`
        if (dir !== 'member-types' && (p.memberCanView || p.memberCanEdit || p.sensitive))
          add(file, path, 'member-can-view, member-can-edit and sensitive belong to member types')
        if (propertyAliases.has(p.alias)) add(file, path, 'duplicate property alias')
        propertyAliases.add(p.alias)
        if (!dataTypeAliases.has(p.type)) add(file, `${path}.type`, `unknown data type "${p.type}"`)
        if (p.key) {
          const owner = keys.get(p.key)
          if (owner) add(file, `${path}.key`, `key already used by "${owner}"`)
          keys.set(p.key, `${t.alias}.${p.alias}`)
        }
        if (p.since && !VERSION.test(p.since))
          add(file, `${path}.since`, `"${p.since}" is not a dotted number`)
        if (p.variesByCulture && !t.variesByCulture)
          add(
            file,
            `${path}.varies-by-culture`,
            'the type does not vary by culture, so the property cannot',
          )
      }
      // An element type is a property bag with no URL, so the things a route needs
      // do not apply to it. A media-type file rejects these outright because they
      // are not in its vocabulary at all; here they are valid keys made invalid by
      // `is-element`, so the rule lives at this level rather than in the parser.
      // Silently ignoring them is worse: the file says one thing and the editor
      // another.
      if (t.isElement) {
        if (t.components.length > 0)
          add(file, `${header}.components`, 'an element type has no component: it is never routed')
        if (t.defaultComponent)
          add(
            file,
            `${header}.default-component`,
            'an element type has no template: it is never routed',
          )
        if (t.allowAtRoot)
          add(
            file,
            `${header}.allow-at-root`,
            'an element type is not created in the content tree; use allow-in-library',
          )
        if (t.allowChildren.length > 0)
          add(
            file,
            `${header}.allow-children`,
            'an element type has no children: it is not in the content tree',
          )
      }
      if (t.defaultComponent && !t.components.includes(t.defaultComponent))
        add(file, `${header}.default-component`, `"${t.defaultComponent}" is not in components`)
      if (options.componentAliases) {
        for (const alias of t.components)
          if (!options.componentAliases.has(alias))
            add(file, `${header}.components`, `no components/${alias}.tsx`)
      }
    }

    // References between types, once every alias is known. First occurrence wins,
    // so a duplicate alias (already reported) cannot shadow the real definition.
    const byAlias = new Map<string, SchemaDocumentType>()
    for (const t of types) if (!byAlias.has(t.alias)) byAlias.set(t.alias, t)
    // System media types exist whether or not a file defines them.
    const known = (alias: string) =>
      byAlias.has(alias) || (dir === 'media-types' && SYSTEM_MEDIA_TYPE_ALIASES.has(alias))
    for (const t of types) {
      const file = `schema/${dir}/${t.alias}`
      for (const c of t.compositions)
        if (!known(c)) add(file, `${header}.compositions`, `unknown type "${c}"`)
      for (const c of t.allowChildren)
        if (!known(c)) add(file, `${header}.allow-children`, `unknown type "${c}"`)
      if (t.collection && !dataTypeAliases.has(t.collection))
        add(file, `${header}.collection`, `unknown data type "${t.collection}"`)
    }
    for (const t of types) {
      const cycle = findCompositionCycle(t.alias, byAlias)
      if (cycle)
        add(
          `schema/${dir}/${t.alias}`,
          `${header}.compositions`,
          `composition cycle: ${cycle.join(' -> ')}`,
        )
    }
  }

  const defaults = set.languages.filter((l) => l.default)
  if (set.languages.length > 0 && defaults.length !== 1)
    add(
      'schema/languages.toml',
      'language',
      `exactly one language must be default; found ${defaults.length}`,
    )
  const isos = new Set<string>()
  for (const l of set.languages) {
    if (isos.has(l.iso.toLowerCase()))
      add('schema/languages.toml', `language "${l.iso}"`, 'duplicate language')
    isos.add(l.iso.toLowerCase())
  }
  for (const l of set.languages) {
    if (l.fallback && !isos.has(l.fallback.toLowerCase()))
      add(
        'schema/languages.toml',
        `language "${l.iso}".fallback`,
        `unknown language "${l.fallback}"`,
      )
  }
  // Forms are validated against the types they reach into, so this happens
  // after the type aliases are known.
  problems.push(
    ...validateForms(set.forms ?? [], {
      ...options,
      documentTypeAliases:
        options.documentTypeAliases ?? new Set(set.documentTypes.map((t) => t.alias)),
    }),
  )
  return problems
}

function findCompositionCycle(
  start: string,
  byAlias: Map<string, { compositions: string[] }>,
): string[] | undefined {
  const walk = (alias: string, trail: string[]): string[] | undefined => {
    if (trail.includes(alias)) return [...trail.slice(trail.indexOf(alias)), alias]
    const type = byAlias.get(alias)
    if (!type) return undefined
    for (const next of type.compositions) {
      const found = walk(next, [...trail, alias])
      if (found) return found
    }
    return undefined
  }
  const found = walk(start, [])
  return found && found[0] === start ? found : undefined
}
