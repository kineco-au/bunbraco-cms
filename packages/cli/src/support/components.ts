/** The content types and forms a site declares, which say which components are templates. */
import { existsSync } from 'node:fs'
import type { CromboloConfig } from '@crombolo/server'
import { loadTypes } from './types.ts'

export const declaredTypes = (config: CromboloConfig) =>
  existsSync(config.schemaDir) ? loadTypes(config).set.contentTypes : []

/** The forms whose Send email workflow names `alias` as its e-mail template. */
export const formsNamingEmailTemplate = (config: CromboloConfig, alias: string) =>
  existsSync(config.schemaDir)
    ? (loadTypes(config).set.forms ?? []).filter((form) =>
        form.workflows.some(
          (workflow) => workflow.type === 'sendEmail' && workflow.settings.template === alias,
        ),
      )
    : []
