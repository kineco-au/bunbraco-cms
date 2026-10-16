# 140 — Site search for visitors

**Epic:** O — Building a site · **Priority:** should · **Size:** M
**Depends on:** —

## Story

As a visitor, I want to search the site and get relevant published pages, and
as a developer I want a search component and API to build the results page
with, so that every site does not need an external search service.

## Context

Backoffice search is built over FTS5 and `tsvector` (story `043`,
[`search.md`](../../search.md)), which says site search "is a separate decision
and is not built". Umbraco sites use Examine for it; WordPress has it built in.
The backoffice index holds drafts and every property, so visitors need their
own: published values only, per culture, respecting protected pages.

## Acceptance criteria

- [x] A published-only index per culture, kept current on publish, unpublish,
      move and trash, on both dialects.
- [x] Which properties are searchable, and their weight, set per content type in
      `schema/`.
- [x] A query API for components (`search(query, { culture, types, skip,
      take })`) with highlighted excerpts, and a Delivery API endpoint.
- [x] Protected pages are left out unless the signed-in member may see them.
- [x] A starter template ships a search results page.

## Out of scope

- Stemming, synonyms and typo tolerance. Matching is the same word-prefix
  matching as backoffice search, on both dialects.
- Facets, search analytics, and suggestions as you type.
- Searching media files (PDFs) or members.

## Decision (2026-10-16)

- **The index lives in the database**, beside backoffice search: FTS5 on
  SQLite, `tsvector` on Postgres. It holds published values only, one row per
  page per culture, with `''` for an invariant page.
- **One queue feeds both indexes.** The indexer that takes an item from
  `search_index_queue` rewrites its backoffice rows (drafts) and its
  site-search rows (published) in the same transaction. Unpublish and trash
  start queueing, with descendants, because neither does today. Move needs
  nothing: a page's URL and protection are read when someone searches.
- **Access is checked at search time, not stored in the index.** The query
  leaves out every protected branch the current person may not open. That's
  every protected branch for an anonymous visitor, and for a member every
  branch whose rules name none of their groups and not their username. The
  filter is part of the database query, so totals and paging count only what
  the person may see. Changes to the rules, and pages moved in or out of a
  protected branch, apply on the next search. Page rendering and the Delivery
  API share one access check; today they compare group names with different
  case rules. Backoffice users are unaffected: their search is the existing
  backoffice index, filtered by start nodes and Browse.
- **Results are checked against the published cache.** A row whose page is no
  longer published in that culture is dropped, so an index that hasn't caught
  up yet never shows a stale page. The cache also supplies the result's
  `PublishedContent` and URL.
- **Searchable by default, with opt-outs.** Every text property of a routable
  page (a content type with a component) is searchable at `normal` weight. A
  property sets `site-search = false` to leave itself out. `searchable = false`,
  which hides a property from backoffice search, hides it from visitors too. A
  content type sets `site-search = false` to leave all its pages out. Text in
  blocks follows the element type's properties, as backoffice search does.
- **Weights are levels**: `site-search = "high" | "normal" | "low"`. With the
  page name always on top, they map onto Postgres's four `tsvector` weights
  (name A, high B, normal C, low D) and onto four FTS5 columns weighted the same
  way through `bm25`. Ranking is the same on both dialects.
- **Excerpts are cut in TypeScript.** The index keeps each field's original
  text beside the folded text it matches on. An excerpt is the best window
  around the query's words, found with the same word folding as matching. It's
  returned as segments (`{ text, match }`) for components and as escaped HTML
  with `<mark>` for the Delivery API. The output is the same on both dialects,
  and the engines never produce markup.

## Plan

1. **Schema** (`packages/schema`): `site-search` on a property (`false` or a
   level) and on a content type (`false`). Parse, validate, export, write back
   and sync. Store the values in `property_type.site_search` and
   `content_type.site_search` (one migration, named for the release it ships
   in). Add them to `propertySignature`, so changing them re-queues the type's
   pages as `searchable` does.
2. **The index** (`packages/data`): `site_search_document`, holding node,
   culture, the folded `name`/`high`/`normal`/`low` columns, and the original
   text for excerpts. Create the FTS5 table, or the weighted `tsvector`
   column, in the same migration. `publishedEntriesFor(nodeId)` reads each
   culture's published values, skipping trashed items, unroutable types and
   opted-out properties. `indexQueued` writes both kinds of row. Add queueing
   in `#unpublish`, `moveToRecycleBin` and branch unpublish (descendants
   included). Migration backfill queues every page.
3. **The query** (`packages/data`): `SiteSearch.query(term, { culture, types,
   skip, take, excluded })`. A word-prefix match on rows for the culture or
   `''`, ranked by weight. Protected branches are left out by path prefix, so
   `total` is exact. Put the dialect SQL on the dialect seam beside
   `fullTextHits`.
