/**
 * Migration 024 — the queue a form's workflows run from. `docs/18-forms.md`.
 *
 * A submission is stored and *then* its workflows run, so a mail server being
 * down never loses an entry. That means a row per workflow per submission,
 * claimed one node at a time and retried with a backoff.
 *
 * The values are carried on the row rather than read back from the entry,
 * because a form may store no entries at all and still have workflows — the
 * schema validator insists on exactly that, since a form that does neither has
 * no effect.
 *
 * `run_on` rather than `trigger`: the latter is a reserved word in Postgres.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_FORMS } from './forms.ts'

export const STATE_FORM_WORKFLOWS = '{6f1d4a8e-0024-4e72-9a55-3d7c1b8e4f02}'

export const formWorkflowsMigration: Migration = {
  from: STATE_FORMS,
  to: STATE_FORM_WORKFLOWS,
  name: 'AddFormWorkflowRuns',
  kind: 'expand',
  release: '0.5.0',
  async up(db: Db) {
    const t = db.dialect.types

    await db.exec(
      `CREATE TABLE form_workflow_run (
         id ${t.varchar(64)} NOT NULL,
         form_key ${t.varchar(64)} NOT NULL,
         form_alias ${t.varchar(255)} NOT NULL,
         workflow_name ${t.varchar(255)} NOT NULL,
         workflow_type ${t.varchar(32)} NOT NULL,
         run_on ${t.varchar(16)} NOT NULL,
         entry_id ${t.varchar(64)},
         payload ${t.text} NOT NULL,
         state ${t.varchar(16)} NOT NULL,
         attempts ${t.integer} NOT NULL,
         last_error ${t.text},
         run_after ${t.timestamp} NOT NULL,
         create_date ${t.timestamp} NOT NULL,
         update_date ${t.timestamp} NOT NULL,
         PRIMARY KEY (id)
       )`,
    )
    // The only query the runner makes: what is due now.
    await db.exec('CREATE INDEX ix_form_workflow_run_due ON form_workflow_run (state, run_after)')
    // And what the backoffice shows against one form.
    await db.exec('CREATE INDEX ix_form_workflow_run_form ON form_workflow_run (form_key)')
  },
}
