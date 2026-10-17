# 153 — Media in bulk

**Epic:** P — The command line · **Priority:** should · **Size:** M
**Depends on:** —

## Story

As a developer moving a site to crombolo, or loading a photographer's delivery,
I want to import a folder of files into the media library in one command,
keeping its folder structure, so that I do not have to drag thousands of files
into a browser.

## Context

The Management API's `media` and `temporary-file` areas upload one file at a
time, as the back office does. `crombolo import umbraco apply` brings media
across from an Umbraco site, and `media fetch` brings a remote's media files
(story 108). Neither loads an ordinary folder of files.

## Acceptance criteria

- [x] `crombolo media import <dir> [--under <media path|uuid>]` creates a media
      folder for each directory and a media item for each file, typed by
      extension (Image, File, Video and so on, per the site's media types)
- [x] Re-running it skips files already imported at the same path and hash, so
      an interrupted import can be resumed
- [x] `--dry-run` reports what would be created, and which files no media type
      accepts
- [x] The import streams files, so its memory use does not grow with the size
      of the folder, and it reports progress on stderr
- [x] `crombolo media export <media path|uuid> --out <dir>` writes the files back
      out as a folder tree
- [x] One audit entry per run, not one per file
- [x] Tests, including resuming after a failure partway through

## What was built

- `crombolo media import <dir> [--under] [--dry-run]` and `crombolo media export
  [<folder>] --out <dir>`, over `support/media-tree.ts`.
- An imported file takes the upload path: saved as a temporary file, then
  created with `umbracoFile` pointing at it, so `createFileIntake` places it and
  fills its size and dimensions exactly as the back office does. The type is the
  media port's `typesForExtension`, the rule the upload dialog uses; folders are
  its `folderTypes`.
- Items are created through the repository, not the port, which would write a
  cache instruction per item; the run writes one at the end.
- **Resuming:** a file whose name is already under its folder is compared by
  SHA-256 with the stored file: the same is skipped, a different one is reported
  and left. Files are read one at a time, so memory does not grow with the
  folder.
- **Tests:** `tests/cli-operations.test.ts` § media in bulk: the dry run, the
  import, a second run that skips everything, a changed file reported, and an
  export with the same bytes in the same folders.
