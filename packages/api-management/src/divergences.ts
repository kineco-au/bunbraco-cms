/**
 * Operations that answer 501 on purpose, with the reason; `coverage:api` lists
 * them apart from what is still to build. docs/roadmap.md, "Deliberate divergence".
 */
const INSTALL =
  'There is no browser install wizard: `crombolo init` and schema-as-code stand a site up.'
const UPGRADE =
  'Upgrades run from the command line with `crombolo upgrade`, not from the backoffice.'

export const DELIBERATE_DIVERGENCES: Readonly<Record<string, string>> = {
  GetInstallSettings: INSTALL,
  PostInstallSetup: INSTALL,
  PostInstallValidateDatabase: INSTALL,
  GetUpgradeSettings: UPGRADE,
  PostUpgradeAuthorize: UPGRADE,
}

/** Areas still to build, by the story that builds them. */
export const PLANNED_AREAS: Readonly<Record<string, string>> = {}

/** Operations outside those areas that a story builds. */
export const PLANNED_OPERATIONS: Readonly<Record<string, string>> = {}
