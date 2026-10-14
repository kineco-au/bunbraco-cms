# 043 — Search over content

**Epic:** E — Cross-cutting · **Priority:** must · **Size:** L
**Depends on:** —

## Story

As an editor, I want backoffice search to find a page by the words in its body,
not only its name, so that I can find content I didn't name myself.

## Context

Search is `LOWER(node.text) LIKE '%q%'`, which matches names only (checked
2026-10-14: `packages/data/src/repositories/nodes.ts`). The FTS5/`tsvector`
decision in [`overview.md`](../../overview.md) was never built. Umbraco's
Examine searches every property value.

Correction (2026-10-14, checked against Umbraco's source): Umbraco *indexes*
every property value, but its backoffice search matches only names, ids and
keys, plus the file path for media and e-mail and username for members.
Searching more fields is opt-in, by replacing `IUmbracoTreeSearcherFields` in
code. Only the Examine dashboard searches every field. So finding a page by its
body is a step past Umbraco's default, not parity.

In the ranking of what is missing, this sits second only to e-mail: a running
site notices it every day.

## Acceptance criteria

- [x] Full-text indexing over property values: FTS5 on SQLite, `tsvector` on
      Postgres, behind the dialect seam.
- [x] Backoffice search finds a document by words in any text property, with
      results the editor may see (start nodes and permissions applied).
- [x] The `searcher` and `indexer` operations are real (5 ops, rebuild
      included); were 0/2 and 0/3.
- [x] The index stays current across save, publish, delete and schema changes,
      and across nodes in a cluster.
- [x] Tested on both dialects.

## Decisions

Decided before building (2026-10-14):

- **A background queue, not indexing in the save.** A write queues the item in
  its own transaction, and a job indexes it. Saves stay as fast as they were,
  and search lags by a moment.
- **Pages, media and members.** These are Umbraco's `InternalIndex` (documents
  and media, drafts included) and `MembersIndex`.
- **Language-neutral matching.** Postgres uses `simple`, and SQLite uses
  `unicode61` without diacritics. The two dialects find the same things.
  There is no stemming.
- **Every word by prefix, plus the name.** Each word of a query must be in the
  index as a word prefix. A name containing the text still matches, and name
  matches rank first.

- **Searchable by default, with a per-property opt-out.** Decided after the
  build, once the correction above was known. `searchable = false` on a
  property in the schema files keeps it out of search.

## What was built

[`search.md`](../../search.md) describes the whole of it.

- **Data:**
  - Migration 031 (`schema/search-index.ts`, release 0.10.0) adds
    `search_document`: an FTS5 table plus triggers on SQLite, and a generated
    `tsvector` with a GIN index on Postgres.
  - It also adds `search_index_queue`, keyed by node with a generation, and
    backfills it with every existing page, media item and member.
  - `search.ts` holds `queueForSearch`, `queueContentTypesForSearch`,
    `SearchIndex` (claiming, indexing, rebuild, stats, the dashboard's query)
    and `entriesFor`.
  - `search-text.ts` holds `searchWords`, `searchTerms` and `valueText`.
  - The dialect seam gained `fullTextHits`, `fullTextQuery` and
    `forUpdateSkipLocked`.
- **Queueing:**
  - `DocumentRepository` queues an item on every content event and on value
    migrations.
  - `MemberRepository` queues a member when its e-mail or username is
    written.
  - `ContentTypeRepository.save` queues a type's items, and those of the types
    composing it, when its live properties change.
- **Search:**
  - `NodeRepository.search` takes `fullText`: a name match, or every term in
    the index. Document and media search turn it on, and the member filter
    matches the index too.
  - `visibleSearch` applies start nodes and, for documents, Browse.
- **API:**
  - `handlers/search-index.ts` implements the five `indexer` and `searcher`
    operations.
  - `SearchIndexPort` is in `api-management`, with its adapter in
    `server/src/adapters/search-index.ts`.
  - Coverage is now 475/513.
- **Jobs:** the indexer runs every 5 s on nodes that run jobs, and 250 ms after
  a backoffice change on this node. `jobs.runSearchIndexing()` is how tests
  drive it.
- **SQLite transactions:** top-level transactions on a connection now queue
  behind each other, and a chain already inside one joins it. Before this, a
  background job's transaction could collide with a request's.
- **Opting out:** migration 032 adds `property_type.searchable`.
  - `searchable = false` in a schema file is parsed, written back and
    exported.
  - A schema sync sets the flag; a backoffice save, which carries no such
    flag, keeps it.
  - The indexer leaves the property out, and inside blocks it leaves out an
    element type's opted-out properties, compositions included.
  - Changing the flag re-indexes the type's items, or everything when the type
    is an element type.
- **Tests:** `tests/search.test.ts` covers both dialects:
  - text extraction;
  - prefix and all-words matching, diacritics, and name ranking;
  - freshness across save, publish, a schema change, trash and delete;
  - start nodes and a denied Browse;
  - media and members, with sensitive values kept out;
  - the dashboard's five operations, health while queued, and the 400, 404
    and 403 cases;
  - two indexers racing one queue;
  - `searchable = false`: the TOML round trip, a save that omits it, and
    allowing it again.

## Out of scope

- Site (front-end) search for visitors. Templates may read the index later; that
  is a separate decision.
