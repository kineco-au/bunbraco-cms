/**
 * Migration 014 — public access: which pages are protected, and by what.
 *
 * Umbraco's `umbracoAccess` + `umbracoAccessRule`, snake-cased. One entry per
 * protected branch root, naming the page to show a caller who is not signed in
 * (`login_node_id`) and the page to show one who is signed in but not allowed
 * (`error_node_id`). The rules are values, not foreign keys — a member group's
 * **name** or a member's **username**, exactly as Umbraco stores them — because
 * a rule is evaluated against the claims a signed-in member carries, and renaming
 * the group is what breaks the rule, not deleting a row.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_MEMBERS } from './members.ts'

export const STATE_PUBLIC_ACCESS = '{6f1d4a8e-0014-4c21-9d3a-8b1e5c7a2f14}'

export const publicAccessMigration: Migration = {
  from: STATE_MEMBERS,
  to: STATE_PUBLIC_ACCESS,
  name: 'AddPublicAccess',
  kind: 'expand',
  release: '0.5.0',
  async up(db: Db) {
    const t = db.dialect.types

    await db.exec(
      `CREATE TABLE public_access (
         id ${t.identity},
         key ${t.text} NOT NULL,
         node_id ${t.integer} NOT NULL REFERENCES node (id),
         login_node_id ${t.integer} NOT NULL REFERENCES node (id),
         error_node_id ${t.integer} NOT NULL REFERENCES node (id),
         create_date ${t.timestamp} NOT NULL,
         update_date ${t.timestamp} NOT NULL
       )`,
    )
    // One entry per protected page, and the render path looks an entry up by node.
    await db.exec('CREATE UNIQUE INDEX ux_public_access_node ON public_access (node_id)')
    await db.exec('CREATE UNIQUE INDEX ux_public_access_key ON public_access (key)')

    await db.exec(
      `CREATE TABLE public_access_rule (
         id ${t.identity},
         public_access_id ${t.integer} NOT NULL REFERENCES public_access (id),
         rule_type ${t.varchar(255)} NOT NULL,
         rule_value ${t.textCi} NOT NULL,
         create_date ${t.timestamp} NOT NULL
       )`,
    )
    await db.exec(
      `CREATE UNIQUE INDEX ux_public_access_rule
         ON public_access_rule (public_access_id, rule_type, rule_value)`,
    )
  },
}
