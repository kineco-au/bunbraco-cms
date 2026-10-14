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

In the ranking of what is missing, this sits second only to e-mail: a running
site notices it every day.

## Acceptance criteria

- [ ] Full-text indexing over property values: FTS5 on SQLite, `tsvector` on
      Postgres, behind the dialect seam.
- [ ] Backoffice search finds a document by words in any text property, with
      results the editor may see (start nodes and permissions applied).
- [ ] The `searcher` and `indexer` operations are real (5 ops, rebuild
      included); currently 0/2 and 0/3.
- [ ] The index stays current across save, publish, delete and schema changes,
      and across nodes in a cluster.
- [ ] Tested on both dialects.

## Out of scope

- Site (front-end) search for visitors. Templates may read the index later; that
  is a separate decision.
