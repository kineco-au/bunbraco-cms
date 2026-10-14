# 010 — Packaging

**Epic:** B — Packaging and upgrades · **Priority:** must · **Size:** M
**Depends on:** 005

## Story

As a site developer, I want to install the CMS as one npm package into a
directory of my own, so that a site is my code depending on a released
framework rather than a fork of this repository.

## Context

Epic B was inserted after 005 and before any widening, because every widening
area would otherwise be built on a model that was about to be replaced. It has
three slices, in order: packaging (this story), schema as code and the value
layer (011), and the upgrade machinery (012–015). The full design is in
[`../../schema-as-code.md`](../../schema-as-code.md) and
[`../../packaging-and-upgrades.md`](../../packaging-and-upgrades.md).

This slice moves the composition root out of `apps/site` into
`@crombolo/server`, declares every inter-package dependency and an `exports`
map, publishes the built backoffice as `@crombolo/backoffice-dist` resolved
from `node_modules`, adds the umbrella `@crombolo/crombolo` package with the
CLI, and turns `apps/site` into a genuine reference site.

## Acceptance criteria

- [x] A fresh directory with `bun add @crombolo/crombolo`, a config file and a
      three-line `server.ts` boots the backoffice and renders a page.
- [x] No tsconfig `paths` in the site, nor in the repository root.
- [x] The composition root is in `@crombolo/server`.
- [x] `@crombolo/backoffice-dist` holds the built client and is resolved as a
      dependency.
- [x] Every package declares its dependencies and an `exports` map.
- [x] `@crombolo/crombolo` ships `crombolo()` and the CLI: `start`, `init`,
      `admin reset-password`. `upgrade`, `schema` and `generate` were stubbed
      here and built by 011–015.

## As built

- `@crombolo/contracts` carries its own `OpenApi.json`.
- Verified with a site in `/tmp` whose only dependency is
  `@crombolo/crombolo`: `init`, boot, login, a template in the site's own
  `components/`, and a rendered page.

## Technical notes

The exit test earned its keep on the first run. Everything passed except the
render, because a view's JSX imported `@crombolo/render/jsx-dev-runtime`. That
name resolves inside the monorepo, where the root depends on every package,
but not from a site that depends only on `@crombolo/crombolo`. The umbrella
package now exports the JSX runtime itself, and `jsxImportSource` is
`@crombolo/crombolo` everywhere. Nothing in the test suite could have caught
that; only a consumer outside the repository could.
