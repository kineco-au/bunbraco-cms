# 105 — Start a site from a file

**Epic:** K — Moving content · **Priority:** should · **Size:** L
**Depends on:** 104, 106

## Story

As a developer, I want to start a working site from a whole-site file in
one command, or replace a site I already have with one, so that a site moved
from somewhere else is running in minutes, not rebuilt by hand.

## Context

`104` writes a site into one file. Today it can only go into a site that
already exists, through `content import`, and that imports content rather
than replacing a site. Two things are missing:
- **starting a new site from the file:** an empty folder in, a working site
  out, on SQLite by default, so nothing needs installing;
- **replacing an existing site with the file:** the other direction, for
  sending local work back.

## Acceptance criteria

- [ ] `crombolo start --from <file> [--postgres]` in an empty folder:
      - scaffolds the site as `crombolo init` does;
      - applies the file's schema, components, styles, scripts and
        dictionary;
      - imports its content and media;
      - starts the site.

      A typical site is ready to browse in under five minutes, on SQLite
      unless told otherwise.
- [ ] A file without back-office users starts with one fresh local
      administrator, whose sign-in is printed once. A file that carries
      them, sealed, asks for its passphrase.
- [ ] `crombolo import --site <file>` replaces an existing site's schema,
      code, content and media with the file's:
      - it runs `content check`'s dry run first and says what will be
        replaced;
      - it refuses without `--replace` or `--replace-all`;
      - it never removes the site's domains, its secret key, or settings that
        belong to where it runs.
- [ ] **`--replace`** (decided 2026-10-16) keeps the site's people: users
      and members are untouched unless the file carries them.
      - Content and media not in the file go to the recycle bin, so a
        revert brings them back.
      - Code, schema and dictionary files not in the file are removed, with
        copies kept for the revert.
- [ ] **`--replace-all`** makes the site exactly the file's:
      - content, media, files and people not in the file are deleted, not
        recycled;
      - it asks for a typed confirmation first, unless `--yes` is given;
      - it refuses outright when the file carries no back-office
        administrator, because that would leave nobody able to sign in.
- [ ] Replacing is all or nothing. A failure part-way leaves the site as it
      was, not half-replaced, and the run is recorded with `content runs` so
      it can be reverted (`content revert`).
- [ ] Media in a file goes to whichever media store the destination uses, so
      a file from one store starts on another (filesystem, S3 or Azure).
- [ ] A test:
      - starts a site from a file;
      - changes it;
      - exports it (`104`);
      - replaces a second site with that file;
      - checks the second site now matches.

## Work package (2026-10-16, with `104` and `106`)

This is the second of three tracks; `104` holds the format they share, and
`106` lands first. The plan:

**Decisions:**
- **Stage, then swap: all or nothing.** Today only the content part of an
  import is atomic; code files, schema and dictionary are applied before it,
  outside it. The import becomes three phases.
  1. **Stage and check.** Every section is written to a staging directory.
     The schema change is planned against it, and the content rehearsed, as
     `content check` does.
  2. **One database transaction:** the schema sync, the dictionary, the
     content, and the recycling or deleting of what is not in the file. This
     needs a variant of `syncSchemaDirectory` that runs inside a caller's
     transaction.
  3. **Swap the code folders** by renaming, after the transaction commits.
     The old folders are kept under the run, for its revert.

  Media blobs are placed before phase 2, under their own keys, so a failure
  leaves only unused blobs, which the run cleans up. Ordinary
  `content import` uses the same three phases, so it stops leaving files and
  schema changed behind a refused import.
- **Revert undoes all of it:** the content as today, plus the code folders
  swapped back, the schema re-synced, the dictionary restored, and recycled
  items brought back.
- **`start --from` prints the new administrator's password once,** when it
  creates the site. An ordinary development `start` keeps resetting and
  printing it, as today, so nothing changes for existing sites.

**This track builds:**
1. the transaction-aware schema sync;
2. the three-phase import, under `content import` first and covered by the
   existing tests;
3. revert extended to the sections;
4. `--replace` and `--replace-all`, with the prune step and the
   administrator guard;
5. `crombolo start --from <file> [--postgres]`, on `ScaffoldOptions.bundle`
   and `installBundleContent`;
6. its tests against `104`'s fixture, then the round trip with `104`.

## Out of scope

- Connecting two running sites. The file is the interface, as everywhere in
  content transfer.
