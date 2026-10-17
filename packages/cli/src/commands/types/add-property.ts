import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  addProperty,
  BUILTIN_DATA_TYPES,
  fileNameFor,
  type SchemaContentType,
  type SchemaTypeKind,
  TYPE_KIND_FILES,
  writeContentType,
} from '@crombolo/schema'
import { Args, Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import { describeSync, here } from '../../support/describe.ts'
import { dryRun } from '../../support/flags.ts'
import { siteConfig } from '../../support/site.ts'
import { applySchema, loadTypes, needSchemaDir, refuseProblems } from '../../support/types.ts'

/** The repetitive edit: one property appended to a type, and applied. */
export default class TypesAddProperty extends BaseCommand {
  static override summary = 'append a property to a type, and apply it'
  static override description =
    'The whole file is re-emitted from the model, so comments in it are not kept; --dry-run prints the file instead.'
  static override examples = [
    '<%= config.bin %> types add-property article summary --type textarea --mandatory',
  ]
  static override aliases = ['schema:add-property']
  static override deprecateAliases = true
  static override args = {
    type: Args.string({ required: true, description: "the type's alias" }),
    alias: Args.string({ required: true, description: "the property's alias" }),
  }
  static override flags = {
    type: Flags.string({ summary: 'the data type', helpValue: '<data type>', required: true }),
    name: Flags.string({ summary: "the property's name", helpValue: '<name>' }),
    description: Flags.string({ summary: "the property's description", helpValue: '<text>' }),
    mandatory: Flags.boolean({ summary: 'an editor must fill it in' }),
    tab: Flags.string({ summary: 'the tab it goes in', helpValue: '<tab>' }),
    'dry-run': dryRun,
  }
  static override spec = {
    effects: 'non_idempotent',
    cardinality: 'single',
    outputFields: [
      { name: 'file', type: 'string' },
      { name: 'property', type: 'object' },
      { name: 'tab', type: 'string' },
      { name: 'text', type: 'string', nullable: true },
      { name: 'schema', type: 'string', nullable: true },
    ],
    errors: ['not_found', 'conflict', 'refused'],
  } as const

  async run() {
    const { args, flags } = await this.parse(TypesAddProperty)
    const config = await siteConfig()
    needSchemaDir(config)
    const loaded = loadTypes(config)
    refuseProblems(loaded.problems)
    const kinds: Array<[SchemaTypeKind, SchemaContentType[]]> = [
      ['document', loaded.set.contentTypes],
      ['media', loaded.set.mediaTypes ?? []],
      ['member', loaded.set.memberTypes ?? []],
    ]
    const found = kinds
      .map(([kind, types]) => ({ kind, type: types.find((t) => t.alias === args.type) }))
      .find((candidate) => candidate.type)
    if (!found?.type) this.fail('not_found', `No type "${args.type}" in ${here(config.schemaDir)}.`)

    const known = new Set([
      ...BUILTIN_DATA_TYPES.map((d) => d.alias),
      ...loaded.set.dataTypes.map((d) => d.alias),
    ])
    if (!known.has(flags.type))
      this.fail(
        'not_found',
        `No data type "${flags.type}".`,
        `Built in: ${[...known].sort().join(', ')}`,
      )

    const result = addProperty(found.type, {
      alias: args.alias,
      type: flags.type,
      name: flags.name,
      description: flags.description,
      mandatory: flags.mandatory,
      tab: flags.tab,
    })
    if (!result.ok) this.fail('conflict', result.reason)

    const file = join(config.schemaDir, TYPE_KIND_FILES[found.kind].dir, fileNameFor(args.type))
    const text = writeContentType(result.type, found.kind)
    const property = {
      alias: result.property.alias,
      name: result.property.name,
      type: flags.type,
      mandatory: result.property.mandatory === true,
    }
    if (flags['dry-run']) {
      this.changedNothing = true
      this.say(text)
      return { file: here(file), property, tab: result.tab, text, schema: null }
    }
    const before = existsSync(file) ? await Bun.file(file).text() : ''
    await writeFile(file, text)
    this.say(`  wrote    ${here(file)}`)
    this.say(
      `  ${property.alias}  ${property.name} (${flags.type}${property.mandatory ? ', mandatory' : ''}) in tab "${result.tab}"`,
    )
    if (/^\s*#/m.test(before))
      this.say('  note     the file is rewritten canonically, so its comments are not kept')
    const report = await applySchema(this, config)
    return { file: here(file), property, tab: result.tab, text: null, schema: describeSync(report) }
  }
}
