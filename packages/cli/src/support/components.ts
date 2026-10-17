/** The content types a site declares, which say which components are templates. */
import { existsSync } from 'node:fs'
import type { CromboloConfig } from '@crombolo/server'
import { loadTypes } from './types.ts'

export const declaredTypes = (config: CromboloConfig) =>
  existsSync(config.schemaDir) ? loadTypes(config).set.contentTypes : []
