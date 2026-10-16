# 074 — An Umbraco extension exports a crombolo bundle

**Epic:** H — Importing an Umbraco site · **Priority:** should · **Size:** L
**Depends on:** 104, 105

## Story

As someone running an Umbraco site, I want to install an extension in that
site and download it as a crombolo whole-site file, so that moving to crombolo
is one export there and one `crombolo import` here, with no backup to restore
or convert.

## Context

Today an Umbraco site is moved by `crombolo import umbraco` (`070`, `071`).
That command:
- reads a `.bacpac` backup, decoded by `@kineco-au/bacpac-importer`;
- converts the backup through `@crombolo/import-umbraco` into a crombolo site:
  schema TOML, a content bundle, view stubs and media.

This works only from a backup. It also re-implements Umbraco's storage from the
outside: every Umbraco version that changes a table is a new conversion (`072`).

`104` defines the whole-site file, and `105` imports one with `crombolo import`.
An extension running inside Umbraco can write that file from Umbraco's own
services, so the conversion uses the version of Umbraco that stored the data
and needs no backup.

Decided 2026-10-16:
- **`crombolo import <file>` becomes the import for a whole-site file** (`105`).
- **`crombolo import umbraco …` is deprecated.** It keeps working, and prints a
  deprecation notice, until this story lands. It is then removed with
  `@crombolo/import-umbraco` and the bacpac dependency.

## Acceptance criteria

- [ ] An Umbraco extension, installed in an Umbraco 15–18 site, adds a
      back-office action that downloads the site as a crombolo whole-site file
      (`104`'s format, `scope: 'site'`).
- [ ] The file carries what `070` and `071` convert today:
      - schema;
      - content with its values;
      - media with their files;
      - dictionary;
      - a view stub per template;
      - members and users with their password hashes, sealed with a passphrase
        the person exporting gives;
      - redirects, protected pages and schedules.
- [ ] Before writing, it shows `070`'s compatibility report: packages, plugins,
      Razor views and custom code that will not come across.
- [ ] `crombolo import <file>` and `crombolo start --from <file>` accept the
      file unchanged, with no Umbraco-specific path on the crombolo side.
- [ ] The Umbraco Commerce demo store exports and imports with no manual step,
      and every URL it served answers 200 (`070`'s exit, re-run through the
      extension).
- [ ] `crombolo import umbraco`, `@crombolo/import-umbraco` and the bacpac
      dependency are removed, and the docs point at the extension.

## To decide before starting

- **Where it lives.** An Umbraco extension is a .NET package, and this
  repository takes no .NET dependencies. It likely goes in its own repository,
  as `@kineco-au/bacpac-importer` did, and depends only on the bundle format
  documented in `docs/bundles.md`. How the format is kept in step needs
  deciding: a published JSON schema, or `104`'s fixture copied into it.
- **Large sites.** Whether the download streams from the back office, or the
  extension writes the file to disk for collection.
- **`072`** (proven on real exports from 15, 16 and 18) is re-scoped to the
  extension rather than the bacpac path.

## Out of scope

- Converting Razor views (`130`).
- Umbraco versions below 15.
