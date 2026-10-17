# 157 — A docs section on the product site

**Epic:** P — The command line · **Priority:** should · **Size:** L
**Depends on:** 150

## Story

As a developer evaluating or using crombolo, I want a documentation section on
the product site — the command line reference among guides and concepts — so
that I can learn and look things up without reading the repository.

## Context

Story 150 puts one generated page on the product site: the command line
reference, written into the `demo/crombolo` bundle by `bun run build:template`
from the CLI's manifest (`packages/cli/src/reference.ts`). It is a single long
page under Developers, reusing the `developerPage` type so the content-only
bundle imports into the platform's copy of the site unchanged.

A docs section needs more than that page can give:

- **Navigation.** A table of contents, a sidebar, and one page per topic or per
  command, so that a link lands on the thing it names.
- **More than the CLI.** Getting started, configuration (`docs/configuration.md`),
  schema as code, content transfer, remotes, deploying and operations — the
  material now in `docs/` and the README, written for a reader of the site.
- **Its own page type and view.** A docs page with a body, a place in the
  navigation, and "edit this page" and "generated from" notes. A new type means
  the platform's copy of the product site needs the new schema and views along
  with the content that uses them.
- **Generated where it can be.** The command pages from the CLI manifest, the
  configuration table from a settings list the config loader reads, and the exit codes from
  `packages/cli/src/errors.ts`, each with a test that fails when the page and its
  source disagree, as `tests/cli-reference.test.ts` does today.
- **Search**, using the site search for visitors (story 140).

## Acceptance criteria

- [x] A Docs section on the product site, reached from the header, with a
      contents page and a sidebar on every docs page
- [x] One page per command group, each command anchored, generated from the CLI
      manifest; the single reference page from story 150 redirects to it
- [x] Guides for getting started, configuration, schema as code, content
      transfer, remotes and pull/push, deploying, and operations, adapted from
      `docs/` and the README
- [x] The configuration reference and the exit codes generated from their
      sources, with tests that fail when they drift
- [x] A docs page type and view in `sites/crombolo`, carried in the product
      site's bundle with its schema and views so one install brings both
- [x] Docs pages are found by the site's search
- [x] Every page reads well on a phone
- [x] The configuration reference and `docs/configuration.md` come from one
      settings list that `loadConfig` reads, with a test that fails when the
      code reads a setting the list does not declare

## Decisions

- **The bundle carries the site's structure.** The bundle format has carried
  schema, components, styles, scripts and the dictionary since sections format
  2; the product site's bundle is content-only only because
  `scripts/build-template.ts` calls `writeBundle(stable, read.bytes)` without
  them. The build passes `siteSections(sources, 'all')`, so one install brings
  the docs type and views and syncs schema before content in one transaction.
  That is the release order the story asked for — no separate schema release.
- **The product site always replaces files.** An install is refused while a
  differing file would be replaced. The repository is the source of the product
  site's structure, so its publish to the platform passes `replaceFiles` and an
  edit made on the platform is overwritten. The first install onto the
  platform's empty directories is all creates and needs nothing.
- **The configuration reference comes from a settings list that `loadConfig`
  reads.** Every setting is declared once — name, type, default, section,
  description — and `loadConfig` builds its environment values from that list
  instead of ~80 hand-written `Bun.env` reads. The page and
  `docs/configuration.md` are both generated from it, and the doc is rewritten
  to match what the code actually reads (it has drifted: wrong defaults, around
  107 `CROMBOLO_*` names in code against 79 documented).
- **No accessibility tooling.** The accessibility criterion is dropped; pages
  still have to read well on a phone.
- **One story**, resized from M to L.

## Plan

### 1. The settings list (server)

- `packages/server/src/settings.ts`: `SETTINGS`, one entry per environment
  variable — `env`, `kind` (`string | number | boolean | list | enum`),
  `default`, `section` (server, database, back office, media, e-mail, search,
  jobs, …), `description` written for a site owner, and `secret` for values
  never echoed. Settings read outside the server (`data/src/database.ts`,
  `cli/src/support/serve.ts`, `cli/src/templates.ts`, `cli/src/classify.ts`,
  `operations/commands.ts`) are declared in the same list, marked with where
  they apply.
