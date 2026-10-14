# 023 — Media

**Epic:** C — The backoffice, end to end · **Priority:** must · **Size:** L
**Depends on:** 022

## Story

As an editor, I want to upload an image to the Media section, pick it on a
page and have the page render a resized crop of it. As a site developer, I
want to keep the media library on disk, S3 or Azure, so that the media works
the way Umbraco's does wherever the site is hosted.

## Context

Epic framing and shared decisions are in 020. The epic-wide decision that
media types are files applies here: `schema/media-types/*.toml` uses the same
parser vocabulary, sync and promotion as content types
([`../../schema-as-code.md`](../../schema-as-code.md)).

**Media types went first.** Saving a media type in the backoffice hit
`PostMediaType`, and a write cannot honestly be stubbed, so the Settings half
landed before the media library itself.

**Built-in media types.** Umbraco ships seven, and they are shipped here key
for key from its installer, split by decision:

- Folder, Image and File are **system types**: shipped, ensured at every
  boot, not deletable, with fixed aliases. A file may override one only by
  its key.
- Video, Audio, Article and Vector Graphics are **site files**, which
  `crombolo init` scaffolds and a site may delete.

**The storage seam came afterwards**, so a site can move its media library off
the local disk. Umbraco abstracts storage as `IFileSystem`, with a
`MediaFileManager` over it. Ours is narrower: `MediaStore` has `get`, `put`,
`delete`, `list` and an optional `publicUrl`. That is everything the media
library, the image processor and the temporary-upload flow use.

## Acceptance criteria

- [x] Media types as files under `[media-type]`, synced, exported and written
      back, folders included. The built-in types are seeded.
- [x] The media tree, items, CRUD, the collection view and search.
- [x] A temporary file becomes a media item.
- [x] `GetImagingResizeUrls`, with an on-disk resize cache, crops and focal
      point.
- [x] The Media Picker works in documents, images work in the rich text
      editor, and `model.media()` works in views.
- [x] **Exit.** Upload an image in Media, pick it on a page, publish, and the
      page renders a resized crop.
- [x] The media library can live in S3 or Azure Blob Storage as well as on
      the file system.
- [ ] Media type import and export (`…/export`, `…/import`). Deferred, with
      package import among the could-haves in
      [`../../features.md`](../../features.md).

## As built

### Media types

- **Shared storage.** Media types share `content_type` with content types,
  told apart by node object type, in one alias space.
  `ContentTypeRepository` and the type handlers take a kind.
- **Same vocabulary.** The schema package reads and writes
  `schema/media-types/*.toml` under `[media-type]`: the content-type
  vocabulary without templates or cleanup. It is synced, exported and written
  back, folders included.
- **API shape.** It differs from content types only where the contract does:
  references keyed `mediaType`, `allowedMediaTypes`, `isDeletable`, and a
  smaller configuration.
- **Built-in timing.** The system types are ensured both before the sync, so
  files may reference them, and after it, so Folder allows whichever built-ins
  the site has.
- **Supporting data types.** The built-ins' seven supporting data types are
  built-ins too: pixel and byte labels, four upload variants and the media
  list view. They are ensured in older databases at boot.
- **Groups without a tab.** Umbraco's media types use a group with no tab, so
  the vocabulary gained a top-level `[[group]]`. Export no longer folds such
  groups into an invented "Content" tab.
- **Scaffolding.** `apps/site` now has the scaffolded site types.
- Pinned by `tests/media-types.test.ts` and
  `tests/built-in-media-types.test.ts`.

### Found in the walk-through

The Content section's create button spun forever. The dialog waits on the
upload settings (`GetTemporaryFileConfiguration`), which answered 501. It now
reports Umbraco's defaults from `DEFAULT_UPLOAD_SETTINGS` in `@crombolo/core`:
image types, the executable-extension blocklist, an empty allow-list and no
size limit. These are the same lists the upload endpoints in 022 enforce.

### Media items

- **Storage.** Media items are stored as documents of the media object type
  (the repository's `kind`) and are never published.
- **Operations.** Create, edit and validate; the tree, items, ancestors and
  search; the collection view (filter, order, creator); sort and move; the
  recycle bin (restore, delete, empty, original parent); and the audit log.
- **Collections.** Each type reports its collection, so Folder opens in the
  media list view.
- **Files follow items.** Deleting an item for good deletes its file, and
  replacing a file deletes the old one.
- **Uploads become media** through the same intake as 022. It fills an
  Image's width, height, size and extension from the file, as Umbraco's
  `AutoFillImageProperties` does.
- **The dropzone's lookups** answer as Umbraco's do: which media type an
  extension becomes (`item/media-type/allowed`, with `matchedFileExtension`)
  and which types are folders.

### Imaging

- **URL vocabulary.** `/media/…` understands the query Umbraco's ImageSharp
  URL generator writes: `width`, `height`, `rmode` (crop, max, stretch, pad,
  boxpad, min), `rxy`, `cc`, `format` and `quality`.
- **Cache.** Each variant is cached under `media/.cache`.
- **No new dependency.** Bun decodes, resizes and encodes, but it cannot crop
  or pad. Those go through a small PNG codec on raw RGBA (`imaging.ts`).
- **Thumbnails.** `GetImagingResizeUrls` answers in the same vocabulary.

### In pages

- **Media Picker.** It resolves to `MediaWithCrops`, with `url` and
  `cropUrl('alias')` or `cropUrl({ width, height })` around the focal point.
- **`model.media(alias)`** lists whatever the picker allows.
- **Crops.** The cropper's named crops are cut by their stored coordinates.
- **Rich text.** Images and media links render.
- **Trashed media.** The published cache knows media, so a trashed item drops
  out of the pages that picked it.

### The storage seam

Three stores ship:

- the file system, the default, unchanged on disk
- **S3** through Bun's own client, so there is no dependency and any
  S3-compatible service works
- **Azure Blob Storage** through the REST API with Shared Key or SAS auth,
  rather than pulling in `@azure/storage-blob` for four verbs

A site picks one in `crombolo.config.ts` with `fileSystemMediaStore`,
`s3MediaStore` or `azureMediaStore`, or leaves it to `CROMBOLO_MEDIA_STORE`,
which is what a container deployment wants.

Three consequences follow from the interface rather than from any one store,
and each improves on what was there before:

- **Image variants are cached in the store**, under `.cache/`, keyed by the
  source's etag. Replacing an original invalidates its crops with nothing
  tracking that, and one node's work serves every node. Previously the cache
  was local and keyed by mtime.
- **Temporary uploads go to the store**, under `.temp/`, so a load-balanced
  set can place an upload that a different node received. Previously an
  upload was stranded on the node that took it.
- **Serving streams the bytes by default.** When the store has a local file
  it is served from there, so a disk-backed site keeps `sendfile`. A store
  that returns a `publicUrl` gets browsers redirected to a CDN or a presigned
  URL instead.

### Tests

- `tests/media.test.ts`, `tests/imaging.test.ts` (crops and focal points
  checked pixel by pixel) and `tests/media-rendering.test.ts`.
- `tests/media-store.test.ts` drives the whole media library against a store
  backed by a `Map`, with no file system behind it: upload, place, serve,
  crop, redirect and delete. That proves the seam is real rather than shaped
  around the disk.
- In the real backoffice, `tests/browser/media.browser.ts` drops an image in
  Media, picks it on a page, inserts it into the page's rich text, publishes,
  and gets its 40×40 crop served.
