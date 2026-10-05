/**
 * Content types as Umbraco's `.udt` XML, the format its Export and Import
 * buttons exchange — so a type exported from an Umbraco site imports here and
 * the other way round.
 *
 * The element names are Umbraco's `EntityXmlSerializer`: `Info`, `Structure`,
 * `GenericProperties` and `Tabs`, with the root naming the kind. Aliases are
 * the currency throughout — a composition, an allowed child and a template are
 * all referenced by alias, because keys differ between sites.
 */
import type { ContentTypeAggregate } from '@bunbraco/core'
import type { ContentTypeKind } from '@bunbraco/data'
import { escapeText, parseXml, type XmlElement } from './udt.ts'

const ROOT = {
  document: 'DocumentType',
  media: 'MediaType',
  member: 'MemberType',
} as const satisfies Record<ContentTypeKind, string>

const KIND_OF: Record<string, ContentTypeKind> = {
  DocumentType: 'document',
  MediaType: 'media',
  MemberType: 'member',
}

/** Umbraco writes .NET's `True`/`False` and its `ContentVariation` names. */
const bool = (value: boolean) => (value ? 'True' : 'False')

function variations(aggregate: { variesByCulture: boolean; variesBySegment: boolean }): string {
  if (aggregate.variesByCulture && aggregate.variesBySegment) return 'CultureAndSegment'
  if (aggregate.variesByCulture) return 'Culture'
  if (aggregate.variesBySegment) return 'Segment'
  return 'Nothing'
}

const tag = (name: string, value: string | null | undefined, indent: string) =>
  value === null || value === undefined ? '' : `${indent}<${name}>${escapeText(value)}</${name}>\n`

export interface UdtContext {
  /** Alias of a content type by key, for compositions and allowed children. */
  aliasOf(key: string): string | undefined
  /** Alias of a template by key, for the allowed and default templates. */
  templateAliasOf(key: string): string | undefined
}

export function writeContentTypeUdt(
  aggregate: ContentTypeAggregate,
  kind: ContentTypeKind,
  context: UdtContext,
): string {
  const root = ROOT[kind]
  const groupOf = new Map(aggregate.containers.map((container) => [container.key, container]))

  let info = ''
  info += tag('Name', aggregate.name, '    ')
  info += tag('Alias', aggregate.alias, '    ')
  info += tag('Key', aggregate.key, '    ')
  info += tag('Icon', aggregate.icon, '    ')
  info += tag('Thumbnail', '', '    ')
  info += tag('Description', aggregate.description ?? '', '    ')
  info += tag('AllowAtRoot', bool(aggregate.allowedAsRoot), '    ')
  info += tag('IsListView', bool(aggregate.collectionKey !== null), '    ')
  info += tag('IsElement', bool(aggregate.isElement), '    ')
  info += tag('AllowedInLibrary', bool(aggregate.allowedInLibrary), '    ')
  info += tag('Variations', variations(aggregate), '    ')
  if (kind === 'document') {
    const templates = aggregate.allowedComponentKeys
      .map((key) => context.templateAliasOf(key))
      .filter((alias): alias is string => !!alias)
    info += `    <AllowedTemplates>\n${templates.map((a) => tag('Template', a, '      ')).join('')}    </AllowedTemplates>\n`
    info += tag(
      'DefaultTemplate',
      (aggregate.defaultComponentKey && context.templateAliasOf(aggregate.defaultComponentKey)) ||
        '',
      '    ',
    )
  }

  const compositions = aggregate.compositions
    .map((composition) => context.aliasOf(composition.contentTypeKey))
    .filter((alias): alias is string => !!alias)
  const structure = aggregate.allowedContentTypes
    .map((allowed) => context.aliasOf(allowed.contentTypeKey))
    .filter((alias): alias is string => !!alias)

  const properties = [...aggregate.properties]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((property) => {
      const group = property.containerKey ? groupOf.get(property.containerKey) : undefined
      let body = ''
      body += tag('Name', property.name, '      ')
      body += tag('Alias', property.alias, '      ')
      body += tag('Key', property.key, '      ')
      body += tag('Definition', property.dataTypeKey, '      ')
      if (group)
        body += `      <Tab Alias="${escapeText(group.alias ?? '')}">${escapeText(group.name ?? '')}</Tab>\n`
      body += tag('SortOrder', String(property.sortOrder), '      ')
      body += tag('Mandatory', bool(property.mandatory), '      ')
      body += tag('LabelOnTop', bool(property.labelOnTop), '      ')
      if (property.mandatoryMessage)
        body += tag('MandatoryMessage', property.mandatoryMessage, '      ')
      if (property.regEx) body += tag('Validation', property.regEx, '      ')
      if (property.regExMessage)
        body += tag('ValidationRegExpMessage', property.regExMessage, '      ')
      if (property.description) body += tag('Description', property.description, '      ')
      body += tag('Variations', variations(property), '      ')
      return `    <GenericProperty>\n${body}    </GenericProperty>\n`
    })
    .join('')

  const tabs = [...aggregate.containers]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((container) => {
      let body = ''
      body += tag('Key', container.key, '      ')
      body += tag('Type', container.type, '      ')
      body += tag('Caption', container.name ?? '', '      ')
      body += tag('Alias', container.alias ?? '', '      ')
      body += tag('SortOrder', String(container.sortOrder), '      ')
      return `    <Tab>\n${body}    </Tab>\n`
    })
    .join('')

  return `<?xml version="1.0" encoding="utf-8"?>
<${root}>
  <Info>
${info}  </Info>
  <Compositions>
${compositions.map((a) => tag('Composition', a, '    ')).join('')}  </Compositions>
  <Structure>
${structure.map((a) => tag(root, a, '    ')).join('')}  </Structure>
  <GenericProperties>
${properties}  </GenericProperties>
  <Tabs>
${tabs}  </Tabs>
</${root}>
`
}

