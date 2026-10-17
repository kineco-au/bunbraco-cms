# 158 — A hosting plugin for the CLI

**Epic:** P — The command line · **Priority:** should · **Size:** S
**Depends on:** 150

## Story

As a developer whose site is hosted on Crombolo Cloud, I want its commands
inside the `crombolo` I already use, as `crombolo cloud …`, so that I install
one extra package rather than learning a second tool.

## Context

The CLI is oclif (`150`), but nothing extends it: the `oclif` block in
`packages/cli/package.json` names no plugins, and `@crombolo/cli` exports none
of what a command is built from. A hosting platform's commands therefore need
either a second CLI or a fork.

Two things are missing:

- **Loading.** `@crombolo/cloud` is declared as an optional plugin. Installed,
  as a dependency of the site or globally beside the CLI, its commands appear
  under the `cloud` topic. Not installed, the CLI behaves exactly as it does
  today.
- **Building.** A plugin's commands should behave like the CLI's own: the same
  global flags, `--json` envelope, exit codes, `crombolo schema` entries and
  reference page (`150`). It should sign in the way `crombolo login` does, so
  a person signs in once for both `crombolo pull` and the plugin. Today all of
  that sits behind internal paths.

## Acceptance criteria

- [x] `@crombolo/cloud` is listed in the `oclif` block as an optional plugin.
      When it is installed, `crombolo cloud --help` lists its commands, and
      `crombolo --help` lists the `cloud` topic.
- [x] When it is not installed, nothing changes: no warning on any command,
      and the suite passes without it. `crombolo cloud` with no plugin says
      how to install it and exits with the CLI's code for an unknown command,
      not 0.
- [x] `@crombolo/cli/plugin` exports what a plugin command needs:
  - `BaseCommand`, with the global flags, the `--json` envelope, `fail()` and
    the exit codes;
  - the remote client: `discover`, `signIn`, `RemoteClient`, `keychain` and
    `openInBrowser`.

  It is a subpath, so a plugin does not pull in the whole CLI, and it is
  covered by semver like the main entry.
- [x] A plugin command is in `crombolo schema` and the reference page, under
      its topic, and the clispec checks from `150` pass over it.
- [x] A sign-in a plugin makes with `signIn(discover(url), keychain())` is the
      same entry `crombolo login` makes for a remote with that URL, and the
      other way round. The test signs in through one and uses the other.
- [x] A test plugin in the suite, which is not shipped, proves all of the
      above.
- [x] The CLI docs say how a plugin is written and loaded.

## Out of scope

- A plugin manager: no `crombolo plugins install`.
- Loading any plugin other than the one named.

## What was built

- **Loading.** oclif loads only the plugins the CLI's `package.json` depends on,
  and warns over a missing one, so `packages/cli/src/load.ts` does it: for each
  name in `oclif.optionalPlugins` it looks for an installed package in the
  site's `node_modules`, then beside the CLI, loads it as an oclif `Plugin`, and
  hands `Config.load` the CLI and what it found. A missing plugin is silent;
  `main.ts` answers `crombolo cloud` without it with a `usage` failure that
  says how to add it.
- **Building.** `@crombolo/cli/plugin` (`packages/cli/src/plugin.ts`) exports
  `BaseCommand`, `Args` and `Flags` (the CLI's own oclif, so a plugin needs no
  copy), `CliError` and the kinds and outcomes, and the remote client:
  `discover`, `signIn`, `RemoteClient`, `RemoteError`, `problemOf`, `TimedOut`,
  `keychain`, `openInBrowser`. It stays light: `BaseCommand` loads the failure
  classifier and the audit writer only when it needs them, and the remote code
  reaches the server package through two narrow subpaths,
  `@crombolo/server/remote-credentials` and `@crombolo/server/atomic-write`,
  rather than its whole index. A test holds that importing it loads no CLI
  command and not the server's index.
- **Schema and reference.** Plugin commands are in the loaded config, so
  `crombolo schema` lists them; `manifestOf(config)` gives the reference page
  generator the same. The CLI's own `oclif.manifest.json` stays the CLI's
  commands alone.
- **Tests.** `tests/fixtures/cloud-plugin`, a `@crombolo/cloud` stand-in linked
  into a temporary site's `node_modules`; `tests/cli-plugin.test.ts` covers help,
  the global flags, the envelope and exit codes, clispec validity, the
  reference page, the absent case, the export surface and its weight, and one
  sign-in shared both ways against an in-process remote.
- **Docs.** `docs/operations.md` § Plugins.
