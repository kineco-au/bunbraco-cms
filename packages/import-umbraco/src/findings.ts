/** What the importer has to say about a source site, in the classes the report groups by. */

export type FindingClass =
  /** Converted; nothing to do. */
  | 'migrates'
  /** Carried across, but somebody has work to do before it behaves as it did. */
  | 'needs-a-person'
  /** Left behind on purpose; the report says how much. */
  | 'dropped'
  /** Could be imported, but this version of the importer does not do it. */
  | 'not-yet'
  /** Has no equivalent here, and never will. */
  | 'cannot-migrate'
  /** Stops `apply` until it is dealt with. */
  | 'blocking'

export interface Finding {
  class: FindingClass
  /** Stable, for a script to match on. */
  code: string
  title: string
  detail?: string
  count?: number
  /** The things this is about: names, paths, aliases. */
  items?: string[]
}

export const CLASS_ORDER: readonly FindingClass[] = [
  'blocking',
  'needs-a-person',
  'cannot-migrate',
  'not-yet',
  'dropped',
  'migrates',
]

export const CLASS_TITLES: Record<FindingClass, string> = {
  blocking: 'Blocking',
  'needs-a-person': 'Needs a person',
  'cannot-migrate': 'Cannot be migrated',
  'not-yet': 'Not imported by this version',
  dropped: 'Left behind',
  migrates: 'Migrates',
}

export class Findings {
  readonly list: Finding[] = []

  add(finding: Finding): void {
    this.list.push(finding)
  }

  /** Adds a finding only when it is about something. */
  some(finding: Finding & { count: number }): void {
    if (finding.count > 0) this.list.push(finding)
  }

  get blocking(): Finding[] {
    return this.list.filter((finding) => finding.class === 'blocking')
  }
}
