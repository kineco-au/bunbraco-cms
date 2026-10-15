# 103 — Resolve transfer conflicts in the backoffice

**Epic:** K — Moving content · **Priority:** should · **Size:** M
**Depends on:** —

## Story

As an editor, I want to answer an import's conflicts in the backoffice, so that
moving content does not need someone at a command line.

## Context

Findings are already shown in the Changes dashboard; acting on them is still a
CLI flag ([`../../content-transfer.md`](../../content-transfer.md), "Findings").
Each conflict has a fixed set of resolutions, so the screen offers those and
nothing else.

## Acceptance criteria

- [x] Each finding in the Changes dashboard offers its resolutions; choosing one
      records it against the pending import.
- [x] The import can be run from the dashboard once every blocking finding has a
      resolution, and its result is shown there.
- [x] Only users allowed to import see the actions.
- [x] The resolutions recorded match what the CLI would have written for the
      same choices.
- [x] Wording follows the backoffice's language rules: no flags, no file names.

## Out of scope

- Uploading a bundle from the browser.

## Decision (2026-10-15)

- **Answers in the database** (migration 036), laid over the bundle's
  `resolutions.json` at import and downloadable as that file. Not written into
  `node_modules`, which is per-node and replaced on deploy.
- **The dashboard runs what was checked**: a check (CLI or a Packages install)
  records where the bundle was found and the options it ran with. A directory
  is this server's path, so only the node that has it can import it.
- **Packages section** for the actions, as installing a bundle; Settings still
  sees the findings.
- Pushed back on "once every blocking finding has a resolution": a blocking
  finding has none, it needs a deployment. The import is offered once nothing
  is outstanding, and blocking findings say what is needed instead.

## What was built

- `transfer_pending` and `transfer_answer` (migration 036, release 0.12.0) and
  `TransferAnswerRepository`; `answersByNode` (pure) gives them the
  `resolutions.json` shape.
- `checkBundleContent` and a refused `installBundleContent` record the pending
  import; an applied one clears it and its answers. `transferOptions` merges
  saved file, stored answers, then the caller's.
- `choicesFor(finding)` in `@crombolo/transfer`, beside `resolutionsFor`.
- `packages/server/src/transfer-dashboard.ts`: `answer`, `missing-files`,
  `check`, `import` and `resolutions` under `crombolo/api/transfers/<bundle>/`,
  Packages section only; `answerProblems` (pure) validates an answer. The change
  report carries `transfers`, `mayImport` and each finding's `choices`.
- The Changes dashboard: answer buttons per finding, the answers given (and
  taking one back), the missing-files toggle, Import with its result and the
  backup confirmation, Check again, Download answers. The bundle's name heads
  its group rather than its id.
- The CLI-only hint "answer it as `<key>/<handle>`" moved out of the finding's
  message, which the dashboard shows, into the CLI's printing of it.
- Tests: `tests/transfer-dashboard.test.ts`.
