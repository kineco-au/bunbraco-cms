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

- [ ] `crombolo media import <dir> [--under <media path|uuid>]` creates a media
      folder for each directory and a media item for each file, typed by
      extension (Image, File, Video and so on, per the site's media types)
- [ ] Re-running it skips files already imported at the same path and hash, so
      an interrupted import can be resumed
- [ ] `--dry-run` reports what would be created, and which files no media type
      accepts
- [ ] The import streams files, so its memory use does not grow with the size
      of the folder, and it reports progress on stderr
- [ ] `crombolo media export <media path|uuid> --out <dir>` writes the files back
      out as a folder tree
- [ ] One audit entry per run, not one per file
- [ ] Tests, including resuming after a failure partway through
