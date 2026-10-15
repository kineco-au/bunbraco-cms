/**
 * Migration 038 — approval requests (story 028): a request per page sent for
 * approval, a row per stage it reaches, and its history. The workflow it runs
 * under is copied onto the request, so a workflow changed later does not
 * change one already in flight unless the workflow says so. Also gives the
 * groups that edit content the Workflows section. docs/workflows.md.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_DELIVERY_MEMBER_TOKENS } from './delivery-member-tokens.ts'

export const STATE_APPROVALS = '{8e4c0a3d-0038-4b62-9c07-3d5f2b0e6c48}'

/** The section the Workflow screens live in, given where content is edited. */
export const WORKFLOW_SECTION_GROUPS = ['admin', 'editor', 'writer']

export const approvalsMigration: Migration = {
  from: STATE_DELIVERY_MEMBER_TOKENS,
  to: STATE_APPROVALS,
  name: 'AddApprovals',
  kind: 'expand',
  release: '0.13.1',
  async up(db: Db) {
    const t = db.dialect.types
    await db.exec(
      `CREATE TABLE approval_request (
         id ${t.identity},
         key ${t.uuid} NOT NULL,
         node_key ${t.uuid} NOT NULL,
         cultures ${t.text},
         action ${t.varchar(16)} NOT NULL,
         event_id ${t.bigint},
         workflow_key ${t.varchar(64)} NOT NULL,
         workflow_version ${t.varchar(32)} NOT NULL,
         workflow ${t.json} NOT NULL,
         state ${t.varchar(16)} NOT NULL,
         requested_by ${t.varchar(64)} NOT NULL,
         requested_at ${t.timestamp} NOT NULL,
         finished_at ${t.timestamp}
       )`,
    )
    await db.exec('CREATE UNIQUE INDEX ux_approval_request_key ON approval_request (key)')
    await db.exec('CREATE INDEX ix_approval_request_node ON approval_request (node_key, state)')
    await db.exec(
      `CREATE TABLE approval_step (
         id ${t.identity},
         request_id ${t.integer} NOT NULL,
         stage ${t.varchar(64)} NOT NULL,
         state ${t.varchar(16)} NOT NULL,
         reached_at ${t.timestamp} NOT NULL,
         done_at ${t.timestamp}
       )`,
    )
    await db.exec('CREATE INDEX ix_approval_step_request ON approval_step (request_id, state)')
    await db.exec(
      `CREATE TABLE approval_history (
         id ${t.identity},
         request_id ${t.integer} NOT NULL,
         step_id ${t.integer},
         stage ${t.varchar(64)},
         kind ${t.varchar(16)} NOT NULL,
         user_key ${t.varchar(64)},
         comment ${t.text},
         create_date ${t.timestamp} NOT NULL
       )`,
    )
    await db.exec('CREATE INDEX ix_approval_history_request ON approval_history (request_id)')
    for (const alias of WORKFLOW_SECTION_GROUPS)
      await db.exec(
        `INSERT INTO user_group_section (user_group_id, app_alias)
         SELECT g.id, 'workflow' FROM user_group g
         WHERE g.alias = ? AND NOT EXISTS (
           SELECT 1 FROM user_group_section s WHERE s.user_group_id = g.id AND s.app_alias = 'workflow')`,
        [alias],
      )
  },
}
