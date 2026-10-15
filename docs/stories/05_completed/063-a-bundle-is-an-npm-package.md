# 063 — A bundle is an npm package

**Epic:** G — Trusting and extending bundles · **Priority:** should · **Size:** L
**Depends on:** —

## Story

As a bundle author, I want one artifact — an npm package — to carry everything my
bundle is: its backoffice screens, its server endpoints, and the schema,
components and content it brings, so that a bundle has one identity, one version
and one way to reach a site.

As a site administrator, I want every bundle to arrive the same way and say what
it is, so that I never have to work out which of three things called "bundle" I
am holding.

## Context

**Three things are called a bundle today** ([`bundles.md`](../../bundles.md),
[`content-transfer.md`](../../content-transfer.md)), and none of them refers to
the others:

| | What it is | Format | How it reaches a site | Identity |
|---|---|---|---|---|
| Content bundle | content, media, schema, components, styles, scripts, dictionary | a directory: `bundle.json`, `nodes/`, `schema/`, … | `bundle install <dir>`, `start --bundle <dir>`, a template's `bundle/`, the Created view's zip | `bundle.json` `id` and `label` |
| Extension | backoffice manifests | an npm package with a `crombolo` field | discovered from the site's dependencies; the Marketplace runs `bun add` | `crombolo.id` (`Crombolo.SimpleRedirects`) |
| Server bundle | backoffice endpoints over capabilities | a `ServerBundle` returned by a factory | imported into `crombolo.config.ts` | `ServerBundle.id` (`redirects`) |

**What that costs:**

- The content half *can* travel inside a package — `loadBundle` reads any
  directory holding a `bundle.json` — but nothing declares it, nothing finds it,
  and `bundle install` takes a filesystem path rather than a package name.
- A created bundle has no version, no dependencies and no registry, so it cannot
  be published or depended on.
- A wired `ServerBundle` has no version and no peer range, and nothing ties it to
  the package it came from. Story 062 needs both: a bundle's migrations are linted
  against its version, and boot refuses a bundle whose peer range excludes the
  running core.
- One bundle carries up to three unrelated identifiers: its npm name, its
  `crombolo.id`, and its `ServerBundle.id`.

**The outcome: from here on, a crombolo bundle is an npm package, with no
exceptions.** Every artifact the CMS reads, writes or names as a bundle is a
package directory (or a packed tarball of one) whose `package.json` carries the
bundle manifest in its `crombolo` field. The `bundle.json` format is kept, as the
payload a package's content half is written in, and is never a bundle on its own.

**What does not change:**

- The server half is still wired by hand in `crombolo.config.ts`. Being a package
  is how a bundle is *identified*; it is never how its code is *loaded*. The
  security argument in `bundles.md` Part 3 rests on that edit, and this story
  keeps it.
- A runtime install still never loads a bundle's code.
- The `bundle.json` payload format, its integrity hash, the overlay check and the
  installer behind `content import`.

## Acceptance criteria

**The manifest**

- [x] The `crombolo` field is the bundle manifest, validated in one place and
      typed as `BundlePackage` beside the other bundle types `@crombolo/crombolo`
      exports:

      ```json
      {
        "name": "@acme/tasks",
        "version": "1.1.0",
        "keywords": ["crombolo-bundle"],
        "peerDependencies": { "@crombolo/crombolo": "^0.10.0" },
        "crombolo": {
          "id": "acme-tasks",
          "name": "Tasks",
          "extensions": [],
          "content": "content",
          "server": "tasks"
        }
      }
      ```

  - [x] `id` is the bundle's one identity: its route segment, its log name, and
        (story 062) its table prefix. It follows the rule `ServerBundle.id`
        follows today.
  - [x] `name` is what a person calls it, in the backoffice and the boot log.
  - [x] `extensions` is the client half, unchanged.
  - [x] `content` is optional: a directory inside the package holding a
        `bundle.json` payload.
  - [x] `server` is optional: the name of the factory the package's entry point
        exports. It is a declaration, never an instruction to import.
  - [x] A manifest with none of `extensions`, `content` or `server` is refused:
        it declares a bundle that does nothing.
- [x] `peerDependencies["@crombolo/crombolo"]` is required of every bundle, and
      boot refuses one whose range excludes the running `VERSION`, naming the
      bundle, its range and the running version.
- [x] Validation problems are reported together, by package, the way
      `validateServerBundles` reports them.

**The server half belongs to a package**

