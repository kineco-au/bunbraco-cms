/**
 * Install seed for the content schema: the system nodes, the default language and
 * the core data types.
 *
 * Data type keys are Umbraco's own, so any documentation or example that
 * references a well-known data type still applies.
 */
import { ObjectTypes, SystemNodes, ValueStorageType } from '@bunbraco/core'
import type { Db } from '../database.ts'
import { DbDate } from '../dialect.ts'

export interface SeedDataType {
  key: string
  alias: string
  name: string
  editorAlias: string
  editorUiAlias: string
  dbType: string
  config?: Record<string, unknown>
}

/** Umbraco's installer configuration for its rich text data type (Tiptap), verbatim. */
export const RICH_TEXT_CONFIG: Record<string, unknown> = {
  extensions: [
    'Umb.Tiptap.RichTextEssentials',
    'Umb.Tiptap.Anchor',
    'Umb.Tiptap.Block',
    'Umb.Tiptap.Blockquote',
    'Umb.Tiptap.Bold',
    'Umb.Tiptap.BulletList',
    'Umb.Tiptap.CodeBlock',
    'Umb.Tiptap.Embed',
    'Umb.Tiptap.Figure',
    'Umb.Tiptap.Heading',
    'Umb.Tiptap.HorizontalRule',
    'Umb.Tiptap.HtmlAttributeClass',
    'Umb.Tiptap.HtmlAttributeDataset',
    'Umb.Tiptap.HtmlAttributeId',
    'Umb.Tiptap.HtmlAttributeStyle',
    'Umb.Tiptap.HtmlTagDiv',
    'Umb.Tiptap.HtmlTagSpan',
    'Umb.Tiptap.Image',
    'Umb.Tiptap.Italic',
    'Umb.Tiptap.Link',
    'Umb.Tiptap.MediaUpload',
    'Umb.Tiptap.OrderedList',
    'Umb.Tiptap.Strike',
    'Umb.Tiptap.Subscript',
    'Umb.Tiptap.Superscript',
    'Umb.Tiptap.Table',
    'Umb.Tiptap.TextAlign',
    'Umb.Tiptap.TextDirection',
    'Umb.Tiptap.TextIndent',
    'Umb.Tiptap.TrailingNode',
    'Umb.Tiptap.Underline',
  ],
  maxImageSize: 500,
  overlaySize: 'medium',
  toolbar: [
    [
      ['Umb.Tiptap.Toolbar.SourceEditor'],
      ['Umb.Tiptap.Toolbar.Bold', 'Umb.Tiptap.Toolbar.Italic', 'Umb.Tiptap.Toolbar.Underline'],
      [
        'Umb.Tiptap.Toolbar.TextAlignLeft',
        'Umb.Tiptap.Toolbar.TextAlignCenter',
        'Umb.Tiptap.Toolbar.TextAlignRight',
      ],
      ['Umb.Tiptap.Toolbar.BulletList', 'Umb.Tiptap.Toolbar.OrderedList'],
      ['Umb.Tiptap.Toolbar.Blockquote', 'Umb.Tiptap.Toolbar.HorizontalRule'],
      ['Umb.Tiptap.Toolbar.Link', 'Umb.Tiptap.Toolbar.Unlink'],
      ['Umb.Tiptap.Toolbar.MediaPicker', 'Umb.Tiptap.Toolbar.EmbeddedMedia'],
    ],
  ],
  // Image and Vector Graphics (SVG)
  allowedMediaTypes: 'cc07b313-0843-4aa8-bbda-871c8da728c8,c4b1efcf-a9d5-41c4-9621-e9d273b52a9c',
}

/** Umbraco's installer configuration for its content and media list views. */
function listViewConfig(collectionViewType: 'Document' | 'Media'): Record<string, unknown> {
  return {
    pageSize: 100,
    orderBy: 'updateDate',
    orderDirection: 'desc',
    layouts: [
      {
        name: 'Grid',
        collectionView: `Umb.CollectionView.${collectionViewType}.Grid`,
        icon: 'icon-thumbnails-small',
        isSystem: true,
        selected: true,
      },
      {
        name: 'List',
        collectionView: `Umb.CollectionView.${collectionViewType}.Table`,
        icon: 'icon-list',
        isSystem: true,
        selected: true,
      },
    ],
    includeProperties: [
      { alias: 'updateDate', header: 'Last edited', isSystem: true },
      { alias: 'creator', header: 'Updated by', isSystem: true },
    ],
  }
}

