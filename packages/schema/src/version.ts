/**
 * The site's schema version, and what a change does to it.
 *
 * A developer owns this number when schema arrives by deploy. When an editor
 * changes a type on a running site the number still has to move, for two
 * reasons: `compareStates` reads it first, so it is how other nodes learn they
 * are behind, and a production sync refuses a changed hash at an unchanged
 * version — the guard that makes silent drift impossible.
 *
 * How far it moves is decided by the same check that gates an upgrade, so the
 * number means something: a major says content had to be converted to get here.
 */
import type { ChangeClass } from './check.ts'

/** `1.4.2` → `[1, 4, 2]`, tolerant of a short or over-long version. */
function parts(version: string): [number, number, number] {
  // `??` will not do: parseInt('') is NaN, which is neither null nor undefined,
  // and `NaN + 1` would spread through the whole version.
  const at = (index: number): number => {
    const parsed = Number.parseInt(version.split('.')[index] ?? '', 10)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return [at(0), at(1), at(2)]
}

/**
 * The version a change should land on.
 *
 * - `breaking` — a property's editor changed under live content, or a type with
 *   content was removed: **major**, because getting here converted data.
 * - `data-requiring` — a new mandatory property, or a value migration to run:
 *   **minor**. Content has to be filled in, but nothing was lost.
 * - `additive` — a new type or property: **minor**.
 * - `none` — nothing to apply, so nothing to bump.
 *
 * A major resets what is below it, as semver does, so 1.4.2 breaking is 2.0.0
 * rather than 2.4.2.
 */
export function nextSchemaVersion(current: string, classification: ChangeClass): string {
  const [major, minor, patch] = parts(current)
  switch (classification) {
    case 'breaking':
      return `${major + 1}.0.0`
    case 'data-requiring':
    case 'additive':
      return `${major}.${minor + 1}.0`
    default:
      return `${major}.${minor}.${patch}`
  }
}

/** Whether a classification moves the version at all. */
export const bumps = (classification: ChangeClass): boolean => classification !== 'none'
