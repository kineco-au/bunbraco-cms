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

- [ ] A published-only index per culture, kept current on publish, unpublish,
      move and trash, on both dialects.
- [ ] Which properties are searchable, and their weight, set per content type in
      `schema/`.
- [ ] A query API for components (`search(query, { culture, types, skip,
      take })`) with highlighted excerpts, and a Delivery API endpoint.
- [ ] Protected pages are left out unless the signed-in member may see them.
- [ ] A starter template ships a search results page.