/**
 * Every data type Umbraco's installer creates, with its keys, names and
 * configuration. Their editor UIs all come from the vendored client, which
 * `tests/vendor.test.ts` holds this list to; ours live in `BUNBRACO_DATA_TYPES`.
 */
export const DEFAULT_DATA_TYPES: readonly SeedDataType[] = [
  {
    key: 'f0bc4bfb-b499-40d6-ba86-058885a5178c',
    alias: 'label',
    name: 'Label (string)',
    editorAlias: 'Umbraco.Label',
    editorUiAlias: 'Umb.PropertyEditorUi.Label',
    dbType: ValueStorageType.Nvarchar,
    config: { umbracoDataValueType: 'STRING' },
  },
  {
    key: '8e7f995c-bd81-4627-9932-c40e568ec788',
    alias: 'labelInt',
    name: 'Label (integer)',
    editorAlias: 'Umbraco.Label',
    editorUiAlias: 'Umb.PropertyEditorUi.Label',
    dbType: ValueStorageType.Integer,
    config: { umbracoDataValueType: 'INT' },
  },
  {
    key: '930861bf-e262-4ead-a704-f99453565708',
    alias: 'labelBigInt',
    name: 'Label (bigint)',
    editorAlias: 'Umbraco.Label',
    editorUiAlias: 'Umb.PropertyEditorUi.Label',
    dbType: ValueStorageType.Nvarchar,
    config: { umbracoDataValueType: 'BIGINT' },
  },
  {
    key: '0e9794eb-f9b5-4f20-a788-93acd233a7e4',
    alias: 'labelDateTime',
    name: 'Label (datetime)',
    editorAlias: 'Umbraco.Label',
    editorUiAlias: 'Umb.PropertyEditorUi.Label',
    dbType: ValueStorageType.Date,
    config: { umbracoDataValueType: 'DATETIME' },
  },
  {
    key: 'a97cec69-9b71-4c30-8b12-ec398860d7e8',
    alias: 'labelTime',
    name: 'Label (time)',
    editorAlias: 'Umbraco.Label',
    editorUiAlias: 'Umb.PropertyEditorUi.Label',
    dbType: ValueStorageType.Date,
    config: { umbracoDataValueType: 'TIME' },
  },
  {
    key: '8f1ef1e1-9de4-40d3-a072-6673f631ca64',
    alias: 'labelDecimal',
    name: 'Label (decimal)',
    editorAlias: 'Umbraco.Label',
    editorUiAlias: 'Umb.PropertyEditorUi.Label',
    dbType: ValueStorageType.Decimal,
    config: { umbracoDataValueType: 'DECIMAL' },
  },
  {
    key: 'ba5bdbe6-ab3e-46a8-82b3-2c45f10bc47f',
    alias: 'labelBytes',
    name: 'Label (bytes)',
    editorAlias: 'Umbraco.Label',
    editorUiAlias: 'Umb.PropertyEditorUi.Label',
    dbType: ValueStorageType.Nvarchar,
    config: { umbracoDataValueType: 'BIGINT', labelTemplate: '{=value | bytes}' },
  },
  {
    key: '5eb57825-e15e-4fc7-8e37-fca65cdafbde',
    alias: 'labelPixels',
    name: 'Label (pixels)',
    editorAlias: 'Umbraco.Label',
    editorUiAlias: 'Umb.PropertyEditorUi.Label',
    dbType: ValueStorageType.Integer,
    config: { umbracoDataValueType: 'INT', labelTemplate: '{=value}px' },
  },
  {
    key: '84c6b441-31df-4ffe-b67e-67d5bc3ae65a',
    alias: 'upload',
    name: 'Upload File',
    editorAlias: 'Umbraco.UploadField',
    editorUiAlias: 'Umb.PropertyEditorUi.UploadField',
    dbType: ValueStorageType.Nvarchar,
  },
  {
    key: '70575fe7-9812-4396-bbe1-c81a76db71b5',
    alias: 'uploadVideo',
    name: 'Upload Video',
    editorAlias: 'Umbraco.UploadField',
    editorUiAlias: 'Umb.PropertyEditorUi.UploadField',
    dbType: ValueStorageType.Nvarchar,
    config: { fileExtensions: ['mp4', 'webm', 'ogv'] },
  },
  {
    key: '8f430dd6-4e96-447e-9dc0-cb552c8cd1f3',
    alias: 'uploadAudio',
    name: 'Upload Audio',
    editorAlias: 'Umbraco.UploadField',
    editorUiAlias: 'Umb.PropertyEditorUi.UploadField',
    dbType: ValueStorageType.Nvarchar,
    config: { fileExtensions: ['mp3', 'weba', 'oga', 'opus'] },
  },
  {
    key: 'bc1e266c-dac4-4164-bf08-8a1ec6a7143d',
    alias: 'uploadArticle',
    name: 'Upload Article',
    editorAlias: 'Umbraco.UploadField',
    editorUiAlias: 'Umb.PropertyEditorUi.UploadField',
    dbType: ValueStorageType.Nvarchar,
    config: { fileExtensions: ['pdf', 'docx', 'doc'] },
  },
  {
    key: '215cb418-2153-4429-9aef-8c0f0041191b',
    alias: 'uploadVectorGraphics',
    name: 'Upload Vector Graphics',
    editorAlias: 'Umbraco.UploadField',
    editorUiAlias: 'Umb.PropertyEditorUi.UploadField',
    dbType: ValueStorageType.Nvarchar,
    config: { fileExtensions: ['svg'] },
  },
  {
    key: 'c6bac0dd-4ab9-45b1-8e30-e4b619ee5da3',
    alias: 'textarea',
    name: 'Textarea',
    editorAlias: 'Umbraco.TextArea',
    editorUiAlias: 'Umb.PropertyEditorUi.TextArea',
    dbType: ValueStorageType.Ntext,
  },
  {
    key: '0cc0eba1-9960-42c9-bf9b-60e150b429ae',
    alias: 'textstring',
    name: 'Textstring',
    editorAlias: 'Umbraco.TextBox',
    editorUiAlias: 'Umb.PropertyEditorUi.TextBox',
    dbType: ValueStorageType.Nvarchar,
  },
  {
    key: 'ca90c950-0aff-4e72-b976-a30b1ac57dad',
    alias: 'richtext',
    name: 'Richtext editor',
    editorAlias: 'Umbraco.RichText',
    editorUiAlias: 'Umb.PropertyEditorUi.Tiptap',
    dbType: ValueStorageType.Ntext,
    config: RICH_TEXT_CONFIG,
  },
  {
    key: '2e6d3631-066e-44b8-aec4-96f09099b2b5',
    alias: 'numeric',
    name: 'Numeric',
    editorAlias: 'Umbraco.Integer',
    editorUiAlias: 'Umb.PropertyEditorUi.Integer',
    dbType: ValueStorageType.Integer,
  },
  {
    key: '92897bc6-a5f3-4ffe-ae27-f2e7e33dda49',
    alias: 'trueFalse',
    name: 'True/false',
    editorAlias: 'Umbraco.TrueFalse',
    editorUiAlias: 'Umb.PropertyEditorUi.Toggle',
    dbType: ValueStorageType.Integer,
  },
  {
    key: 'fbaf13a8-4036-41f2-93a3-974f678c312a',
    alias: 'checkboxList',
    name: 'Checkbox list',
    editorAlias: 'Umbraco.CheckBoxList',
    editorUiAlias: 'Umb.PropertyEditorUi.CheckBoxList',
    dbType: ValueStorageType.Ntext,
  },
  {
    key: '0b6a45e7-44ba-430d-9da5-4e46060b9e03',
    alias: 'dropdown',
    name: 'Dropdown',
    editorAlias: 'Umbraco.DropDown.Flexible',
    editorUiAlias: 'Umb.PropertyEditorUi.Dropdown',
    dbType: ValueStorageType.Nvarchar,
    config: { multiple: false },
  },
  {
    key: '5046194e-4237-453c-a547-15db3a07c4e1',
    alias: 'datePicker',
    name: 'Date Picker',
    editorAlias: 'Umbraco.DateTime',
    editorUiAlias: 'Umb.PropertyEditorUi.DatePicker',
    dbType: ValueStorageType.Date,
    config: { format: 'YYYY-MM-DD' },
  },
  {
    key: 'bb5f57c9-ce2b-4bb9-b697-4caca783a805',
    alias: 'radiobox',
    name: 'Radiobox',
    editorAlias: 'Umbraco.RadioButtonList',
    editorUiAlias: 'Umb.PropertyEditorUi.RadioButtonList',
    dbType: ValueStorageType.Nvarchar,
  },
  {
    key: 'f38f0ac7-1d27-439c-9f3f-089cd8825a53',
    alias: 'dropdownMultiple',
    name: 'Dropdown multiple',
    editorAlias: 'Umbraco.DropDown.Flexible',
    editorUiAlias: 'Umb.PropertyEditorUi.Dropdown',
    dbType: ValueStorageType.Nvarchar,
    config: { multiple: true },
  },
  {
    key: '0225af17-b302-49cb-9176-b9f35cab9c17',
    alias: 'approvedColor',
    name: 'Approved Color',
    editorAlias: 'Umbraco.ColorPicker',
    editorUiAlias: 'Umb.PropertyEditorUi.ColorPicker',
    dbType: ValueStorageType.Nvarchar,
  },
  {
    key: 'e4d66c0f-b935-4200-81f0-025f7256b89a',
    alias: 'datePickerWithTime',
    name: 'Date Picker with time',
    editorAlias: 'Umbraco.DateTime',
    editorUiAlias: 'Umb.PropertyEditorUi.DatePicker',
    dbType: ValueStorageType.Date,
    config: { format: 'YYYY-MM-DD HH:mm:ss' },
  },
  {
    key: 'c0808dd3-8133-4e4b-8ce8-e2bea84a96a4',
    alias: 'listViewContent',
    name: 'List View - Content',
    editorAlias: 'Umbraco.ListView',
    editorUiAlias: 'Umb.PropertyEditorUi.Collection',
    dbType: ValueStorageType.Nvarchar,
    config: listViewConfig('Document'),
  },
  {
    key: '3a0156c4-3b8c-4803-bdc1-6871faa83fff',
    alias: 'listViewMedia',
    name: 'List View - Media',
    editorAlias: 'Umbraco.ListView',
    editorUiAlias: 'Umb.PropertyEditorUi.Collection',
    dbType: ValueStorageType.Nvarchar,
    config: listViewConfig('Media'),
  },
  {
    key: 'b6b73142-b9c1-4bf8-a16d-e1c23320b549',
    alias: 'tags',
    name: 'Tags',
    editorAlias: 'Umbraco.Tags',
    editorUiAlias: 'Umb.PropertyEditorUi.Tags',
    dbType: ValueStorageType.Ntext,
    config: { group: 'default', storageType: 'Json' },
  },
  {
    key: '1df9f033-e6d4-451f-b8d2-e0cbc50a836f',
    alias: 'imageCropper',
    name: 'Image Cropper',
    editorAlias: 'Umbraco.ImageCropper',
    editorUiAlias: 'Umb.PropertyEditorUi.ImageCropper',
    dbType: ValueStorageType.Ntext,
  },
  {
    key: 'fd1e0da5-5606-4862-b679-5d0cf3a52a59',
    alias: 'contentPicker',
    name: 'Content Picker',
    editorAlias: 'Umbraco.ContentPicker',
    editorUiAlias: 'Umb.PropertyEditorUi.DocumentPicker',
    dbType: ValueStorageType.Nvarchar,
  },
  {
    key: '1ea2e01f-ebd8-4ce1-8d71-6b1149e63548',
    alias: 'memberPicker',
    name: 'Member Picker',
    editorAlias: 'Umbraco.MemberPicker',
    editorUiAlias: 'Umb.PropertyEditorUi.MemberPicker',
    dbType: ValueStorageType.Nvarchar,
  },
  {
    key: 'b4e3535a-1753-47e2-8568-602cf8cfee6f',
    alias: 'multiUrlPicker',
    name: 'Multi URL Picker',
    editorAlias: 'Umbraco.MultiUrlPicker',
    editorUiAlias: 'Umb.PropertyEditorUi.MultiUrlPicker',
    dbType: ValueStorageType.Ntext,
  },
  {
    key: '4309a3ea-0d78-4329-a06c-c80b036af19a',
    alias: 'mediaPicker',
    name: 'Media Picker',
    editorAlias: 'Umbraco.MediaPicker3',
    editorUiAlias: 'Umb.PropertyEditorUi.MediaPicker',
    dbType: ValueStorageType.Ntext,
    config: { multiple: false, validationLimit: { min: 0, max: 1 } },
  },
  {
    key: '1b661f40-2242-4b44-b9cb-3990ee2b13c0',
    alias: 'multipleMediaPicker',
    name: 'Multiple Media Picker',
    editorAlias: 'Umbraco.MediaPicker3',
    editorUiAlias: 'Umb.PropertyEditorUi.MediaPicker',
    dbType: ValueStorageType.Ntext,
    config: { multiple: true },
  },
  {
    key: 'ad9f0cf2-bda2-45d5-9ea1-a63cfc873fd3',
    alias: 'imageMediaPicker',
    name: 'Image Media Picker',
    editorAlias: 'Umbraco.MediaPicker3',
    editorUiAlias: 'Umb.PropertyEditorUi.MediaPicker',
    dbType: ValueStorageType.Ntext,
    config: {
      filter: 'cc07b313-0843-4aa8-bbda-871c8da728c8',
      multiple: false,
      validationLimit: { min: 0, max: 1 },
    },
  },
  {
    key: '0e63d883-b62b-4799-88c3-157f82e83ecc',
    alias: 'multipleImageMediaPicker',
    name: 'Multiple Image Media Picker',
    editorAlias: 'Umbraco.MediaPicker3',
    editorUiAlias: 'Umb.PropertyEditorUi.MediaPicker',
    dbType: ValueStorageType.Ntext,
    config: { filter: 'cc07b313-0843-4aa8-bbda-871c8da728c8', multiple: true },
  },
  {
    key: '88e8a052-30ee-4d44-a507-59f2cdfc769c',
    alias: 'dateTimeWithTimeZone',
    name: 'Date Time Picker (with time zone)',
    editorAlias: 'Umbraco.DateTimeWithTimeZone',
    editorUiAlias: 'Umb.PropertyEditorUi.DateTimeWithTimeZonePicker',
    dbType: ValueStorageType.Ntext,
    config: { timeFormat: 'HH:mm', timeZones: { mode: 'all' } },
  },
] as const

