# 110 — URL options Umbraco sites rely on

**Epic:** L — Routing · **Priority:** could · **Size:** S
**Depends on:** —

## Story

As a developer moving an Umbraco site here, I want the URL options it was built
with — the top-level page in the path, right-to-left segment order — so that
its addresses stay the same.

## Context

URLs follow Umbraco's default `HideTopLevelNodeFromPath = true`; there is no
switch to show the top level, and RTL segment order is not ported
([`../../rendering.md`](../../rendering.md), "URLs"). Changing either
changes every URL, so the redirect tracker has to see it as a rename.

## Acceptance criteria

- [x] A site setting shows the top-level page in paths; the default is
      unchanged.
- [x] Segments of a right-to-left culture are ordered as Umbraco orders them.
- [x] Changing either setting records redirects from the old URLs.
- [x] The importer carries the source site's setting across.

## Out of scope

- Other `Umbraco:CMS:RequestHandler` options.

## Decision (2026-10-15)

**In the schema files, and editable in the backoffice.** `schema/schema.toml`
gains a `[urls]` section (`hide-top-level`, default `true`), so the setting is
versioned and deployed with the site and the Umbraco importer writes it from
`HideTopLevelNodeFromPath`. A Settings screen changes it by writing that file,
as the backoffice already does for languages, so the file stays the one source.
Applying a change records redirects from every old URL. Right-to-left
cultures need no setting: as in Umbraco, their segments are not reversed into
root-first order, detected from the language.

## What was built

- `[urls] hide-top-level` in `schema/schema.toml`: parsed by
  `parseSchemaSettings`, written by `writeSchemaVersion(version, urls)` only
  when not the default, and hashed only then, so existing sites kept their
  hash. Every writer of `schema.toml` (version bumps, proposals, export) keeps
  it.
- The sync stores it (`key_value`, `crombolo:urls`; `readUrlOptions` /
  `writeUrlOptions` in `@crombolo/data`) on a current sync, and reports
  `urls: { before, after }` when it changed.
- The published cache reads it (`loadUrlOptions`): with the top level shown,
  every path starts with its top-level page and `/` still answers with the
  first. Right-to-left cultures (`isRightToLeft`) keep the page's segment
  first, below a domain too.
- Redirects: `redirectAfterUrlChange` captures every route from a cache built
  with the old setting and commits them through the redirect tracker. Run
  after the boot sync, the development watcher, the schema import and a
  proposal's import, and by the Settings save.
- Settings → **Page addresses** dashboard and `crombolo/api/url-options`
  (Settings section): GET the setting and whether it is editable here, PUT a
  change, which writes the file, records the redirects and tells other nodes.
  Refused with 409 where the schema files are read-only.
- The importer reads `HideTopLevelNodeFromPath` from `appsettings.json`, then
  `appsettings.Production.json` (comments and trailing commas allowed, keys in
  any case), and writes it into `schema/schema.toml`.
- Tests: `tests/url-options.test.ts`.
