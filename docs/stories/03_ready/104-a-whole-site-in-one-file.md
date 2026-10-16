# 104 — A whole site in one file

**Epic:** K — Moving content · **Priority:** should · **Size:** M
**Depends on:** 106

## Story

As a developer, I want to export everything that makes up a site into one
file, so that I can move the site to another machine or another host and
have it run there exactly as it runs here.

## Context

A bundle can already carry each part of a site ([`../../bundles.md`](../../bundles.md)),
but nothing writes them all at once:
- `content export` writes content (`nodes/`, `values/`, `blobs/`, `people/`)
  and never type definitions;
- schema, components, styles and scripts get into a bundle only through the
  backoffice's Packages builder.

So moving a whole site means assembling it by hand.

A transfer produces a file, and that rule stays
([`../../content-transfer.md`](../../content-transfer.md)): this story makes
the file complete, not a connection between two sites.

## Acceptance criteria

- [ ] `crombolo export --site [--out <file>]` writes one bundle holding:
      - the schema;
      - components, styles and scripts;
      - the dictionary;
      - every content node with its values;
      - the media, with their blobs.

      It does this from either database dialect and any media store.
      Domains are left out: they belong to where a site runs, and never
      travel (decided 2026-10-16, keeping `content-transfer.md`'s rule).
- [ ] People are left out by default: members, back-office users, tokens,
      sessions and external logins. `--with-members` and `--with-users` carry
      them, sealed, as `content export` does today. `--anonymise` carries the
      structure with every personal value replaced, using `100`'s sanitising.
- [ ] Media can be left out (`--no-media`), for a quick copy of the code and
      content alone. The bundle then says so, and importing it without the
      media is a decision rather than a surprise.
- [ ] The bundle records the CMS version that wrote it and the package
      versions it needs, so importing it on an older CMS refuses with the
      version named (`070`'s compatibility rules).
- [ ] The export streams. A site with gigabytes of media is written without
      holding it in memory, and the integrity hash covers every part.
- [ ] A test round-trips a site:
      - export it;
      - start it elsewhere (`105`);
      - export it again;
      - compare the two bundles, which match except for timestamps.

## Work package (2026-10-16, with `105` and `106`)

Planned and built as one work package, in three tracks that run side by
side. The order between them is fixed by one thing agreed first: the shape of
a whole-site file.

**Day zero: the format, shared by both tracks.** A whole-site file is the
existing bundle (an npm package, `.tgz`, format 2 or 3) with every section,
plus three new manifest fields:
- `scope: 'site'`, so `105` knows to replace rather than overlay;
- `media: 'omitted'` when `--no-media` was given;
- `provenance.cmsVersion`, and `requires`: the versions of the server bundles
  the site wires.

The fields are written into `transfer/src/model.ts` and `docs/bundles.md`
before either track starts, with a fixture file that both test against.

**Decisions:**
- **People are left out by default.** `--with-members` and `--with-users`
  seal them, as today. **`--anonymise` is built here:** the sanitiser
  that story `100` names is `transfer/src/sanitise.ts`, and `100` reuses
  it. It
  replaces or removes:
  - users bar one local administrator;
  - members;
  - tokens and sessions;
  - external logins;
  - form values marked sensitive;
  - every email address.

  It runs before anything is written, so an unsanitised copy never exists in
  the output.
- **It streams.**
  - **Archive:** a streaming tar and gzip writer replaces the in-memory
    `tar.ts` for this path.
  - **Integrity:** the hash is computed as files pass.
  - **Media:** `MediaStore` gains an optional `stream(key)`, implemented by
    the file system, S3 and Azure stores, with `bytes()` as the fallback.
- **The sections come from one place.** The back office's Packages builder
  already composes schema, components, styles, scripts and the dictionary,
  but for picked items. That composition moves into a shared `siteSections()`
  with a select-everything mode, which the builder and `export --site` both
  call.

**This track builds:**
1. the format fields and fixture (day zero);
2. `siteSections()`;
3. the sanitiser;
4. the streaming writer and integrity;
5. `crombolo export --site [--out] [--no-media] [--with-members]
   [--with-users] [--anonymise]`;
6. the round-trip test, once `105`'s `start --from` lands.

## Out of scope

- Moving a site somewhere it is already running, with changes on both sides.
  That is merging, and `content import`'s conflict resolutions (`101`–`103`)
  cover the parts that can be merged.
