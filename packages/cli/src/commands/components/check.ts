import { checkComponents } from '@crombolo/server'
import { BaseCommand } from '../../base.ts'
import { declaredTypes } from '../../support/components.ts'
import { here } from '../../support/describe.ts'
import { siteConfig } from '../../support/site.ts'

/**
 * A view is loaded when a request renders it, so one that does not compile is a
 * 500 waiting for a visitor. This is that failure brought forward.
 */
export default class ComponentsCheck extends BaseCommand {
  static override summary = 'compile every component, and report one a type declares with no file'
  static override description = 'Exits 20 when a component does not compile or type-check.'
  static override spec = {
    effects: 'read_only',
    cardinality: 'single',
    outputFields: [
      { name: 'checked', type: 'integer' },
      { name: 'templates', type: 'integer' },
      { name: 'problems', type: 'array', items: { type: 'object' } },
      { name: 'typeProblems', type: 'array', items: { type: 'string' } },
      { name: 'typesNote', type: 'string', nullable: true },
    ],
    outcomes: ['problems_found'],
  } as const

  async run() {
    await this.parse(this.ctor)
    const config = await siteConfig()
    const types = declaredTypes(config)
    const report = await checkComponents({
      componentsDir: config.componentsDir,
      siteDir: config.siteDir,
      declaredComponents: types.flatMap((type) => type.components),
    })
    const templates = report.declared.length
    this.say(
      `  checked  ${report.components.length} file(s): ${templates} template(s), ` +
        `${report.components.length - templates} component(s)`,
    )
    for (const problem of report.problems)
      this.say(`  [error]  ${problem.file}: ${problem.message}`)
    if (report.types.note) this.say(`  types    ${report.types.note}`)
    else {
      this.say(`  types    tsc --noEmit over ${here(config.siteDir)}`)
      for (const problem of report.types.problems) this.say(`  [types]  ${problem}`)
    }
    if (report.problems.length > 0 || report.types.problems.length > 0)
      this.outcome = 'problems_found'
    return {
      checked: report.components.length,
      templates,
      problems: report.problems.map((p) => ({ file: p.file, message: p.message })),
      typeProblems: report.types.problems,
      typesNote: report.types.note ?? null,
    }
  }
}
