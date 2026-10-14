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

- [ ] A generated site of realistic size (tens of thousands of nodes, several
      cultures) on both dialects.
- [ ] Budgets for tree root, children and siblings, published-cache rebuild and
      a page render, measured and recorded in `testing.md`.
- [ ] The slowest paths fixed until the budgets are met.
- [ ] A benchmark that can be re-run to catch a regression.
