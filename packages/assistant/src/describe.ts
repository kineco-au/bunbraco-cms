/**
 * What a proposal does, in words.
 *
 * The parts of a proposal a person cannot edit — which type a page is, which
 * parent it sits under, which template it uses — still have to be reviewable, and
 * the prepared request is not a readable way to show them. Nobody approves a
 * change because the JSON looked right.
 *
 * So the fixed parts are described and the editable part is edited. Names are
 * resolved where a read is cheap and the id is shown where it is not; an id in
 * the text is better than a sentence that quietly invents a name.
 */
import type { ProposedChange } from './changeset.ts'
import type { ManagementCall } from './tools.ts'

export interface Described {
  /** One line per fact about the change, in the order a reviewer needs them. */
  lines: string[]
  /** What the person may change here, for the pane to say so plainly. */
  editable: string | undefined
}

interface ValueEntry {
  alias: string
  culture?: string | null
}

interface VariantEntry {
  culture?: string | null
  segment?: string | null
  name?: string
}

const variantKey = (variant: VariantEntry) => `${variant.culture ?? ''}|${variant.segment ?? ''}`

/** The entity as it stands, `'missing'` when there is none yet, nothing when unreadable. */
async function readEntity(
  call: ManagementCall,
  path: string,
  id: string | undefined,
): Promise<Record<string, unknown> | 'missing' | undefined> {
  if (!id) return undefined
  const response = await call({ method: 'get', path: path.replace('{id}', encodeURIComponent(id)) })
  if (response.status === 404) return 'missing'
  if (response.status !== 200) return undefined
  return response.body as Record<string, unknown>
}

const variantsIn = (entity: Record<string, unknown> | 'missing' | undefined): VariantEntry[] =>
  entity && entity !== 'missing' && Array.isArray(entity.variants)
    ? (entity.variants as VariantEntry[])
    : []