- [x] `ServerBundle.id` must equal the `crombolo.id` of the package that exports
      it, and `ServerBundle` no longer declares `name`: it is read from the
      manifest.
- [x] Boot matches each wired bundle to a **declared dependency** of the site
      whose manifest has that `id` and declares `server`. A wired bundle that
      matches no such dependency refuses to boot, naming the id.
- [x] The mounted bundle carries its package's name, version and peer range,
      which is what story 062 reads.

**The content half belongs to a package**

- [x] `crombolo bundle check <name>` and `crombolo bundle install <name>` resolve
      a declared dependency and apply its `content` directory through the existing
      installer.
- [x] `bundle check <dir>` and `bundle install <dir>` take a package directory and
      apply it in place, without adding it to `package.json`. This is how an
      environment's export is applied.
- [x] A directory holding `bundle.json` and no `package.json` is refused, with a
      message naming what to do.
- [x] `start --bundle` takes the same arguments as `bundle install`.
- [x] The transfer run records the package name and version it applied.

**Every writer produces a package**

- [x] The Created view's download is a package: a `package.json` with the
      manifest, the `crombolo-bundle` keyword and a peer range on the running
      core, and the payload under `content/`. A definition gains the package name
      and version to write.
- [x] `crombolo content export` writes a package directory, with the payload under
      `content/` and the package marked `private`.
- [x] A template's `bundle/` becomes a package, and `init` scaffolds the site's
      starter content as one.
- [x] `sites/*/bundles/*` and `packages/cli/templates/*/bundle` are converted.

**Discovery and the Marketplace**

- [x] Discovery reads the whole manifest, not only `extensions`. The Installed
      view lists every bundle dependency with what it carries (screens,
      endpoints, content), whether its server half is wired, and whether its
      content has been applied.
- [x] The Marketplace lists a package only when its manifest validates.
- [x] A Marketplace install applies the package's content half after `bun add`,
      unless `applyBundleContentOnInstall` is `false` or the request says not to.
      A refused content check leaves the dependency installed and says why.
- [x] `@crombolo/simple-redirects` moves to the new manifest, with `id` set to
      `redirects`, its existing route segment.

**Tests**

- [x] The manifest validator's rules, one test each.
- [x] A wired bundle with no matching dependency, and one whose peer range
      excludes `VERSION`, each refuse to boot by name.
