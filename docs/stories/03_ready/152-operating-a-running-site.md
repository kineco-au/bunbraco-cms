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

- [ ] `crombolo index rebuild [<index>]` and `crombolo index list` (document
      count and health per index)
- [ ] `crombolo cache rebuild` rebuilds the published cache, on every node
- [ ] `crombolo health [--group <name>]` runs the health checks and exits
      non-zero on a failure, with JSON output, so a monitor or a deploy can
      gate on it
- [ ] `crombolo recycle-bin empty [--content|--media] [--older-than N]`, with
      a dry run that lists what would go
- [ ] Each writes an audit entry
- [ ] Tests on SQLite and Postgres, including one with two nodes for the cache
      rebuild
