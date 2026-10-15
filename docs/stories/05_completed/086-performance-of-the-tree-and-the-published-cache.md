# 086 — Performance of the tree and the published cache

**Epic:** I — Hardening · **Priority:** should · **Size:** M
**Depends on:** —

## Story

As a site owner with a large site, I want the backoffice tree and page rendering
to stay fast as content grows, so that the site works the same at ten thousand
pages as at a hundred.

## Context

Listed under Phase 7: a performance pass on the tree and the published cache.
Neither has been measured on a large site.

## Acceptance criteria

- [x] A generated site of realistic size (tens of thousands of nodes, several
      cultures) on both dialects.
- [x] Budgets for tree root, children and siblings, published-cache rebuild and
      a page render, measured and recorded in `testing.md`.
- [x] The slowest paths fixed until the budgets are met.
- [x] A benchmark that can be re-run to catch a regression.

## Decision (2026-10-15)

- **Generated through the repository**, the same create and publish a real
  site goes through, so the data cannot drift from what an install holds.
- **25,000 pages, 3 cultures**: up to five levels, one section of 2,000
  siblings, 1,000 media items; sizes overridable by environment.
- **Runs in the release pipeline** beside the load test, not in the local
  suites. Locally it is only run small, to check it works.
- **Budgets** (p95): tree root, children (a page of 100) and siblings 100 ms;
  a full published-cache rebuild 5 s on SQLite and 10 s on Postgres; a page
  render 20 ms. Every measurement is printed against its budget; the run fails
  only past twice the budget, so a noisy runner does not block a release.

## What was built

- `tests/load/large-site.bench.ts`: the generated site and the five timings,
  each printed against its budget and failing past twice it. `bun run
  test:bench` (and `docker:test:bench`); the release workflow runs it after the
  load test, on both dialects. `bun test` and `test:load` do not collect it.
- **The tree**: `DocumentRepository.treeItems` reads a page in four queries —
  child counts, the content type and state facts, the culture variants, and
  every ancestor the page's paths name — instead of loading each item's full
  editing aggregate (about eleven queries an item). `documentItems` reads its
  keys in one query. `NodeRepository.byIds`.
- **The published cache**: `loadPublished` reads culture events and value
  history in slices of 500 nodes and looks each content type's properties up
  once; the choice of what a node shows is the pure `publishedValueRows`,
  which the single-node read uses too. Media for the cache comes from
  `loadCurrent`, the same way, instead of a full editor load per item.
- `PublishedCache.snapshot` shares one build between readers arriving while it
  runs; a build an invalidation overtook still answers but is not kept as
  current, and an older build finishing late never replaces a newer one.
- Left as they were, measured cheap at the small size: siblings (one indexed
  read of the siblings, sliced), and the public-access check on a render (two
  indexed queries; caching it would risk serving a page whose protection had
  just changed).
- Tests: `tests/large-site-paths.test.ts` — statement counts that do not grow
  with the page or the site, the pure value choice, and the shared build.
- Measured at full size on both dialects (2026-10-15), all well inside
  budget: a tree page about 6–12 ms, a full cache rebuild 1.3 s on SQLite and
  1.0 s on Postgres, a page render 1.8 ms and 4.4 ms. The table is in
  `docs/testing.md`, "Large-site budgets".
- Found on the way: `tests/transfer-rehearse.test.ts` booted its target site
  while the source site's server was still running over the same Postgres
  database, which deadlocked once; the source is now closed first.
