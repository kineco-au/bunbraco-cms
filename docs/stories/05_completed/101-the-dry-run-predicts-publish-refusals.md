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

- [x] The dry run reports each of the three refusals per node, with the same
      wording the import uses.
- [x] A refusal caused by another node in the same bundle being unpublished is
      predicted correctly, given that node will be published by the run.
- [x] A test compares the dry run's predictions with the import's actual
      refusals for a fixture with all three cases.

## Out of scope

- Fixing the refusals automatically.

## Decision (2026-10-15)

**Rehearse, then roll back.** The check runs the import's own writes and
publishes inside a transaction that is always rolled back, with media files
left unplaced. It reports the refusals `publish` actually raised, so the rules
and their wording are the import's own by construction. The cost is that the
check briefly holds the content lock.

## What was built

- `rehearsePublish` (`packages/transfer/src/import.ts`): the import, split out
  as `applyBundle`, run with `publish` in its own transaction under the content
  lock and rolled back by throwing. It refuses to run inside an enclosing
  transaction, which it would otherwise join and leave written. Undefined while
  the check has something outstanding, since the import would stop first.
- `content check --publish` (CLI) and `TransferInput.publish` (server): each
  refusal becomes an `auto` finding, `publish-refused`, on the Changes
  dashboard, and the CLI prints `would not publish <key>: <reason>`. It never
  holds an import up.
- A parent published by the same run is not a refusal, because in the
  rehearsal it already has been.
- Tests: `tests/transfer-rehearse.test.ts` — a fixture with all three causes
  plus a parent-published-by-the-run child, compared against the import's own
  `publishFailures`; nothing left behind; the transaction guard; the check's
  findings. Documented in `docs/content-transfer.md`, "Drafts, and what
  `--publish` means".
