# 025 — Variants and localisation

**Epic:** C — The backoffice, end to end · **Priority:** must · **Size:** M
**Depends on:** 024

## Story

As an editor of a multilingual site, I want to publish a page in one language
without publishing another language's newer draft. I want a language I
haven't translated yet to fall back to another, and each language to render
under its own domain. That way I can run a site in more than one language.

## Context

Epic framing and shared decisions are in 020. This story covers:

- culture variants end to end: per-culture publish, fallback and mandatory
  languages
- segments
- the dictionary (8 operations)
- the backoffice's UI language files

Per-culture publishing has to fit the append-only value model
([`../../data-model.md`](../../data-model.md)).

**Invariant values and culture values publish separately.** Invariant values
read as of the page's latest publish, and each culture's own values read as of
that culture's own publish.

**The dictionary is content, not schema.** It is translators' content, like
pages, so it lives in the database and not in schema files.

## Acceptance criteria

- [x] Culture variants: per-culture publish, fallback and mandatory
      languages.
- [x] Segments and `GetDocumentByIdAvailableSegmentOptions`.
- [x] The dictionary (8 operations).
- [x] The backoffice's UI language files.
- [x] **Exit.** A two-language site publishes one culture, falls back for the
      other, and renders both under their domains.

## As built

**Publishing by culture**

- Each culture of a page records the publish it went live with and the name
  it had (migration 011).
- Invariant values read as of the latest publish, and each culture's values
  as of its own publish. Publishing Danish never publishes English's newer
  draft.
- A culture's state is its own. It is `PublishedPendingChanges` only when its
  values, the invariant values or its name have moved on since it was
  published.
- Every mandatory language must be published or be publishing (Umbraco's
  rule). Only created variants publish, and unpublishing a mandatory culture
  unpublishes the page.

**Rendering by culture**

- The published cache holds one view per language.
  - A page that varies by culture appears in each culture it is published
    in, with that culture's name, URL segment (its `umbracoUrlName`, else its
    name) and URL.
  - An invariant page appears in every culture.
- A hostname serves its culture's view. Without one, the default language's
  view is served.
- `model.value(alias, { fallback: 'language' })` follows each language's
  fallback chain.
- Pickers, links and `nav` resolve within the page's culture.
- `GetDocumentUrls` lists a URL per culture.
- Preview renders the culture the backoffice asks for.

**Dictionary** (migration 011, Umbraco's `cmsDictionary` and
`cmsLanguageText`)

- The Translation section has its tree and its list, showing which cultures
  each item is translated into.
- Items can be created, edited, moved (never below themselves) and deleted
  along with their branch.
- `.udt` export and import use Umbraco's format. As in Umbraco, translations
  for languages the site lacks are skipped.
- Templates get `dictionary(key)`, which reads the page's culture and then its
  fallbacks.

**Segments.** Without a segment provider, Umbraco offers no segments, and
neither do `GetSegment` and `GetDocumentByIdAvailableSegmentOptions`. Segment
values still round-trip. Since no provider ships, personalisation stays inert;
[`../../roadmap.md`](../../roadmap.md) lists this as a deliberate divergence.

**UI languages.** The backoffice's 28 language files ship with the vendored
client and are served. A user's choice is saved by `PutUserCurrentProfile`.

**Tests**

- `tests/variants.test.ts` (both dialects) and `tests/dictionary.test.ts`.
- In the real backoffice, `tests/browser/variants.browser.ts`: a page is
  written and published in English, then in Danish through the publish
  dialog. Each renders under its own hostname, with Danish falling back to
  English.
- The dictionary step of `tests/browser/users.browser.ts`.
