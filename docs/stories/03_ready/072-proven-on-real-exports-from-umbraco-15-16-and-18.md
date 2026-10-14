# 072 — Proven on real exports from Umbraco 15, 16 and 18

**Epic:** H — Importing an Umbraco site · **Priority:** should · **Size:** M
**Depends on:** 070

## Story

As someone moving an Umbraco 15, 16 or 18 site, I want the importer to have
been proven on a real site of my version, so that I can trust it as much as an
Umbraco 17 user can.

## Context

Only Umbraco 17 has been run against a real export: the Umbraco Commerce demo
store. Versions 15, 16 and 18 are accepted, and their two conversions are tested
against a copy altered to look like one, but no real export has been run
(WP-I.0 and WP-I.8 in [`umbraco-import.md`](../../umbraco-import.md) are
*partly*).

There is also no native Umbraco SQLite backup among the fixtures. The reader
normalises key casing and date spelling for one, but that is tested only
against an altered copy.

## Acceptance criteria

- [ ] A real export from each of Umbraco 15, 16 and 18 is among the fixtures,
      under a licence that allows it.
- [ ] A native Umbraco SQLite backup is among the fixtures.
- [ ] Each imports with no manual step, and every URL it served answers 200 on
      the imported site, as 17 does.
- [ ] `umbraco-import.md` records WP-I.0 and WP-I.8 as done, or says exactly what
      a real export showed and what was fixed.

## Out of scope

- Umbraco 13 and 14, which are detected and told to upgrade first, by decision.
