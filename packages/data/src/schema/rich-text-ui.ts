/**
 * Migration 009 — the rich text data type's editor UI. Databases seeded
 * before this carry `Umb.PropertyEditorUi.RichText`, which the backoffice does
 * not register ("The configured property editor UI could not be found");
 * Umbraco seeds `Umb.PropertyEditorUi.Tiptap` with its configuration. Only a
 * row still carrying the wrong alias is changed; a customised one is left.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { RICH_TEXT_CONFIG } from './content-seed.ts'
import { STATE_MEMBER_PROPERTY_TYPE } from './member-property-type.ts'

export const STATE_RICH_TEXT_UI = '{6f1d4a8e-0009-4c21-9d3a-8b1e5c7a2f09}'

export const richTextUiMigration: Migration = {
  from: STATE_MEMBER_PROPERTY_TYPE,
  to: STATE_RICH_TEXT_UI,
  name: 'FixRichTextEditorUi',
  kind: 'expand',
  release: '0.3.0',
  async up(db: Db) {
    await db.exec(
      `UPDATE data_type SET editor_ui_alias = ?, config = ?
       WHERE editor_ui_alias = ?
         AND node_id = (SELECT id FROM node WHERE unique_id = ?)`,
      [
        'Umb.PropertyEditorUi.Tiptap',
        JSON.stringify(RICH_TEXT_CONFIG),
        'Umb.PropertyEditorUi.RichText',
        'ca90c950-0aff-4e72-b976-a30b1ac57dad',
      ],
    )
  },
}
