# 070 — Import schema, content and views

**Epic:** H — Importing an Umbraco site · **Priority:** should · **Size:** L
**Depends on:** —

## Story

As someone running an Umbraco site, I want to point crombolo at a backup of it
and get a working crombolo site back, so that moving does not mean rebuilding
the site by hand.

## Context

This reverses "importing an existing Umbraco database" as a non-goal. The
snake_case decision still stands: the database is converted, never opened in
place.

`crombolo import umbraco` is pointed at a backup of an Umbraco site.

1. It first produces a compatibility report listing what cannot be migrated:
   packages, plugins, Razor views and custom code.
2. It then writes a crombolo site: schema as TOML, content as a bundle, a view
   stub per template, and the media files.

It converts into the existing interchange formats rather than writing rows, so
the import itself is `start --bundle`. The design, the version analysis and
what is left are in [`umbraco-import.md`](../../umbraco-import.md).

## Acceptance criteria

- [x] A compatibility report is produced before anything is written.
- [x] The output is a site: schema TOML, a content bundle, view stubs and media.
- [x] **Exit, met for Umbraco 17:** the Umbraco Commerce demo store (33 content
      types, 436 nodes, a package installed) imports with no manual step, and
      every URL it served answers 200 on the imported site.
- [x] Versions below 15 are refused, with a message to upgrade with Umbraco
      first.

## As built

- **Two stages.** A `.bacpac` is the primary input, and restoring one needs
  .NET. So a standalone open-source TypeScript library,
  `@kineco-au/bacpac-importer`, decodes it and writes a faithful copy to SQLite
  while knowing nothing about Umbraco. `@crombolo/import-umbraco` then reads
  that copy and does everything Umbraco-specific.
- **Opt-in.** The CLI loads the importer on demand, so no site carries it unless
  it asks.
- **Versions.** Umbraco 15, 16 and 18 are accepted, with their two conversions
  tested against an altered fixture, but no real export of any of them has been
  run. That is 072.
- **Counted, not imported:** members and users (with their password hashes),
  redirects, protected pages and schedules. That is 071.
- **Tests.** `tests/import-umbraco.test.ts` runs the importer in-process.
  `tests/integration/import-umbraco.integration.ts` drives the CLI as a person
  would and fetches every URL from the booted site.

## Out of scope

- Members, users, redirects, protected pages and schedules (071).
- Real exports from 15, 16 and 18 (072).
