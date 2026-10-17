import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  fileNameFor,
  newType,
  type SchemaTypeKind,
  TYPE_KIND_FILES,
  viewScaffold,
  writeContentType,
} from '@crombolo/schema'
import { Args, Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import { describeSync, here } from '../../support/describe.ts'
import { siteConfig } from '../../support/site.ts'
import { applySchema, loadTypes, needSchemaDir } from '../../support/types.ts'

const TYPE_KINDS: Record<string, SchemaTypeKind> = {
  'content-type': 'document',
  'media-type': 'media',
  'member-type': 'member',
}

/** The file a site would otherwise write from memory, keys and all, and the view it points at. */
export default class TypesNew extends BaseCommand {
  static override summary = 'write a type file, with keys, and the view it points at, then apply it'
  static override examples = ['<%= config.bin %> types new content-type article --at-root']
  static override aliases = ['schema:new']
  static override deprecateAliases = true
  static override args = {
    kind: Args.string({
      required: true,
      options: Object.keys(TYPE_KINDS),
      description: 'what kind of type',
    }),
    alias: Args.string({ required: true, description: "the type's alias" }),
  }
  static override flags = {
    name: Flags.string({ summary: "the type's name", helpValue: '<name>' }),
    description: Flags.string({ summary: "the type's description", helpValue: '<text>' }),
    icon: Flags.string({ summary: "the type's icon", helpValue: '<icon>' }),
    'at-root': Flags.boolean({ summary: 'allow it at the root of the tree' }),
    element: Flags.boolean({ summary: 'an element type, for blocks' }),
    tab: Flags.string({ summary: 'the tab its first property goes in', helpValue: '<tab>' }),
    'no-view': Flags.boolean({ summary: 'no view: a type nothing renders' }),
  }
  static override spec = {
    effects: 'non_idempotent',
    cardinality: 'single',
    outputFields: [
      { name: 'created', type: 'array', items: { type: 'string' } },
      { name: 'schema', type: 'string' },
    ],
    errors: ['not_found', 'conflict', 'refused'],
  } as const

  async run() {
    const { args, flags } = await this.parse(TypesNew)
    const kind = TYPE_KINDS[args.kind] as SchemaTypeKind
    const config = await siteConfig()
    needSchemaDir(config)
    const loaded = loadTypes(config)
    const existing = [
      ...loaded.set.contentTypes,
      ...(loaded.set.mediaTypes ?? []),
      ...(loaded.set.memberTypes ?? []),
    ]
    if (existing.some((type) => type.alias === args.alias))
      this.fail('conflict', `There is already a type with the alias "${args.alias}".`)

    const element = flags.element
    const type = newType({
      alias: args.alias,
      kind,
      name: flags.name,
      description: flags.description,
      icon: flags.icon,
      allowAtRoot: flags['at-root'],
      element,
      template: !flags['no-view'],
      // A content type with nothing in it cannot be published, so it starts with
      // the one property every page has; the other kinds get what they are given.
      tab: kind === 'document' ? (flags.tab ?? 'Content') : undefined,
    })

    const created: string[] = []
    const file = join(config.schemaDir, TYPE_KIND_FILES[kind].dir, fileNameFor(args.alias))
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, writeContentType(type, kind))
    created.push(here(file))
    this.say(`  created  ${here(file)}`)

    // A type nothing allows cannot be created anywhere, which is a confusing
    // first five minutes: the editor simply never offers it.
    if (kind === 'document' && !element && !type.allowAtRoot) {
      const parents = loaded.set.contentTypes.filter((t) => t.allowChildren.includes(args.alias))
      if (parents.length === 0)
        this.say(
          `  note     nothing allows a "${args.alias}" yet — add it to a parent's allow-children, or pass --at-root`,
        )
    }

    if (type.components.length > 0) {
      const view = join(config.componentsDir, `${args.alias}.tsx`)
      if (existsSync(view)) this.say(`  exists   ${here(view)}`)
      else {
        await mkdir(join(view, '..'), { recursive: true })
        await writeFile(view, viewScaffold(type))
        created.push(here(view))
        this.say(`  created  ${here(view)}`)
      }
    }
    const report = await applySchema(this, config)
    return { created, schema: describeSync(report) }
  }
}
