/**
 * The strict TOML reader both schema parsers use.
 *
 * Strict by design: an unknown key is an error, because a misspelt key is the
 * most common mistake a non-developer makes and silently ignoring it would hide
 * the thing they were trying to do. Every problem carries a dotted path, so a
 * message points at a line rather than at a file.
 */
import type { SchemaProblem } from './model.ts'

export type Toml = Record<string, unknown>

export interface ParseResult<T> {
  value: T | undefined
  problems: SchemaProblem[]
}

export class Reader {
  readonly problems: SchemaProblem[] = []
  constructor(readonly file: string) {}

  problem(path: string, message: string): void {
    this.problems.push({ file: this.file, path, message })
  }

  table(value: unknown, path: string): Toml | undefined {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Toml
    this.problem(path, 'expected a table')
    return undefined
  }

  tables(value: unknown, path: string): Toml[] {
    if (value === undefined) return []
    if (!Array.isArray(value)) {
      this.problem(path, 'expected an array of tables ([[...]])')
      return []
    }
    return value.filter((v, i) => this.table(v, `${path}[${i}]`) !== undefined) as Toml[]
  }

  str(t: Toml, key: string, path: string, required = false): string | undefined {
    const v = t[key]
    if (v === undefined) {
      if (required) this.problem(`${path}.${key}`, 'is required')
      return undefined
    }
    if (typeof v !== 'string') {
      this.problem(`${path}.${key}`, 'expected a string')
      return undefined
    }
    return v
  }

  bool(t: Toml, key: string, path: string, fallback: boolean): boolean {
    const v = t[key]
    if (v === undefined) return fallback
    if (typeof v !== 'boolean') {
      this.problem(`${path}.${key}`, 'expected true or false')
      return fallback
    }
    return v
  }

  num(t: Toml, key: string, path: string): number | undefined {
    const v = t[key]
    if (v === undefined) return undefined
    if (typeof v !== 'number') {
      this.problem(`${path}.${key}`, 'expected a number')
      return undefined
    }
    return v
  }

  strs(t: Toml, key: string, path: string): string[] {
    const v = t[key]
    if (v === undefined) return []
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      this.problem(`${path}.${key}`, 'expected an array of strings')
      return []
    }
    return v as string[]
  }

  unknown(t: Toml, allowed: readonly string[], path: string): void {
    for (const key of Object.keys(t)) {
      if (!allowed.includes(key))
        this.problem(`${path}.${key}`, `unknown key; expected one of ${allowed.join(', ')}`)
    }
  }
}

export function toml(source: string, r: Reader): Toml | undefined {
  try {
    return Bun.TOML.parse(source) as Toml
  } catch (error) {
    r.problem('', `invalid TOML: ${(error as Error).message}`)
    return undefined
  }
}
