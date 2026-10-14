/**
 * Sections, and the two different alias vocabularies for them.
 *
 * The database stores Umbraco's application aliases (`content`, `users`), while
 * the backoffice matches section *manifest* aliases (`Umb.Section.Content`)
 * against `allowedSections`. The Management API translates between them, so a
 * value from one vocabulary must never leak into the other.
 *
 * A section an extension declares has no application alias: the backoffice
 * sends its manifest alias when a group is granted it, and that is what is
 * stored. The two vocabularies are told apart by shape — an application alias is
 * a bare word, a manifest alias is dotted — so an extension's section round-trips
 * unchanged and is never mistaken for a stored alias nothing renders.
 */
export const SECTION_ALIASES = {
  content: 'Umb.Section.Content',
  media: 'Umb.Section.Media',
  settings: 'Umb.Section.Settings',
  users: 'Umb.Section.Users',
  members: 'Umb.Section.Members',
  translation: 'Umb.Section.Translation',
  library: 'Umb.Section.Library',
  packages: 'Umb.Section.Packages',
  // Umbraco seeds this alias and then has no section for it: Forms is a
  // commercial add-on there. Form building is in core here, so the section is
  // real and the alias resolves (`docs/forms.md`).
  forms: 'Crombolo.Section.Forms',
} as const

export type AppAlias = keyof typeof SECTION_ALIASES
export type SectionAlias = (typeof SECTION_ALIASES)[AppAlias]

/**
 * The manifest alias of a section an extension registers, `Vendor.Section.Name`
 * by convention. Dotted, which is what distinguishes it from a stored
 * application alias.
 */
export type ExtensionSectionAlias = `${string}.${string}`

/** Every section the shipped backoffice knows how to render. */
export const CORE_SECTION_ALIASES: readonly SectionAlias[] = Object.values(SECTION_ALIASES)

const EXTENSION_SECTION_ALIAS = /^[A-Za-z][\w-]*(?:\.[A-Za-z][\w-]*)+$/

/** Whether a value is shaped like a section manifest alias rather than a stored application alias. */
export function isExtensionSectionAlias(value: string): value is ExtensionSectionAlias {
  return EXTENSION_SECTION_ALIAS.test(value)
}

/**
 * Translates stored application aliases into section manifest aliases, dropping
 * any bare alias with no section to render. A stored manifest alias is an
 * extension's section and passes through, so a group granted one keeps it.
 */
export function toSectionAliases(
  appAliases: readonly string[],
): Array<SectionAlias | ExtensionSectionAlias> {
  const seen = new Set<SectionAlias | ExtensionSectionAlias>()
  for (const appAlias of appAliases) {
    const sectionAlias = SECTION_ALIASES[appAlias as AppAlias]
    if (sectionAlias) seen.add(sectionAlias)
    else if (isExtensionSectionAlias(appAlias)) seen.add(appAlias)
  }
  return [...seen]
}

const STORED_ALIASES: Record<string, string> = { ...SECTION_ALIASES }

/** Umbraco's `SectionMapper.GetName`: a stored alias as its section alias, or unchanged when unknown. */
export function sectionName(appAlias: string): string {
  return STORED_ALIASES[appAlias] ?? appAlias
}

/** Umbraco's `SectionMapper.GetAlias`: a section alias as the alias stored for it, or unchanged. */
export function sectionAppAlias(name: string): string {
  return Object.entries(STORED_ALIASES).find(([, value]) => value === name)?.[0] ?? name
}

/**
 * One spelling for comparing sections, whichever vocabulary a value came from: a
 * core section as its application alias, an extension's section as its manifest
 * alias, both lowercased. `Umb.Section.*` is stripped even when unmapped, so an
 * alias imported from Umbraco compares as its bare word.
 */
export function sectionKey(alias: string): string {
  return sectionAppAlias(alias)
    .replace(/^Umb\.Section\./, '')
    .toLowerCase()
}
