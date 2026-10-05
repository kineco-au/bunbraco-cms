# Bunbraco — Overview

A CMS with a Bun + TypeScript backend and React-style TSX templates, edited
through the Umbraco backoffice.

## Mission

A working core CMS on Bun + TypeScript, with SQLite as the default store and
Postgres as an option. Editors work in the Umbraco backoffice, unmodified, so the
server implements that backoffice's API contract over a relational model shaped
like Umbraco's. Everything else — rendering, schema as code, upgrades, content
transfer — is this project's own.

It is not a compatible replacement for Umbraco: plugins, packages and Razor do
not run here and never will. An existing site comes across through a one-way
importer ([`16-umbraco-import.md`](16-umbraco-import.md)), not by being opened in
place.

Reference implementation: `/Users/adam/dev/Umbraco-CMS` at
`release-18.2.0-99-ge81538b0400` (`version.json`: `18.3.0-rc`).

## Why this is tractable

1. **The editor is already a standalone SPA.** The Umbraco 18 backoffice is a Lit
   web-component app published to npm as `@umbraco-cms/backoffice@18.2.0`
   (23 MB unpacked, 15,396 files; ships built runtime JS under `dist-cms/`, with
   third-party runtime dependencies supplied via an **importmap** rather than npm
   dependencies). It talks to the server over REST + OAuth. Nothing in it is
   .NET-specific. The server's only HTML responsibility is a ~60-line shell.
2. **The API contract is a committed artefact.**
   `src/Umbraco.Cms.Api.Management/OpenApi.json` (1.5 MB) is the byte-for-byte
   source of truth, and the backoffice's own HTTP client is generated from it with
   `@hey-api/openapi-ts`. It holds **428 paths / 513 operations / 507 schemas**,
   and has drifted only 27 lines since the `release-18.2.0` tag — so npm `18.2.0`
   paired with `git show release-18.2.0:src/Umbraco.Cms.Api.Management/OpenApi.json`
   is a consistent set.

The work is therefore: implement that OpenAPI document in Bun over an
Umbraco-shaped relational model, plus a front-end rendering layer.

## Decisions

| Area | Decision |
| --- | --- |
| Backoffice UI | Consume `@umbraco-cms/backoffice@18.2.0` from npm, **unmodified**; serve `dist-cms/**` at `/umbraco/backoffice/*`. The login SPA is *not* published to npm — see R2 in `07-roadmap.md`. |
| DB schema | Umbraco's relational model and semantics, **snake_case naming** (`content_version`, `property_data`). No drop-in compatibility with existing Umbraco databases. |
| DB dialects | **SQLite and Postgres from day one**, both exercised in CI, behind a single dialect seam. |
| Templating | **Bun-native TSX server rendering** with an Umbraco-shaped model API (`model.value('alias')`, layouts, sections). |
| Search | Database-native full text: **SQLite FTS5 / Postgres `tsvector`**, exposed through Umbraco's `searcher`/`indexer` endpoints. |
| Federated members | **External identity providers** (OIDC/OAuth) linked to locally-stored members, mirroring Umbraco's external-login model. |
| Sequencing | **Deep vertical slice first**: login → document type → edit → save → publish → render; then widen. |
| Schema definitions | **Code first, in TOML files** under `schema/` — document types, data types, languages. The database's schema tables are a cache synced at boot. The backoffice type editor writes the files. See `09-schema-as-code.md`. |
| Packaging | A site installs `bunbraco`; the built backoffice ships as `@bunbraco/backoffice-dist`; the composition root is framework code. One Umbraco backoffice major per bunbraco major. See `10-packaging-and-upgrades.md`. |
| Promotion and upgrades | Metadata promotes development → test → production as files; site-authored value migrations run once per environment; a framework release is the same process with one more source of change. Expand/contract schema migrations with a ledger and `--plan`. **A pre-upgrade check proves and prepares the data while the current version is live**: findings are auto-fixable, need a person, or blocking; `check --fix` applies the additive part early so new required fields appear in the live backoffice to be filled in, gated by a `since` version so they are not enforced or rendered until their release deploys; `upgrade` is gated on a clean check. Values are append-only and tagged with the schema state that wrote them, and only a node at the current state may write — so a rolling deploy of even a breaking change never interrupts readers. Production never auto-upgrades. |

**Status:** phases 0–4 are complete — the slice works end to end. 49 of 513 API
operations are implemented and 161 tests pass on both dialects. See
[`07-roadmap.md`](07-roadmap.md) for exactly what is and is not built.

## Non-goals

- Compatibility with Umbraco's own package ecosystem; Razor and AngularJS-era
  compatibility. Backoffice extensions of our own are npm dependencies
  ([`17-packages.md`](17-packages.md)); an Umbraco package does not install here
- .NET-specific machinery: ModelsBuilder DLL generation, Examine/Lucene, ImageSharp
- Umbraco Cloud/Deploy, Forms, Commerce and other commercial add-ons
- SQL Server support
- Opening an existing Umbraco database in place (excluded by the snake_case decision).
  A one-way importer does that instead: [`16-umbraco-import.md`](16-umbraco-import.md)

## Glossary — Umbraco term → bunbraco module

| Umbraco | Bunbraco |
| --- | --- |
| `Umbraco.Core` (domain, notifications) | `packages/core` |
| `Umbraco.Infrastructure` + `Persistence.Sqlite` | `packages/data` |
| `Umbraco.Cms.Api.Management` | `packages/api-management` |
| `Umbraco.Cms.Api.Delivery` | `packages/api-delivery` |
| `Umbraco.Cms.Api.Common` (OpenIddict auth) | `packages/auth` |
| `Umbraco.Cms.StaticAssets` + backoffice shell views | `packages/backoffice-host` |
| `Umbraco.Web.Website` + `PublishedCache.HybridCache` | `packages/render` |
| `Umbraco.Web.UI` (host app), `Views/` | `apps/site` |