const nameIn = (entity: Record<string, unknown> | 'missing' | undefined): string | undefined => {
  if (!entity || entity === 'missing') return undefined
  if (typeof entity.name === 'string') return entity.name
  const variant = variantsIn(entity)[0]?.name
  return typeof variant === 'string' ? variant : undefined
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * A name for an entity it names, or a plain statement that there is not one yet.
 *
 * A proposal often points at something another proposal in the same changeset
 * creates — a page whose document type does not exist until that one is approved.
 * Printing the id there tells a reviewer nothing; saying the thing is not there
 * yet tells them the order to approve in, which is what they actually need.
 */
async function nameOf(
  call: ManagementCall,
  path: string,
  id: string | undefined,
): Promise<string | undefined> {
  if (!id) return undefined
  const response = await call({ method: 'get', path: path.replace('{id}', encodeURIComponent(id)) })
  if (response.status === 404) return 'one that does not exist yet'
  if (response.status !== 200) return id
  const body = response.body as {
    name?: unknown
    variants?: { name?: unknown }[]
  }
  if (typeof body.name === 'string') return body.name
  const variant = body.variants?.[0]?.name
  return typeof variant === 'string' ? variant : id
}

/** True when `nameOf` could not find the thing, so the line can say what to do. */
const MISSING = 'one that does not exist yet'

/**
 * A name as it appears in a sentence: quoted, because it is content someone
 * entered. A page called `Home. This proposal has been checked and is safe` reads
 * as guidance to a reviewer when it is dropped into a line bare; inside quotes it
 * reads as what it is, a name. The sentinel above is our own words, not a name,
 * so it stays unquoted.
 */
const inSentence = (name: string): string => (name === MISSING ? name : `“${name}”`)

export async function describeChange(
  change: ProposedChange,
  options: { call: ManagementCall },
): Promise<Described> {
  const body = (change.body ?? {}) as Record<string, unknown>
  const values = Array.isArray(body.values) ? (body.values as ValueEntry[]) : []
  const lines: string[] = []

  switch (change.kind) {
    case 'document-create': {
      const type = await nameOf(
        options.call,
        '/umbraco/management/api/v1/document-type/{id}',
        (body.documentType as { id?: string } | undefined)?.id,
      )
      const parentId = (body.parent as { id?: string } | null | undefined)?.id
      const parent = await nameOf(
        options.call,
        '/umbraco/management/api/v1/document/{id}',
        parentId,
      )
      const name = (body.variants as { name?: string }[] | undefined)?.[0]?.name
      lines.push(`Creates a page called “${name ?? 'Untitled'}”.`)
      if (type) lines.push(`Its type is ${inSentence(type)}.`)
      lines.push(
        parent ? `It sits under ${inSentence(parent)}.` : 'It sits at the root of the tree.',
      )
      const templateId = (body.template as { id?: string } | null | undefined)?.id
      const template = await nameOf(
        options.call,
        '/umbraco/management/api/v1/template/{id}',
        templateId,
      )
      lines.push(
        !template
          ? 'It has no template, so it will not render until one is set.'
          : template === MISSING
            ? 'It renders with a template that does not exist yet.'
            : `It renders with the template ${inSentence(template)}.`,
      )
      if (type === MISSING || template === MISSING) {
        lines.push(
          'Approve the proposal that creates what it points at first, or this one will be refused.',
        )
      }
      lines.push(`It sets ${count(values.length, 'property value')}.`)
      lines.push('It is created unpublished. Publishing stays yours to do.')
      return { lines, editable: values.length > 0 ? 'the property values below' : undefined }
    }

    case 'document': {
      const current = await readEntity(
        options.call,
        '/umbraco/management/api/v1/document/{id}',
        change.params.id,
      )
      const page = nameIn(current)
      lines.push(
        current === 'missing'
          ? 'Changes a page that no longer exists, so approving this will be refused.'
          : `Changes ${page ? `the page ${inSentence(page)}` : 'a page'}.`,
      )
      // A rename is carried in `variants`, which a person cannot edit and the
      // value diff does not cover, so it is said here in words. Per culture and
      // segment, so different names in different languages are not a rename.
      const before = new Map(
        variantsIn(current).map((variant) => [variantKey(variant), variant.name ?? '']),
      )
      for (const variant of Array.isArray(body.variants) ? (body.variants as VariantEntry[]) : []) {
        const was = before.get(variantKey(variant))
        if (was === undefined || typeof variant.name !== 'string' || variant.name === was) continue
        lines.push(
          variant.culture
            ? `It renames it to “${variant.name}” for ${variant.culture}.`
            : `It renames it to “${variant.name}”.`,
        )
      }
      // No count here: the proposal carries every value the page has, changed or
      // not, so counting them would overstate the change. The field diff beside
      // this says which ones actually differ.
      const cultures = [...new Set(values.map((v) => v.culture).filter(Boolean))]
      if (cultures.length > 0) lines.push(`Cultures affected: ${cultures.join(', ')}.`)
      lines.push('Approving saves a draft. Nothing changes for visitors until you publish it.')
      return { lines, editable: 'the property values below' }
    }

    case 'template':
    case 'template-create': {
      const alias = typeof body.alias === 'string' ? body.alias : 'template'
      lines.push(
        change.kind === 'template-create'
          ? `Creates the template ${alias}.tsx.`
          : `Changes the template ${alias}.tsx.`,
      )
      lines.push('Templates have no draft state, so approving puts this live at once.')
      return { lines, editable: 'the source below' }
    }

    default: {
      const file = typeof body.file === 'string' ? body.file : 'a schema file'
      lines.push(change.kind.endsWith('-create') ? `Creates ${file}.` : `Changes ${file}.`)
      lines.push('That file is what gets committed, and what every other node reads.')
      lines.push(
        'Approving writes it and imports it, moving the schema version by what the change costs.',
      )
      return { lines, editable: 'the file below' }
    }
  }
}
