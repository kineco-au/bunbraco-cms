# 157 — A docs section on the product site

**Epic:** P — The command line · **Priority:** should · **Size:** M
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
  the platform's copy of the product site has to take the new schema and views
  before the bundle that uses them; the order of that release is part of the
  story.
- **Generated where it can be.** The command pages from the CLI manifest, the
  configuration table from the config loader's own list, and the exit codes from
  `packages/cli/src/errors.ts`, each with a test that fails when the page and its
  source disagree, as `tests/cli-reference.test.ts` does today.
- **Search**, using the site search for visitors (story 140).

## Acceptance criteria

- [ ] A Docs section on the product site, reached from the header, with a
      contents page and a sidebar on every docs page
- [ ] One page per command group, each command anchored, generated from the CLI
      manifest; the single reference page from story 150 redirects to it
- [ ] Guides for getting started, configuration, schema as code, content
      transfer, remotes and pull/push, deploying, and operations, adapted from
      `docs/` and the README
- [ ] The configuration reference and the exit codes generated from their
      sources, with tests that fail when they drift
- [ ] A docs page type and view in `sites/crombolo`, and a release order that
      brings the platform's copy of the site its schema before the content
- [ ] Docs pages are found by the site's search
- [ ] Every page passes the site's accessibility checks, and reads well on a
      phone
