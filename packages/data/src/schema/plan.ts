/**
 * The migration chain. Append new migrations; never edit a released one.
 *
 * Every step here declares `release: '0.3.0'`, because 0.3.0 is the first release
 * there has ever been: nothing was published before the repository was split, so
 * none of these shipped in any earlier version, whatever the numbers said while
 * they were being written.
 *
 * `release` is compared between a contract and the expand it removes — a
 * contract may only take away what an *earlier* release added — and a contract
 * may only ship in a major (`x.0.0`), because every minor and patch is rolled
 * under live nodes. The first contract will therefore name 1.0.0 at the earliest.
 */
import { MigrationPlan } from '../migrations.ts'
import { assistantMigration } from './assistant.ts'
import { bundlesRenameMigration } from './bundles-rename.ts'
import { changeReportMigration } from './change-report.ts'
import { clientIdPrefixMigration } from './client-id-prefix.ts'
import { contentMigration } from './content.ts'
import { contentEditingMigration } from './content-editing.ts'
import { createdPackagesMigration } from './created-packages.ts'
import { elementsMigration } from './elements.ts'
import { formPermissionPrefixMigration } from './form-permission-prefix.ts'
import { formPermissionsMigration } from './form-permissions.ts'
import { formWorkflowsMigration } from './form-workflows.ts'
import { formsMigration } from './forms.ts'
import { groupPermissionsMigration } from './group-permissions.ts'
import { identityMigration } from './identity.ts'
import { logViewerMigration } from './log-viewer.ts'
import { memberPropertyTypeMigration } from './member-property-type.ts'
import { membersMigration } from './members.ts'
import { publicAccessMigration } from './public-access.ts'
import { recycleBinMigration } from './recycle-bin.ts'
import { redirectsMigration } from './redirects.ts'
import { richTextUiMigration } from './rich-text-ui.ts'
import { serverRoleMigration } from './server-role.ts'
import { sinceVersionMigration } from './since-version.ts'
import { transferRunsMigration } from './transfer-runs.ts'
import { upgradeReportMigration } from './upgrade-report.ts'
import { usersLocalisationMigration } from './users-localisation.ts'
import { valuesMigration } from './values.ts'

export const bunbracoPlan = new MigrationPlan([
  identityMigration,
  contentMigration,
  valuesMigration,
  sinceVersionMigration,
  upgradeReportMigration,
  recycleBinMigration,
  groupPermissionsMigration,
  memberPropertyTypeMigration,
  richTextUiMigration,
  contentEditingMigration,
  usersLocalisationMigration,
  logViewerMigration,
  membersMigration,
  publicAccessMigration,
  redirectsMigration,
  elementsMigration,
  assistantMigration,
  changeReportMigration,
  transferRunsMigration,
  clientIdPrefixMigration,
  serverRoleMigration,
  createdPackagesMigration,
  formsMigration,
  formWorkflowsMigration,
  formPermissionsMigration,
  formPermissionPrefixMigration,
  bundlesRenameMigration,
])
