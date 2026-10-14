# 101 — The dry run predicts publish refusals

**Epic:** K — Moving content · **Priority:** could · **Size:** S
**Depends on:** —

## Story

As a developer importing content with `--publish`, I want the dry run to tell
me which pages will fail to publish, so that I fix them before the run rather
than reading a list afterwards.

## Context

`publish` refuses on an unpublished ancestor, an unpublished mandatory language
or an empty mandatory property. The import reports each refusal per node and
carries on, so nothing half-lands
([`../../content-transfer.md`](../../content-transfer.md), "Still open").

## Acceptance criteria

- [ ] The dry run reports each of the three refusals per node, with the same
      wording the import uses.
- [ ] A refusal caused by another node in the same bundle being unpublished is
      predicted correctly, given that node will be published by the run.
- [ ] A test compares the dry run's predictions with the import's actual
      refusals for a fixture with all three cases.

## Out of scope

- Fixing the refusals automatically.
