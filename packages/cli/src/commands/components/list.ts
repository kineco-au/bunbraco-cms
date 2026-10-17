import { listComponents } from '@crombolo/server'
import { BaseCommand } from '../../base.ts'
import { declaredTypes } from '../../support/components.ts'
import { here } from '../../support/describe.ts'
import { siteConfig } from '../../support/site.ts'

export default class ComponentsList extends BaseCommand {
  static override summary = 'what is in components/, and which type declares each'
  static override spec = {
    effects: 'read_only',
    cardinality: 'bounded',
    // One item of `items`, as clispec reads a collection.
    outputFields: [
      { name: 'alias', type: 'string' },
      { name: 'path', type: 'string' },
      { name: 'kind', type: 'string', enum: ['template', 'component'] },
      { name: 'declaredBy', type: 'array', items: { type: 'string' } },
    ],
  } as const

  async run() {
    await this.parse(ComponentsList)
    const config = await siteConfig()
    const types = declaredTypes(config)
    const found = listComponents(config.componentsDir)
    if (found.length === 0) this.say(`Nothing in ${here(config.componentsDir)}.`)
    const items = found.map((component) => {
      // A component is a template because a content type names it, not
      // because of where it sits — so the label is read off the schema.
      const declaredBy = types
        .filter((type) => type.components.includes(component.alias))
        .map((type) => type.alias)
      const kind = declaredBy.length > 0 ? ('template' as const) : ('component' as const)
      const note = declaredBy.length > 0 ? `  ← ${declaredBy.join(', ')}` : ''
      this.say(`  ${kind.padEnd(9)} ${here(component.path)}${note}`)
      return { alias: component.alias, path: here(component.path), kind, declaredBy }
    })
    return { items }
  }
}
