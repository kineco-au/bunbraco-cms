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

- [ ] Each finding in the Changes dashboard offers its resolutions; choosing one
      records it against the pending import.
- [ ] The import can be run from the dashboard once every blocking finding has a
      resolution, and its result is shown there.
- [ ] Only users allowed to import see the actions.
- [ ] The resolutions recorded match what the CLI would have written for the
      same choices.
- [ ] Wording follows the backoffice's language rules: no flags, no file names.

## Out of scope

- Uploading a bundle from the browser.
