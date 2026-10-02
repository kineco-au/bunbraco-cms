/**
 * Migration 002 — the content schema.
 *
 * `node` is the universal polymorphic tree; every other table here is a facet of
 * it. See docs/02-data-model.md for the model and why it is kept.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_IDENTITY } from './identity.ts'

export const STATE_CONTENT = '{6f1d4a8e-0002-4c21-9d3a-8b1e5c7a2f02}'

export const contentMigration: Migration = {
  from: STATE_IDENTITY,
  to: STATE_CONTENT,
  name: 'CreateContentSchema',
  kind: 'expand',
  release: '0.3.0',
  async up(db: Db) {
    const t = db.dialect.types

    /**
     * The tree. `path` is a materialised ancestor list ("-1,1060,1075") so a
     * descendant query is a prefix match rather than a recursive walk.
     */
    await db.exec(
      `CREATE TABLE node (
         id ${t.identity},
         unique_id ${t.uuid} NOT NULL UNIQUE,
         parent_id ${t.integer} NOT NULL,
         level ${t.integer} NOT NULL,
         path ${t.varchar(150)} NOT NULL,
         sort_order ${t.integer} NOT NULL,
         trashed ${t.boolean} NOT NULL,
         node_user ${t.integer},
         text ${t.textCi},
         node_object_type ${t.uuid},
         create_date ${t.timestamp} NOT NULL
       )`,
    )
    await db.exec('CREATE INDEX ix_node_parent_object ON node (parent_id, node_object_type)')
    await db.exec(
      'CREATE INDEX ix_node_object_trashed_sort ON node (node_object_type, trashed, sort_order, id)',
    )
    await db.exec('CREATE INDEX ix_node_path ON node (path)')
    await db.exec('CREATE INDEX ix_node_trashed ON node (trashed)')

    await db.exec(
      `CREATE TABLE language (
         id ${t.identity},
         iso_code ${t.varchar(14)} NOT NULL UNIQUE,
         culture_name ${t.varchar(100)} NOT NULL,
         is_default ${t.boolean} NOT NULL,
         is_mandatory ${t.boolean} NOT NULL,
         fallback_language_id ${t.integer}
       )`,
    )

    await db.exec(
      `CREATE TABLE data_type (
         node_id ${t.integer} PRIMARY KEY REFERENCES node (id),
         editor_alias ${t.varchar(255)} NOT NULL,
         editor_ui_alias ${t.varchar(255)},
         db_type ${t.varchar(50)} NOT NULL,
         config ${t.text}
       )`,
    )

    /**
     * The view file lives on disk at Views/{alias}.tsx; the layout chain is
     * declared in the file itself, exactly as Umbraco parses it out of Razor.
     */
    await db.exec(
      `CREATE TABLE template (
         node_id ${t.integer} PRIMARY KEY REFERENCES node (id),
         alias ${t.varchar(100)} NOT NULL
       )`,
    )
    await db.exec('CREATE UNIQUE INDEX ux_template_alias ON template (alias)')

    await db.exec(
      `CREATE TABLE content_type (
         node_id ${t.integer} PRIMARY KEY REFERENCES node (id),
         alias ${t.textCi} NOT NULL,
         icon ${t.varchar(255)},
         thumbnail ${t.varchar(255)},
         description ${t.varchar(1500)},
         list_view ${t.uuid},
         is_element ${t.boolean} NOT NULL,
         allow_in_library ${t.boolean} NOT NULL,
         allow_at_root ${t.boolean} NOT NULL,
         variations ${t.integer} NOT NULL,
         prevent_cleanup ${t.boolean} NOT NULL,
         keep_all_versions_newer_than_days ${t.integer},
         keep_latest_version_per_day_for_days ${t.integer}
       )`,
    )
    await db.exec('CREATE UNIQUE INDEX ux_content_type_alias ON content_type (alias)')

    await db.exec(
      `CREATE TABLE property_type_group (
         id ${t.identity},
         unique_id ${t.uuid} NOT NULL UNIQUE,
         content_type_node_id ${t.integer} NOT NULL REFERENCES content_type (node_id),
         type ${t.integer} NOT NULL,
         text ${t.varchar(255)},
         alias ${t.varchar(255)},
         sort_order ${t.integer} NOT NULL,
         parent_id ${t.integer}
       )`,
    )

    await db.exec(
      `CREATE TABLE property_type (
         id ${t.identity},
         unique_id ${t.uuid} NOT NULL UNIQUE,
         data_type_id ${t.integer} NOT NULL REFERENCES data_type (node_id),
         content_type_id ${t.integer} NOT NULL REFERENCES content_type (node_id),
         property_type_group_id ${t.integer} REFERENCES property_type_group (id),
         alias ${t.textCi} NOT NULL,
         name ${t.varchar(255)} NOT NULL,
         description ${t.varchar(2000)},
         sort_order ${t.integer} NOT NULL,
         mandatory ${t.boolean} NOT NULL,
         mandatory_message ${t.varchar(500)},
         validation_reg_exp ${t.text},
         validation_reg_exp_message ${t.varchar(500)},
         label_on_top ${t.boolean} NOT NULL,
         variations ${t.integer} NOT NULL
       )`,
    )
    await db.exec(
      'CREATE UNIQUE INDEX ux_property_type_alias ON property_type (content_type_id, alias)',
    )

    /**
     * The composition graph, which is NOT the folder tree: `node.parent_id`
     * places a type in a folder, while this table says which types it inherits
     * properties from.
     */
    await db.exec(
      `CREATE TABLE content_type_composition (
         parent_content_type_id ${t.integer} NOT NULL REFERENCES node (id),
         child_content_type_id ${t.integer} NOT NULL REFERENCES node (id),
         PRIMARY KEY (parent_content_type_id, child_content_type_id)
       )`,
    )

    await db.exec(
      `CREATE TABLE content_type_allowed_child (
         content_type_id ${t.integer} NOT NULL REFERENCES content_type (node_id),
         allowed_content_type_id ${t.integer} NOT NULL REFERENCES content_type (node_id),
         sort_order ${t.integer} NOT NULL,
         PRIMARY KEY (content_type_id, allowed_content_type_id)
       )`,
    )

    await db.exec(
      `CREATE TABLE content_type_template (
         content_type_node_id ${t.integer} NOT NULL REFERENCES content_type (node_id),
         template_node_id ${t.integer} NOT NULL REFERENCES template (node_id),
         is_default ${t.boolean} NOT NULL,
         PRIMARY KEY (content_type_node_id, template_node_id)
       )`,
    )

    // ---- documents and versions (Phase 4 uses these) ----

    await db.exec(
      `CREATE TABLE content (
         node_id ${t.integer} PRIMARY KEY REFERENCES node (id),
         content_type_id ${t.integer} NOT NULL REFERENCES content_type (node_id)
       )`,
    )
    await db.exec('CREATE INDEX ix_content_content_type ON content (content_type_id)')

    /** `current = true` marks the draft; exactly one row per node. */
    await db.exec(
      `CREATE TABLE content_version (
         id ${t.identity},
         node_id ${t.integer} NOT NULL REFERENCES content (node_id),
         version_date ${t.timestamp} NOT NULL,
         user_id ${t.integer},
         current ${t.boolean} NOT NULL,
         text ${t.textCi},
         prevent_cleanup ${t.boolean} NOT NULL
       )`,
    )
    await db.exec(
      'CREATE INDEX ix_content_version_node_current ON content_version (node_id, current)',
    )
    await db.exec('CREATE INDEX ix_content_version_date ON content_version (version_date)')

    await db.exec(
      `CREATE TABLE document (
         node_id ${t.integer} PRIMARY KEY REFERENCES content (node_id),
         published ${t.boolean} NOT NULL,
         edited ${t.boolean} NOT NULL
       )`,
    )
    await db.exec('CREATE INDEX ix_document_published ON document (published)')

    /** `published = true` marks the published version; at most one per document. */
    await db.exec(
      `CREATE TABLE document_version (
         id ${t.integer} PRIMARY KEY REFERENCES content_version (id),
         template_id ${t.integer} REFERENCES template (node_id),
         published ${t.boolean} NOT NULL
       )`,
    )

    /**
     * Property values. Five typed columns selected by `data_type.db_type`; the
     * unique key is the value's identity.
     */
    await db.exec(
      `CREATE TABLE property_data (
         id ${t.identity},
         version_id ${t.integer} NOT NULL REFERENCES content_version (id),
         property_type_id ${t.integer} NOT NULL REFERENCES property_type (id),
         language_id ${t.integer} REFERENCES language (id),
         segment ${t.varchar(256)},
         int_value ${t.integer},
         decimal_value ${t.numeric},
         date_value ${t.timestamp},
         varchar_value ${t.varchar(512)},
         text_value ${t.text},
         sortable_value ${t.varchar(512)}
       )`,
    )
    // A NULL language or segment means invariant/neutral, and NULLs do not
    // compare equal, so uniqueness is enforced over coalesced sentinels.
    await db.exec(
      `CREATE UNIQUE INDEX ux_property_data ON property_data
         (version_id, property_type_id, COALESCE(language_id, -1), COALESCE(segment, ''))`,
    )

    await db.exec(
      `CREATE TABLE content_version_culture_variation (
         id ${t.identity},
         version_id ${t.integer} NOT NULL REFERENCES content_version (id),
         language_id ${t.integer} NOT NULL REFERENCES language (id),
         name ${t.textCi} NOT NULL,
         date ${t.timestamp} NOT NULL,
         available_user_id ${t.integer},
         UNIQUE (version_id, language_id)
       )`,
    )

    await db.exec(
      `CREATE TABLE document_culture_variation (
         id ${t.identity},
         node_id ${t.integer} NOT NULL REFERENCES node (id),
         language_id ${t.integer} NOT NULL REFERENCES language (id),
         edited ${t.boolean} NOT NULL,
         available ${t.boolean} NOT NULL,
         published ${t.boolean} NOT NULL,
         name ${t.textCi},
         UNIQUE (node_id, language_id)
       )`,
    )
  },
}
