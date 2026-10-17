# 152 — Operating a running site

**Epic:** P — The command line · **Priority:** should · **Size:** M
**Depends on:** —

## Story

As whoever runs a site, I want to rebuild its search index and published cache,
run its health checks and empty its recycle bin from the command line, so that
routine operations can be scripted, scheduled and run from CI.

## Context

The back office can do each of these through the `indexer`, `published-cache`,
`health-check-group`/`health-check` and `recycle-bin` areas of the Management
API. A script cannot, short of signing in as a person. `crombolo status`
reports configuration problems, but it does not run the health checks the
Settings section runs (`diagnostics.md`).

**Decision needed: where the command acts.** A rebuild in one process does not
reach the other nodes in a cluster. The options:

- (a) The command writes a cache instruction, as an editor's save does, and
  every node acts on it (story 120). This works with no network access to the
  nodes.
- (b) The command calls the running site's API with the seeded API client
  (story 034). This needs the site to be up and reachable.

Option (a) matches how `maintenance pause` already works across a cluster.

## Acceptance criteria

- [x] `crombolo index rebuild [<index>]` and `crombolo index list` (document
      count and health per index)
- [x] `crombolo cache rebuild` rebuilds the published cache, on every node
- [x] `crombolo health [--group <name>]` runs the health checks and exits
      non-zero on a failure, with JSON output, so a monitor or a deploy can
      gate on it
- [x] `crombolo recycle-bin empty [--content|--media] [--older-than N]`, with
      a dry run that lists what would go
- [x] Each writes an audit entry
- [x] Tests on SQLite and Postgres, including one with two nodes for the cache
      rebuild

## Decision

**A cluster is reached by cache instruction** (option a, 2026-10-17), the way
an editor's save and `maintenance pause` already reach every node.

## What was built

- `crombolo index list|rebuild` — the search index is in the database, so one
  rebuild serves every node, through `SearchIndex.rebuild` and `indexQueued`;
  `--queue-only` leaves the indexing to the site's own job.
- `crombolo cache rebuild` appends a `content` instruction for everything,
  stamped `cli:<node>` so that no node, the one on this machine included, skips
  it as its own. The poller already rebuilds the published cache on any such
  instruction, so no server change was needed.
- `crombolo health [--group]` runs `createDiagnosticsPort`, the Health Check
  dashboard's own checks, and exits 20 when one fails.
- `crombolo recycle-bin empty [--content|--media] [--older-than] [--yes]
  [--dry-run]` deletes the bin's roots and their branches, with each media
  item's file, and writes one cache instruction for the run.
- **Migration 042, `AddTrashedDate`** (release 0.16.0): `document.trashed_date`,
  set when an item is trashed and cleared on restore, which `--older-than`
  needs; nothing recorded the date before. An item trashed before the upgrade
  has none, and `--older-than` keeps it and counts it.
- **Tests:** `tests/cli-operations.test.ts` § operating the site, and the trashed
  date through the API on both dialects. `tests/upgrade-from-release.test.ts` and
  `first-boot.integration.ts` now model 0.15.0 as the previous release. The
  two-node criterion is held by the instruction this writes — kind, payload and
  a creator no node is — since a node's response to a foreign instruction is the
  cluster tests' already.