4. **Access** (`packages/server`, `packages/api-delivery`): one shared check
   turns `public_access` rules plus a member (or none) into the branches to
   leave out, used by the search and by the existing render and Delivery API
   checks. This also fixes the difference in case rules.
5. **Excerpts** (`packages/render`): a pure function from original text and
   query words to segments, plus an HTML renderer that escapes the text and
   wraps matches in `<mark>`.
6. **The component API** (`packages/render`, exported from
   `@crombolo/crombolo`): `search(query, { culture, types, skip, take })`. It
   reads culture and member from `usePage()` and calls a search port the
   server wires to `SiteSearch`. It hydrates hits from the published cache and
   returns `{ total, items: [{ content, url, name, score, excerpt }] }`. Page
   components may already be async, so a results page awaits it.
7. **The Delivery API** (`packages/api-delivery`): `GET
   /umbraco/delivery/api/v2/search?term=&contentType=&skip=&take=`, with culture
   from `Accept-Language` and the member from the bearer token, as the content
   endpoints work. It returns content items plus `excerpt` (HTML) and `score`,
   and is documented as a Crombolo extension: Umbraco has no such endpoint.
8. **The starter template** (`sites/starter`): a `searchPage` content type and
   `pages/searchPage.tsx`, a GET form on `?q=` with results, excerpts and
   paging. Add a search box to the site header and a Search page node in the
   bundle, then rebuild the template with `bun run build:template`.
9. **Docs**: a site-search section in `search.md`, the new keys in
   `schema-as-code.md`, `search()` in `writing-components.md`, and the endpoint
   in `delivery-api.md`.

**Tests**, on both dialects (this is the data layer):
- Only published values are indexed, per culture.
- Unpublish and trash remove a page, and a move keeps it.
- Protected pages: anonymous visitors, a member in a group and a member named by
  username, with totals checked.
- Weight order, opt-outs and content-type opt-outs, and the schema keys round
  trip.
- Excerpts, as unit tests.
- `search()` from a component, the Delivery API endpoint, and the starter's
  search page rendering results.

## Implementation

Built as planned, with one release bump: the migration ships in **0.14.0**.

- **Schema:** `site-search` on a property (a level or `false`) and on a page type
  (`false`). It is parsed, validated, exported, written back and synced into
  `property_type.site_search` (`high`, `normal`, `low` or `off`) and
  `content_type.site_search`. A backoffice save leaves both alone, as it leaves
  `searchable`, and changing either re-queues the type's pages.
- **The index:** migration 039 (`AddSiteSearch`) adds `site_search_document`,
  with an FTS5 table and triggers on SQLite and a weighted `tsvector` on
  Postgres, and queues every page. `siteEntriesFor` reads published values
  through the repository's own `publishedValueRows`. The backoffice indexer
  writes these rows in the same transaction as its own. Unpublish and trash
  (the whole branch) now queue.
- **The query:** `SiteSearch.query`, matching by word prefix, ranked name 10,
  high 5, normal 2, low 1 (`siteSearchHits` on the dialect seam). Protected
  pages are left out in SQL by the denied and allowed protected nodes, so a
  nearer allowed node opens a branch inside a denied one.
- **Access:** `memberMayOpen` and `branchAccess` in `@crombolo/core` are now
  the one check for page rendering, the Delivery API and site search. The
  Delivery API compares groups in any case, as the site always did.
- **Excerpts:** `excerpt` and `excerptHtml` in `@crombolo/render`.
- **APIs:** `search()` from `@crombolo/crombolo` reads a port the server puts in
  the render scope (`siteSearchFor`, scoped to the request's member), in page
  renders and previews. `GET /umbraco/delivery/api/v2/search` is a port on the
  Delivery API.
- **Starter:** a `searchPage` type (`site-search = false`), the results page with
  paging, a header search box, a Search node in the bundle, and weights on
  Content Page (title high, sidebar low).
- **Fixed alongside:** moving a page to the recycle bin now tells the other
  nodes in a cluster, which it never did, so they stopped serving the trashed
  branch only once their cache rebuilt for some other reason.

Tests: `tests/site-search.test.ts`, on both dialects:
- the schema keys
- published values only, per culture
- opt-outs and weights
- unpublish, trash and move
- nested protection with exact totals
- excerpts and the access rules
- `search()` from a page, as a visitor and as a member
- the Delivery API endpoint with and without member tokens
- the starter's search page

`tests/documents.test.ts` covers the recycle bin instruction, and
`tests/upgrade-from-release.test.ts` covers upgrading from 0.13.2.