- [x] `bundle install <name>` applies a dependency's content; `bundle install
      <dir>` applies a package directory in place and leaves `package.json`
      untouched; a bare `bundle.json` directory is refused.
- [x] The Created view's download, unpacked, is a package that `bundle install`
      accepts.
- [x] `content export` followed by `bundle install` on a second database round
      trips, as the transfer tests do today.
- [x] `tests/server-bundles.test.ts` keeps holding that nothing is discovered: a
      manifest naming `server` loads no code until the factory is wired.
- [x] **Exit:** every artifact in the repository that is called a bundle is an
      npm package, and nothing in the CLI, the server or the backoffice accepts
      one that is not.
- [x] [`bundles.md`](../../bundles.md) and
      [`content-transfer.md`](../../content-transfer.md) describe one artifact,
      and the CLI help and the backoffice say "bundle" for one thing only.

## Technical notes

- **Resolution goes through Bun**, exactly as extension discovery does today
  (`backoffice-host/src/extensions.ts`), so workspaces, hoisting and scoped names
  all work, and a transitive dependency cannot claim to be a bundle the site
  never declared.
- **Matching a wired factory to its package.** The factory is imported by name,
  so it does not know which package exported it. The match is made by id: the
  factory returns the `id` its package's manifest declares, read from its own
  `package.json` with a JSON import so the author writes it once, and boot
  checks it against the dependency that declares `server`. A `defineServerBundle`
  helper was considered and not built: the import is one line and needs no API.
- **An environment's export is a package that is never depended on.** It is
  marked `private`, so `bun publish` refuses it, and it is applied from its
  directory. Promoting content is a one-off move of data, and adding it to the
  site's dependencies would record something the site does not depend on.
- **The payload keeps its own `id`.** `bundle.json`'s `id` identifies one export
  run, and the transfer ledger keys on it, so it stays distinct from the
  package's `crombolo.id`.

## Decisions

Taken before starting, 2026-10-14:

- **The Created view downloads an npm-format `.tgz`**, laid out as `npm pack`
  lays one out (`package/…`), so `bun add ./file.tgz` and `bun publish` take it
  as it is. Written by a small tar writer beside `zip.ts`, with no dependency.
- **A Marketplace install applies the content half**, through the same overlay
  check and installer as `bundle install`, straight after `bun add`. A refused
  check leaves the dependency installed and reports why. The config setting
  `applyBundleContentOnInstall` (default `true`) turns this off for a site, and
  the install request can turn it off for one install.
- **The old shape is refused**, with a message describing the package layout. No
  converter.
- **An environment's export is a private package**, as above.
- **The installer moves into `@crombolo/server`.** The section planner and the
  core of `content check` and `content import` take a `Db` the caller supplies,
  so the Marketplace applies content with the server's own connection. The
  CLI's commands become wrappers that open the database.
- **A created bundle stores its npm name and version.** Two columns on `bundle`,
  set from the Created overview. Umbraco's builder has no field for them, and
  its workspace has no seam. Until set, they default to the definition's name
  as a slug and `1.0.0`. The migration ships in 0.10.0.
- **The manifest type is `BundlePackage`**, not `BundleManifest`, because
  `@crombolo/transfer` already uses that name for `bundle.json`.

## What was built

The payload directory inside a package is `content/` (`PAYLOAD_DIR`), matching
the manifest field that names it. It was `bundle/` at first, which doubled up
inside a template's own `bundle/` directory (`…/bundle/bundle/blobs`).


- **The manifest** — `backoffice-host/src/bundle-package.ts`: `readBundlePackage`,
  `validateBundlePackage`, `discoverBundles`, `peerRangeProblem` and
  `isSemverRange` (Bun's own matcher accepts a nonsense range and matches it).
  Extension discovery (`extensions.ts`) is built on it; `@crombolo/crombolo`
  exports `BundlePackage` and `CromboloField`. The core package's own
  `crombolo` field, its release declaration, is never read as a bundle.
- **Server bundles** — `ServerBundle.name` is gone. `validateServerBundles` and
  `createServerBundles` take the discovered packages and the running version,
  refuse a wired bundle no declared package owns, one whose package declares no
  `server`, and one whose peer range excludes `VERSION`. `MountedBundle` carries
  the package's name, version and peer range for story 062.
- **The installer** moved from `cli/src/operations/sections.ts` to
  `server/src/bundle-sections.ts`, and the core of check and import to
  `server/src/bundle-install.ts` (`readBundle`, `checkBundleContent`,
  `installBundleContent`), each taking a `Db`. `TransferInput.dir` became
  `bundle`: a package directory or a dependency's name. The CLI's
  `contentCheck`/`contentImport` open the database and call these.
- **Writers** — `transfer/src/package.ts` (`writeBundlePackage`,
  `bundlePackageJson`, `bundleIdFor`, `packageNameFor`). The Created view
  downloads an npm-format `.tgz` written by `server/src/tar.ts`;
  `content export` writes a private package (`--name`, `--package-version`);
  `build:template`, the Umbraco importer and every committed bundle in `sites/`
  and `packages/cli/templates/` use the package layout.
- **Migrations, 0.10.0** — 029 adds `bundle.package_name`/`package_version`;
  030 adds the same to `content_transfer_run`. `bun run release:version 0.10.0`
  was run first, so `VERSION` admits them. `release:version` now also moves
  `peerDependencies["@crombolo/crombolo"]` in every committed bundle.
- **The Marketplace** lists a hit only when its manifest validates and shows
  what it adds. An install applies the content half after `bun add` unless
  `applyBundleContentOnInstall` (`CROMBOLO_APPLY_BUNDLE_CONTENT`) is off or the
  card's toggle declines it; a refused or failed apply leaves the dependency
  installed and says why. The Installed view shows what each bundle adds,
  whether its content has been added (from the run's package columns) and
  whether its server features are on. The Created overview edits the npm name
  and version through `<backoffice>/crombolo/api/bundles/created/<id>/package`.
- **`@crombolo/simple-redirects`** — `crombolo.id` is `redirects`, it declares
  `server` and a peer range, and its factory reads its id from its manifest.
- **Tests** — `bundle-package.test.ts` and `tar.test.ts` are new; the installer,
  download, marketplace, server bundle, template and importer suites cover the
  rest.

## Out of scope

- Provenance of a bundle's code (060) and reviewed publishers (061).
- Tables a bundle owns (062), which this story unblocks.
- Publishing to the registry from the backoffice. A created package is
  downloaded and published with the author's own tooling.
- Importing an Umbraco package.
