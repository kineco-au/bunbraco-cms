/**
 * Sections, and the two different alias vocabularies for them.
 *
 * The database stores Umbraco's application aliases (`content`, `users`), while
 * the backoffice matches section *manifest* aliases (`Umb.Section.Content`)
 * against `allowedSections`. The Management API translates between them, so a
 * value from one vocabulary must never leak into the other.
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
  // real and the alias resolves (`docs/18-forms.md`).
  forms: 'Bunbraco.Section.Forms',
} as const

export type AppAlias = keyof typeof SECTION_ALIASES
export type SectionAlias = (typeof SECTION_ALIASES)[AppAlias]

/** Every section the shipped backoffice knows how to render. */
export const CORE_SECTION_ALIASES: readonly SectionAlias[] = Object.values(SECTION_ALIASES)

/**
 * Translates stored application aliases into section manifest aliases, dropping
 * any with no section to render.
 */
export function toSectionAliases(appAliases: readonly string[]): SectionAlias[] {
  const seen = new Set<SectionAlias>()
  for (const appAlias of appAliases) {
    const sectionAlias = SECTION_ALIASES[appAlias as AppAlias]
    if (sectionAlias) seen.add(sectionAlias)
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
