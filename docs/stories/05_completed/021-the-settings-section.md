# 021 — The Settings section

**Epic:** C — The backoffice, end to end · **Priority:** must · **Size:** L
**Depends on:** 020

## Story

As a site developer, I want to build a content type in the Settings section,
with tabs, properties, a composition, an allowed child and a template, and
find each piece written to the site's files, so that schema built in the
backoffice is the same code-reviewed schema the rest of the site uses.

## Context

The second package of the create-type → publish-page journey (epic framing
and shared decisions in 020). Settings is where a site's schema is built, and
under schema-as-code ([`../../schema-as-code.md`](../../schema-as-code.md))
every change made there must land in `schema/` as a file. It also had to open
with no red toast: every tree the section renders has to answer, even for
areas that were not built yet.

**Folders.** A folder is a `folder = "Pages/Blog"` key in the type's file, not
a database-only row. This is the epic-wide decision recorded in 020.

**Saving a data type** in the backoffice was deferred from 011. It is done
here.

## Acceptance criteria

- [x] **Content types.** `GetDocumentTypeConfiguration`,
      `PostDocumentTypeAvailableCompositions`,
      `GetDocumentTypeByIdCompositionReferences`,
      `GetDocumentTypeByIdAllowedParents`, `GetItemDocumentTypeSearch`,
      `GetTreeDocumentTypeSiblings` and `GetDocumentTypeBatch` answer.
      `PostDocumentTypeByIdTemplate` creates `components/<alias>.tsx` from the
      scaffold. Copy, move and folders work.
- [x] **Data types.** `GetFilterDataType` (the editor picker),
      `GetItemDataTypeSearch`, `GetTreeDataTypeAncestors` and
      `GetDataTypeByIdReferencedBy` answer. Copy and folders work. A data type
      saved in the backoffice is written to `schema/data-types/<alias>.toml`,
      with the alias derived from its name as export does.
- [x] **Templates.** `GetTreeTemplateChildren`, `Ancestors`, `Siblings` and
      `GetItemTemplateSearch` answer. The editor's "master template" maps to
      `export const layout`.
- [x] **Every tree the section renders answers**: partial views,
      stylesheets, scripts, dictionary, languages, relation types, log viewer
      and webhooks. Unbuilt areas return empty roots; built areas return real
      ones. Languages get their real CRUD (`language`, 5 operations), because
      the document workspace reads them.
- [x] **Exit.** In the real backoffice, create a content type with:
  - a tab
  - three properties on three editors, one of them through "Select editor →
    create new data type"
  - a composition
  - an allowed child
  - "Create template"

  After a reload the type persists, and each piece is on disk: the type's
  file in `schema/content-types/`, the data type's in `schema/data-types/`,
  and the view in `components/`. Settings opens clean.
- [ ] The template query builder stays 501. It is Razor-specific, and
      [`../../roadmap.md`](../../roadmap.md) records it as a deliberate
      divergence, not a gap.

## As built

Pinned by `tests/settings.test.ts`.

**Schema files**

- Folders live in the files as `folder = "Pages/Blog"`. The sync creates the
  path. A folder rename or a type move rewrites every file from the database.
  The composition picker shows the path.
- A data type saved in the backoffice gets an alias from its name, once, and
  its own file.
- A built-in data type gets a file only once it is changed. A data type that
  is in use refuses to delete.
- "Create template" scaffolds the view and attaches it.
- The template tree hangs a view under the layout its `export const layout`
  names.
- Languages have their CRUD, and `languages.toml` follows it.

**Trees for unbuilt areas** (`handlers/settings-stubs.ts`, 54 operations).
Every tree the backoffice renders for an unbuilt area answers an honest empty
result in its declared shape:

- root, children, ancestors and siblings for media types, member types,
  partial views, scripts, stylesheets, blueprints, media and elements
- the media and element recycle bins
- the dictionary, member-group and static-file trees
- the dictionary, relation-type and webhook lists
- a 404 for "original parent" in the bins that cannot hold anything yet

The coverage report counts the stubs separately. The first cut stubbed only
the Settings roots, but the manual walk-through hit ancestors and then
blueprints. The stubs now cover every unbuilt section, found by sweeping the
contract for unimplemented tree and recycle-bin reads rather than waiting for
the next toast. Real alongside them: document-type and data-type tree search
(with `itemKind`), and the document recycle bin's siblings.

**Deferred, then built.** Partial views, scripts and stylesheets as real file
trees were deferred at first (their roots answered empty) and have since been
built:

- partial views in `components/Partials/*.tsx`
- stylesheets in `css/`, served at `/css/`
- scripts in `scripts/`, served at `/scripts/`

One handler covers all three over path-safe file stores, with tree, items,
CRUD, rename and folders. The editor's `.cshtml` names are stored as `.tsx`. A
new partial view starts from the `Empty` snippet, and the snippets are TSX
components. Pinned by `tests/file-systems.test.ts`.

API coverage 155/513, 99 of them real. The news dashboard answers
`{ items: [] }`, because there is no umbraco.com feed to relay.

**Found in the walk-through, fixed after.** The Content section offered no
Create action.

- The backoffice gates every document action on the current user's
  permission verbs. `user/current` sent `fallbackPermissions: []`, and the
  seed had never granted the built-in groups any verbs.
- The seed now grants Umbraco's installer set verbatim
  (`BUILT_IN_GROUP_PERMISSIONS`). Migration 007 backfills databases seeded
  before that, and `user/current` sends the principal's real verbs.
- Picking a type in the create dialog then asks for its blueprints
  (`GetDocumentTypeByIdBlueprint`). That answered an empty page until 024.

**Development aid.** In development, the server logs the first request to each
operation that answers 501, for example
`501 GetUser  GET /umbraco/management/api/v1/user (3 missing so far)`. It keeps
the list on `server.notImplemented`, so one walk through a section shows
everything it still needs.

## Out of scope

- Media types: 023. Member types: 030.
- The template query builder (Razor-specific).
