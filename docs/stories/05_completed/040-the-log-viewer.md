# 040 — The log viewer

**Epic:** E — Cross-cutting · **Priority:** should · **Size:** M
**Depends on:** —

## Story

As a site administrator, I want the backoffice's log viewer to show what the
server has been doing, so that I can find out why something failed without
shell access to the machine.

## Context

The first of the cross-cutting work. Umbraco's log viewer reads Serilog's
compact JSON files, so the cheapest faithful answer is to write those files and
read them the way Umbraco does, rather than invent a log store.

## Acceptance criteria

- [x] The server logs into the files Umbraco's log viewer reads: Serilog's
      compact JSON, one event per line,
      `logs/CromboloTraceLog.<machine>.<yyyyMMdd>.json`, enriched with
      `SourceContext`, `MachineName` and `ProcessId` as Umbraco enriches them.
- [x] The viewer reads the files of each day in the range (the last day by
      default), and refuses a range whose files pass Umbraco's 100 MB cap.
- [x] It counts levels (not Verbose, as Umbraco), groups by message template,
      and filters by a Serilog expression.
- [x] Saved searches are stored and seeded with Umbraco's.
- [x] Server messages that used to go to the console are log events.

## As built

- The server logs through LogTape, chosen for its Serilog-style message
  templates and because it has no dependencies of its own.
- The filter is a subset of Serilog expressions covering the saved searches and
  the filter box. A plain word, or anything that does not compile, falls back to
  a text search, as Umbraco does.
- Saved searches are migration 012's `log_viewer_query`, seeded with Umbraco's.
  The two that ask about Umbraco's own namespace and message template ask the
  same of crombolo's. The two about Umbraco's `SortedComponentTypes` property
  are left out.
- Now logged rather than printed: schema sync, imaging, template errors,
  background jobs and the development 501 log.
- Pinned by `tests/log-viewer.test.ts` and, in the backoffice, the log viewer
  step of `tests/browser/settings.browser.ts`.

## Out of scope

- Shipping logs anywhere but local files. A host that collects stdout or the
  files is free to.