- `loadConfig` reads through a typed `setting(name)` accessor over the list, so
  a variable the list does not declare cannot be read. Explicit values, then
  environment, then defaults — unchanged. Behaviour is pinned first by the
  existing config tests, then the reads are moved over section by section.
- A test scans `packages/**/src` for `CROMBOLO_*` names and fails when the code
  names one the list lacks, or the list declares one the code never reads.
- `bun run docs:config` regenerates the settings tables in
  `docs/configuration.md` between markers; the prose around them is rewritten
  where it has drifted. A test fails when the tables and the list disagree.

### 2. The docs page type and views (`sites/crombolo`)

- `docs-page.toml`: `docsPage` with `title`, `summary`, `body` (rich text),
  `source` (where a generated page comes from, shown as "Generated from …"),
  `editPath` (the repository file behind a written page, shown as "Edit this
  page"), and the `seoFields` composition. Allowed under a `docsSection` root
  page (contents page) and under itself.
- `pages/docsSection.tsx` and `pages/docsPage.tsx`: a sidebar built from the
  section's tree (current page marked, collapsed to a disclosure on a phone),
  an on-this-page list from the body's headings, previous / next links, and the
  notes above. Styles in `sites/crombolo/css`, following the light and dark
  tokens.
- A Docs link in the header.
- `developerPage` gets an `umbracoRedirect` content picker so the old
  `/developers/command-line/` page can point at the new section; content
  import cannot move, retype or delete an existing node, so the old node stays
  and redirects.

### 3. Generated pages (`scripts/build-template.ts`)

- `/docs/reference/command-line/`: an index, then one page per command group
  (`content`, `media`, `types`, …), each command anchored. Single-command
  topics (`init`, `start`, `pull`, `push`, …) are grouped by an explicit
  mapping in the build, so a new command fails the build until it is placed.
  `reference.ts` is split so one group renders on its own.
- `/docs/reference/configuration/` from `SETTINGS`.
- `/docs/reference/exit-codes/` from `packages/cli/src/errors.ts`, with the
  error envelope.
- Fixed keys per generated page, derived from the group name, so a rebuild
  updates rather than duplicates.
- `tests/cli-reference.test.ts` grows to cover each generated page against its
  source.

### 4. Written guides (`sites/crombolo/docs/*.md`)

- Getting started, configuration, schema as code, content transfer, remotes and
  pull/push, deploying, operations — adapted from `docs/` and the README for a
  reader of the site, without internal story numbers or repository paths.
- Rendered with `marked` (already a dependency) into the `body` of a
  `docsPage`; front matter carries the title, summary, order and key.
- Fix on the way: `docs/operations.md:467` (the old remote exit codes) and
  `docs/content-transfer.md:804` (says redirects do not travel).

### 5. Search

- A `/docs/search/` page from the starter's `searchPage.tsx` and
  `search-page.toml`, limited to the Docs section, and a search box in the
  sidebar.
- A test that a docs page is found by a word from its body after the bundle
  installs.

### 6. The bundle and the platform

- `build-template.ts` passes `siteSections(sources, 'all')` to `writeBundle`;
  the sections sit under the bundle's `content/`, which `files` already lists.
- A test installs the built bundle onto a fresh site and finds the docs pages
  rendered, and installs it again over a changed view with `replaceFiles`.
- crombolo-cloud: the product site's import already passes `replaceFiles: true`
  (`src/ops/control-plane/bundles.ts`, `transferArgs` in `listener.ts`); that
  its files land where every node reads them is cloud story 044.

### Tests

Unit tests for the settings list and drift scan, `loadConfig` behaviour
unchanged, generated-page drift, the guide renderer and front matter, the
group mapping, and the bundle install. Formatting and both dialect suites
(the config change touches the database URL settings). No browser tests unless
asked.

## Implementation

- **The settings list** (`packages/server/src/settings.ts`): 112 settings in
  14 sections — every `CROMBOLO_*` name the code reads, plus `NODE_ENV`, `PORT`,
  `DATABASE_URL` and the `AWS_*` fallbacks. `setting(name)` is the one way to
  read one: an undeclared name is a type error and throws at runtime. It
  applies no defaults, so `loadConfig`'s behaviour is unchanged; that was
  pinned first by `tests/config-env.test.ts`, written against the old
  `loadConfig`. Reads stay in place, declared, where importing the server would
  make a cycle (`@crombolo/data`'s database URL, the assistant's Bedrock
  credentials) or where an `env` record is injected for tests.
  `tests/settings-list.test.ts` scans every package's source and fails on a
  name the list lacks or one nothing reads (`NOT_SETTINGS` names the matches
  that are not settings, with why). `bun run docs:config` regenerates the
  tables in `docs/configuration.md`, whose prose was rewritten around them.
- **Page types and views** (`sites/crombolo`): `docsSection` (the `/docs/`
  front page), `docsPage` (title, summary, body, "Generated from", edit link,
  and `umbracoUrlName` so a page's address is its slug, not its title) and a
  `searchPage` limited to the two docs types. `components/shared/docs.tsx` is
  the frame: a sidebar opened along the current page's branch, breadcrumbs,
  "On this page" from the body's `<h2 id>`s, previous / next in reading order,
  and a search box. On a phone the sidebar stacks above the page and wide
  tables scroll inside it. A Docs link joins the header.
- **The tree** (`scripts/docs-site.ts`, written by `build:template`):
  `getting-started`, `guides/*` from `sites/crombolo/docs/**.md`, and
  `reference/command-line` (an index plus one page per group in `CLI_PAGES`),
  `reference/configuration` (from `SETTINGS`) and `reference/exit-codes`, then
  `search`. Keys are a digest of each page's path, so a rebuild updates rather
  than duplicates. Guides need `title`, `summary` and `order` front matter and
  may not use `#`; Markdown headings get ids.
- **The command line reference** (`packages/cli/src/reference.ts`):
  `CLI_PAGES` places every topic; `unplacedTopics` is empty for the core CLI
  (tested), and a plugin's topic gets a page of its own rather than being
  dropped. `cliReferenceHtml` is gone with the single page.
- **Story 150's page** stays — an import cannot delete or retype it — as a
  `developerPage` whose new `umbracoRedirect` picker sends visitors to
  `/docs/reference/command-line`.
- **The bundle** carries `schema/`, `components/` and `styles/` for
  `demo/crombolo` only (`CARRIES_SITE`); the templates stay content-only.
- **The platform**: crombolo-cloud's import already passes `replaceFiles: true`
  (its story 044 work). Two behaviours of an install, found while testing:
  views written by an install are picked up by a running server on its next
  view check (within `CROMBOLO_COMPONENTS_GATE_MS`, 5 s by default), and new
  pages reach site search on the indexer's next round (5 s).
- **A fix on the way**: `content check` read every existing node through the
  document repository, so a Library element or media item came back with no
  values and every one in a reinstalled bundle was reported as edited here,
  holding the import for a decision. It now reads each kind through its own
  repository (`packages/transfer/src/check.ts`; covered in
  `tests/content-check.test.ts`).
- **Also corrected**: `docs/operations.md` (remote exit codes),
  `docs/content-transfer.md` (access rules, schedules and tracked redirects do
  travel; the `--with-blobs` example) and `docs/schema-as-code.md`
  (`components` / `default-component`, and where `generate` writes).
- **Tests**: `tests/docs-site.test.ts` (Markdown, front matter, every guide
  well formed, every setting listed once, the committed bundle matches a fresh
  build, the redirect, the carried sections, and an install onto an empty site
  that renders, searches, refuses a differing view without permission and
  replaces it with), `tests/cli-reference.test.ts`, `tests/settings.test.ts`.
