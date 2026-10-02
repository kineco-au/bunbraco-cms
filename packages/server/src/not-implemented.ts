/**
 * Development aid: a line on the console the first time the backoffice calls an
 * operation that answers 501, and a running list, so one walk through a
 * section shows everything it still needs.
 */
import type { OperationInfo } from '@bunbraco/contracts'

export interface NotImplementedEntry {
  operationId: string
  method: string
  path: string
  /** How many times it was asked for. */
  count: number
}

export class NotImplementedLog {
  readonly #entries = new Map<string, NotImplementedEntry>()
  readonly #write: (line: string, entry: NotImplementedEntry) => void

  constructor(
    write: (line: string, entry: NotImplementedEntry) => void = (line) => console.warn(line),
  ) {
    this.#write = write
  }

  record(operation: OperationInfo, request: Request): void {
    const existing = this.#entries.get(operation.operationId)
    if (existing) {
      existing.count += 1
      return
    }
    const path = new URL(request.url).pathname
    const entry = { operationId: operation.operationId, method: request.method, path, count: 1 }
    this.#entries.set(operation.operationId, entry)
    this.#write(
      `501 ${operation.operationId.padEnd(40)} ${request.method} ${path}   (${this.#entries.size} missing so far)`,
      entry,
    )
  }

  entries(): NotImplementedEntry[] {
    return [...this.#entries.values()]
  }
}
