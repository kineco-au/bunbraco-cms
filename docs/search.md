# Search

Two searches share one queue and one indexer: **backoffice search**, over drafts,
for editors, and **site search**, over published pages, for visitors. Both live
in the database: **FTS5 on SQLite, `tsvector` on Postgres**. Umbraco keeps
Examine (Lucene) indexes on disk instead. Stories
[`043`](stories/05_completed/043-search-over-content.md) and `140`.

Backoffice search finds a page, media item or member by the words in any of its
text properties, not only its name. Site search is
[below](#site-search-for-visitors).

## What is indexed

There are two indexes, named as Umbraco names them, because the Examine dashboard shows those names:

| Index | Searcher | Covers |
| --- | --- | --- |
| `InternalIndex` | `InternalSearcher` | pages (documents) and media |
| `MembersIndex` | `MembersSearcher` | members |

Each indexed item gets one `search_document` row per culture it has a name in.
An invariant item gets a single row with culture `''`. A row holds:

- **`name`:** the item's name in that culture. For a member, its e-mail and
  username are included too.
- **`body`:** the text of the item's **current (draft) values**: the invariant
  ones plus that culture's. Backoffice search is the editor's view, so drafts
  count; a published-only index belongs to site search.
- **`fields`:** the same text unfolded, by property alias, for the Examine
  dashboard to show.

Text is extracted by `valueText` (`packages/data/src/search-text.ts`), which
reads the strings out of a value:

- Plain strings are kept as they are.
- Markup loses its tags and has its entities decoded.
- Editors' JSON (blocks, rich text, pickers) is walked for its strings. Keys
  that hold structure rather than words are skipped: keys, UDIs, aliases,
  layouts, crops.

Number and date columns contribute nothing.

Every property is searchable by default. A schema file opts one out:

```toml
[[property]]
alias = "internalNotes"
name = "Internal notes"
type = "textarea"
searchable = false
```

This works on any kind of type. On an element type it also applies inside the
blocks that use it, including properties the type takes from a composition.
The flag is stored on `property_type.searchable` (migration 032). The
backoffice writes schema files back from the database, and a backoffice save
carries no such flag, so a save leaves the stored value alone. Only a schema
sync sets it.

Changing the flag re-indexes the type's items. Changing it on an element type
re-indexes every page, media item and member, because blocks of that type
could be anywhere.

Umbraco is the other way round. Its index stores every property, but
backoffice search only matches names, ids and keys (plus the file path for
media, and e-mail and username for members). Searching more fields there means
replacing `IUmbracoTreeSearcherFields` in code. Its Examine dashboard does
search every field.

Some other things are always left out:

- **Retired properties.** A property removed from its type keeps its values
  (`data-model.md`), but they stop being searchable.
- **Sensitive member data.** A search must not reveal a value to somebody who
  could not open it, and the Examine dashboard shows every stored field.
- **Trashed items are kept, not left out.** They are filtered when searched,
  so `trashed=true` searches the recycle bin.

## Matching

`name` and `body` are stored **folded**: Unicode-decomposed, diacritics
stripped, lowercased, and split into words of letters and digits. A query goes
through the same `searchWords`. Both engines then only ever split on spaces, so
**the two dialects find the same things**.

Matching is language-neutral:

- **SQLite:** the `unicode61` tokenizer.
- **Postgres:** the `simple` configuration, with no stemming. "harb" finds
  "harbour" by prefix, but "ran" does not find "run".

Per-culture stemming was considered and set aside. It would have made the two
dialects disagree, and it suits English alone on SQLite.

A search box query matches an item when either:

- its name contains the text anywhere, as before the index; or
- **every** word of the query is in the index as a word prefix.

Name matches rank first, then index matches by relevance. A name match weighs
ten times a body match, through `bm25` weights on SQLite and `setweight` on
Postgres. The dialect-specific SQL is `fullTextHits` / `fullTextQuery` on the
dialect seam (`packages/data/src/dialect.ts`); nothing else knows which engine
it is talking to.

## Who sees a result

Results are filtered as the trees are, in `visibleSearch`
(`packages/api-management/src/handlers/start-node-trees.ts`):

- **Pages:** only those under one of the user's start nodes, and only where
  Browse (`Umb.Document.Read`) is granted.
- **Media:** only items under a media start node.

A user with root access and Browse everywhere is paged in the database. Anyone
else gets the best 1,000 matches, filtered and then paged. Past that window, an
editor refines the query.

## Keeping it current: the queue

The index is updated **in the background, not in the save**. A write leaves a
row in `search_index_queue`, inside its own transaction, so the queue row
commits with the change or not at all. The writes that queue an item are:

- **Every content event:** create (copies included), save, publish and
  rollback each append a `content_version` row. `DocumentRepository` queues the item
  there, which covers every content kind and every caller: the API, content
  transfer, the importer, scheduled publishing and forms.
- **A value migration** (`appendUnderState`), which writes values without an
  event.
- **A member's e-mail or username** changing.
- **A content type** whose live properties change (alias, variation, data type,
  or retirement). All of its items are queued, plus those of every type
  composing it.

- **Unpublish**, and **trash** with the whole branch: what site search holds
  is published values, and these take them away.

**Move** needs no queueing: it changes what a search filters on, not what the
index holds. **Delete** cascades: index rows and queue rows reference `node`
with `ON DELETE CASCADE`. On SQLite, a trigger keeps the FTS table in step.

The indexer (`SearchIndex.indexQueued`) takes queued items oldest first. Each
item gets its own transaction:

1. It locks the item's queue row with `FOR UPDATE SKIP LOCKED` on Postgres.
   A second indexer passes over a row that is already locked.
2. It rewrites the item's rows, backoffice and site search both.
3. It deletes the queue row, but **only at the generation it read**. If a
   write queues the item again meanwhile, it bumps `generation`, so the row
   survives and the item is indexed once more.

It runs as a background job (`packages/server/src/jobs.ts`):

- on a 5-second timer, on every node that runs jobs (any role but `web`);
- 250 ms after any backoffice change on this node, so an editor's own save is
  searchable almost at once.

**Across a cluster**, the queue and the index are both in the shared database.
Whichever node indexes an item, every node searches the same rows.

Migration 031 queues every existing page, media item and member, which is the
backfill. A fresh install has nothing to backfill: its seed content is queued
as it is written.

## The Examine dashboard

Settings → Examine Management works against the five Umbraco operations:

- **`GET indexer`, `GET indexer/{name}`:** an index reports itself
  **Rebuilding**, with the number of items waiting, while anything it covers is
  queued. The dashboard polls until it is **Healthy**.
  - `documentCount` is the number of indexed items.
  - `fieldCount` is the most fields one item holds.
- **`POST indexer/{name}/rebuild`:** queues every item the index covers. The
  index keeps answering from its current rows while they are re-indexed.
- **`GET searcher`, `GET searcher/{name}/query`:** search one index directly.
  Each result carries every stored field: `nodeName`, the property aliases
  (suffixed `_<culture>` for a variant value), and `__Key`, `__NodeTypeAlias`
  and the like.

An unknown index answers 400 and an unknown searcher 404, as Umbraco's do. Both
areas sit in the Settings section's permission rules.

## SQLite and concurrent transactions

The background indexer was the first long-running job that writes while
requests are being served. That exposed a gap in the SQLite connection: one
connection runs one transaction at a time, but async chains interleave. A job's
`BEGIN` between a request's `BEGIN` and `COMMIT` either failed outright or
added its statements to the request's transaction.

`SqliteDb.transaction` now queues top-level transactions behind each other. A
chain that is already inside one joins it (`packages/data/src/database.ts`).
Postgres gives each transaction its own pooled connection and needed nothing.

## Site search for visitors

`search()` in a component and `GET …/delivery/api/v2/search` answer visitors from
`site_search_document` (migration 039, `packages/data/src/site-search.ts`).

**What is indexed.** One row per published page and culture, `''` when
invariant, from the values that culture shows visitors. Drafts never count.
A page is left out when it is unpublished or trashed, when its content type has
no component (it has no address), or when the type says `site-search = false`.
A property is left out when it says `site-search = false` or
`searchable = false`; inside blocks, the element type's properties decide.

**How it ranks.** Each row holds the page name and three columns of text,
`high`, `normal` and `low`, by each property's `site-search` level, all folded
as backoffice search folds. Every word of the query must be in a page as a word
prefix. The name counts 10, then 5, 2 and 1: `bm25` column weights on SQLite,
the four `tsvector` weights (A to D) on Postgres. The two dialects rank the
same.

**Who sees a result.** Access is checked when someone searches, not stored in
the index. `branchAccess` (`@crombolo/core`) splits the protected nodes into
those the person searching may open and may not, and the query leaves out every
page whose nearest protected node is denied. An allowed branch inside a denied
one stays open. Because this happens in the query, `total` counts only what the
person may see. A change to the rules, or a page moved into or out of a protected
branch, applies on the next search. Page rendering and the Delivery API use the
same check, `memberMayOpen`.

**Excerpts.** The index keeps each page's text as written beside the folded
text. An excerpt (`excerpt` in `@crombolo/render`) is about 200 characters
around the first matching word, from the highest-weighted text that has one.
Each word that starts with a query word is marked. Components get segments;
the Delivery API gets escaped HTML with `<mark>`.

**Results are checked against the published cache.** A hit whose page is no
longer published in that culture is dropped, and the cache supplies the page
and its URL.

Not built: stemming, synonyms, typo tolerance, facets, and searching media files
or members.
