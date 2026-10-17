/**
 * Writes a file whole or not at all: to a temporary file beside it, then a
 * rename, so a crash or a second process never sees half of it.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`
  writeFileSync(temporary, data)
  renameSync(temporary, path)
}