export const DEFAULT_LANGUAGE = { isoCode: 'en-US', cultureName: 'English (United States)' }

async function tableIsEmpty(db: Db, table: string): Promise<boolean> {
  const rows = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
  return Number(rows[0]?.n ?? 0) === 0
}

/** Idempotent. */
export async function seedContent(db: Db): Promise<boolean> {
  if (!(await tableIsEmpty(db, 'node'))) return false
  const now = DbDate.toDb(new Date())
  const bool = (value: boolean) => db.dialect.boolValue(value)

  const systemNodes = [
    { id: SystemNodes.Root, text: 'SystemRoot', objectType: ObjectTypes.SystemRoot, path: '-1' },
    {
      id: SystemNodes.ContentRecycleBin,
      text: 'Recycle Bin',
      objectType: ObjectTypes.ContentRecycleBin,
      path: '-1,-20',
    },
    {
      id: SystemNodes.MediaRecycleBin,
      text: 'Recycle Bin',
      objectType: ObjectTypes.MediaRecycleBin,
      path: '-1,-21',
    },
    {
      id: SystemNodes.ElementRecycleBin,
      text: 'Recycle Bin',
      objectType: ObjectTypes.ElementRecycleBin,
      path: '-1,-22',
    },
  ]
  for (const node of systemNodes) {
    await db.exec(
      `INSERT INTO node
         (id, unique_id, parent_id, level, path, sort_order, trashed, text, node_object_type, create_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        node.id,
        crypto.randomUUID(),
        node.id === SystemNodes.Root ? -1 : SystemNodes.Root,
        0,
        node.path,
        0,
        bool(false),
        node.text,
        node.objectType,
        now,
      ],
    )
  }

  await db.exec(
    `INSERT INTO language (iso_code, culture_name, is_default, is_mandatory)
     VALUES (?, ?, ?, ?)`,
    [DEFAULT_LANGUAGE.isoCode, DEFAULT_LANGUAGE.cultureName, bool(true), bool(true)],
  )

  let sortOrder = 0
  for (const dataType of ALL_SEEDED_DATA_TYPES) await insertDataType(db, dataType, sortOrder++)
  return true
}

/**
 * Data types this CMS adds, whose editor UIs come from our own plugin rather
 * than from the vendored client. Seeded and ensured exactly as Umbraco's are.
 */
export const BUNBRACO_DATA_TYPES: readonly SeedDataType[] = [
  {
    key: '9c4a7d1e-0100-4b2a-9f31-6d8e2c5a7b40',
    alias: 'formPicker',
    name: 'Form Picker',
    editorAlias: 'Bunbraco.FormPicker',
    editorUiAlias: 'Bunbraco.PropertyEditorUi.FormPicker',
    // The form's UUID, from `schema/forms/*.toml`. A string rather than a
    // reference: the definition is a file, so there is no row to point at.
    dbType: ValueStorageType.Nvarchar,
    config: {},
  },
]

/** Every data type that needs no file, Umbraco's and ours. */
export const ALL_SEEDED_DATA_TYPES: readonly SeedDataType[] = [
  ...DEFAULT_DATA_TYPES,
  ...BUNBRACO_DATA_TYPES,
]

/** One built-in data type, as the seed and the boot-time ensure both write it. */
async function insertDataType(db: Db, dataType: SeedDataType, sortOrder: number): Promise<void> {
  const now = DbDate.toDb(new Date())
  const bool = (value: boolean) => db.dialect.boolValue(value)
  await db.exec(
    `INSERT INTO node
         (unique_id, parent_id, level, path, sort_order, trashed, text, node_object_type, create_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      dataType.key,
      SystemNodes.Root,
      1,
      `-1`,
      sortOrder,
      bool(false),
      dataType.name,
      ObjectTypes.DataType,
      now,
    ],
  )
  const created = await db.query<{ id: number }>('SELECT id FROM node WHERE unique_id = ?', [
    dataType.key,
  ])
  const nodeId = Number(created[0]?.id)
  await db.exec(`UPDATE node SET path = ? WHERE id = ?`, [`-1,${nodeId}`, nodeId])
  await db.exec(
    `INSERT INTO data_type (node_id, alias, editor_alias, editor_ui_alias, db_type, config)
       VALUES (?, ?, ?, ?, ?, ?)`,
    [
      nodeId,
      dataType.alias,
      dataType.editorAlias,
      dataType.editorUiAlias,
      dataType.dbType,
      JSON.stringify(dataType.config ?? {}),
    ],
  )
}

/**
 * Inserts any built-in data type a database seeded by an older version lacks,
 * by its fixed key. Never changes one that exists. Idempotent; runs at boot.
 */
export async function ensureBuiltInDataTypes(db: Db): Promise<string[]> {
  const added: string[] = []
  const count = await db.query<{ n: number }>(
    'SELECT COUNT(*) AS n FROM node WHERE node_object_type = ?',
    [ObjectTypes.DataType],
  )
  let sortOrder = Number(count[0]?.n ?? 0)
  for (const dataType of ALL_SEEDED_DATA_TYPES) {
    const found = await db.query('SELECT id FROM node WHERE unique_id = ?', [dataType.key])
    if (found.length > 0) continue
    await insertDataType(db, dataType, sortOrder++)
    added.push(dataType.alias)
  }
  return added
}
