# 022 — Property editors that need the server

**Epic:** C — The backoffice, end to end · **Priority:** must · **Size:** L
**Depends on:** 021

## Story

As an editor, I want every built-in property editor, including uploads,
pickers, blocks and tags, to save and come back unchanged. As a site
developer, I want those values to reach my template as typed content rather
than raw JSON. Together, a page built from any editor round-trips and renders.

## Context

The third and last package of the create-type → publish-page journey (epic
framing in 020). Several of Umbraco's editors only work with server support:

- Upload and Image Cropper need temporary files.
- Block List, Block Grid, Multi-URL Picker and Content Picker need value
  converters, so that `model.value()` returns typed content rather than JSON.
- Tags needs `GetTag`.
- The rich text editor needs the `oembed` proxy.

`crombolo generate` has to type the block values too, so a template author
gets the element types a block editor allows.

## Acceptance criteria

- [x] Temporary files (`temporary-file`, 5 operations) back the Upload and
      Image Cropper editors, with a file store under the site (`media/`)
      served on the front end.
- [x] Value converters and a rendering model for Block List, Block Grid,
      Multi-URL Picker and Content Picker: `model.value()` returns typed
      content, not JSON.
- [x] Tags (`GetTag`) and the rich text editor's `oembed` proxy answer.
- [x] `crombolo generate` types the block values.
- [x] **Exit.** A page using every built-in editor round-trips through the
      editor and renders, and an uploaded file is served at its URL.

## As built

**Uploads**

- A file goes up as a temporary file (`MediaFileStore`), which is kept for a
  day and swept hourly.
- Saving a value that names a temporary file runs it through the repository's
  *value intake*: the file is placed at `media/<8 hex>/<safe name>`, and the
  value stores that path, served at `/media/…`.
- An upload that has expired is refused with a 400, never silently dropped.
- Upload values are stored as the path, as Umbraco stores them, and edited as
  `{ src }`. The cropper keeps `{ src, crops, focalPoint }`.

**Every built-in data type**

- The seed matches Umbraco 18's installer exactly: 37 data types, key for key,
  with their configuration. That covers labels of each kind, checkbox and
  radio lists, dropdowns, colour, date/time with zone, the member picker, the
  multi URL picker, four media pickers and list views.
- Existing databases gain any missing data types at boot.
- True/false reads back as a boolean, and dates as the wall-clock time the
  picker sent, not shifted by the server's time zone.

**Values as templates receive them** (`@crombolo/render`):

| Editor | What the template gets |
| --- | --- |
| Content picker | the page |
| Tree picker | the pages |
| Multi URL picker | links with resolved URLs |
| Block list and block grid | their elements (`PublishedElement`, with the same `value()`) |
| Media picker | media with crops, one or many as its data type says |
| Image cropper | an `ImageCropperValue` |
| Rich text | the text, with `{localLink:…}` links resolved |

A reference to something unpublished or deleted is dropped.

**Tags** are read from the current values of Tags properties, grouped by the
data type's configuration, with stable ids. They have no table of their own.

**oEmbed** asks each of Umbraco's providers for JSON. A photo becomes an
`<img>`.

**`crombolo generate`** types pickers, links and blocks, down to the element
types a block editor allows (`TypedElement<Feature>`). It imports only the
value types it uses.

**Tests**

- `tests/uploads.test.ts`, `tests/value-converters.test.ts` and
  `tests/editor-services.test.ts`.
- `tests/every-editor.test.ts`: every built-in editor's value is sent as the
  editor sends it, read back unchanged, re-saved without creating a new
  version, and rendered.
- In the real backoffice, `tests/browser/media.browser.ts`: every property
  editor on one page renders, and an upload saves as a served file.

## Out of scope

- The media library itself, imaging and crops: 023.