const child = (element: XmlElement | undefined, name: string): XmlElement | undefined =>
  element?.children.find((c) => c.name.toLowerCase() === name.toLowerCase())

const childText = (element: XmlElement | undefined, name: string): string | undefined => {
  if (!element) return undefined
  const found = child(element, name)
  return found ? found.text.trim() : undefined
}

const childrenNamed = (element: XmlElement | undefined, name: string): XmlElement[] =>
  element ? element.children.filter((c) => c.name.toLowerCase() === name.toLowerCase()) : []

export interface UdtContentType {
  kind: ContentTypeKind
  key: string | undefined
  alias: string
  name: string
  icon: string | null
  description: string | null
  allowedAsRoot: boolean
  isElement: boolean
  allowedInLibrary: boolean
  variesByCulture: boolean
  variesBySegment: boolean
  compositionAliases: string[]
  allowedAliases: string[]
  componentAliases: string[]
  defaultTemplateAlias: string | null
  containers: Array<{ key?: string; name: string; alias: string; type: string; sortOrder: number }>
  properties: Array<{
    key?: string
    alias: string
    name: string
    dataTypeKey: string | undefined
    tabAlias: string | null
    sortOrder: number
    mandatory: boolean
    labelOnTop: boolean
    mandatoryMessage: string | null
    regEx: string | null
    regExMessage: string | null
    description: string | null
    variesByCulture: boolean
    variesBySegment: boolean
  }>
}

const isTrue = (value: string | undefined) => (value ?? '').toLowerCase() === 'true'

/** Reads a `.udt` document; undefined when it is not one we understand. */
export function readContentTypeUdt(source: string): UdtContentType | undefined {
  const document = parseXml(source)
  // parseXml yields the root element itself; a document wrapper only appears
  // when something precedes it.
  const root =
    document && KIND_OF[document.name] ? document : document?.children.find((c) => KIND_OF[c.name])
  if (!root) return undefined
  const kind = KIND_OF[root.name] as ContentTypeKind
  const info = child(root, 'Info')
  const alias = childText(info, 'Alias')
  const name = childText(info, 'Name')
  if (!alias || !name) return undefined
  const variation = (element: XmlElement | undefined) => {
    const value = (childText(element, 'Variations') ?? 'Nothing').toLowerCase()
    return {
      variesByCulture: value.includes('culture'),
      variesBySegment: value.includes('segment'),
    }
  }
  return {
    kind,
    key: childText(info, 'Key') || undefined,
    alias,
    name,
    icon: childText(info, 'Icon') || null,
    description: childText(info, 'Description') || null,
    allowedAsRoot: isTrue(childText(info, 'AllowAtRoot')),
    isElement: isTrue(childText(info, 'IsElement')),
    allowedInLibrary: isTrue(childText(info, 'AllowedInLibrary')),
    ...variation(info),
    compositionAliases: childrenNamed(child(root, 'Compositions'), 'Composition')
      .map((c) => c.text.trim())
      .filter(Boolean),
    allowedAliases: childrenNamed(child(root, 'Structure'), ROOT[kind])
      .map((c) => c.text.trim())
      .filter(Boolean),
    componentAliases: childrenNamed(child(info, 'AllowedTemplates'), 'Template')
      .map((c) => c.text.trim())
      .filter(Boolean),
    defaultTemplateAlias: childText(info, 'DefaultTemplate') || null,
    containers: childrenNamed(child(root, 'Tabs'), 'Tab').map((tab) => ({
      key: childText(tab, 'Key') || undefined,
      name: childText(tab, 'Caption') ?? '',
      alias: childText(tab, 'Alias') ?? '',
      type: childText(tab, 'Type') ?? 'Tab',
      sortOrder: Number(childText(tab, 'SortOrder') ?? 0),
    })),
    properties: childrenNamed(child(root, 'GenericProperties'), 'GenericProperty').map(
      (property) => ({
        key: childText(property, 'Key') || undefined,
        alias: childText(property, 'Alias') ?? '',
        name: childText(property, 'Name') ?? '',
        dataTypeKey: childText(property, 'Definition') || undefined,
        tabAlias: child(property, 'Tab')?.attributes.Alias ?? null,
        sortOrder: Number(childText(property, 'SortOrder') ?? 0),
        mandatory: isTrue(childText(property, 'Mandatory')),
        labelOnTop: isTrue(childText(property, 'LabelOnTop')),
        mandatoryMessage: childText(property, 'MandatoryMessage') || null,
        regEx: childText(property, 'Validation') || null,
        regExMessage: childText(property, 'ValidationRegExpMessage') || null,
        description: childText(property, 'Description') || null,
        ...variation(property),
      }),
    ),
  }
}
