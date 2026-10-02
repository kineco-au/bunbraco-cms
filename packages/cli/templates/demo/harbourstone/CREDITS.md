# Harbourstone demo template — image credits

The Harbourstone template ships in `@bunbraco/cli` (its `files` array includes
`templates`), so every binary here is **redistributed** to anyone who runs
`bunbraco init --template demo`. Each one therefore needs a recorded source and
licence, and `tests/packaging.test.ts` asserts that none is missing from this file.

| File | Source | Licence | Attribution |
| --- | --- | --- | --- |
| `bundle/blobs/2462ad2e/harbour-at-dawn.jpg` | **UNRESOLVED** | **UNRESOLVED** | — |
| `bundle/blobs/6a26db3b/bottle-harbour-cask.jpg` | **UNRESOLVED** | **UNRESOLVED** | — |
| `bundle/blobs/913c89e8/bottle-peated.jpg` | **UNRESOLVED** | **UNRESOLVED** | — |
| `bundle/blobs/a386a383/warehouse.jpg` | **UNRESOLVED** | **UNRESOLVED** | — |
| `bundle/blobs/ce973ab0/bottle-12.jpg` | **UNRESOLVED** | **UNRESOLVED** | — |

## These five are not cleared for release

Their origin is not recorded anywhere in this repository and could not be
established from it. Until each row above names a source and a licence, publishing
`@bunbraco/cli` redistributes images we cannot show we have the right to
redistribute.

Three ways to resolve a row:

1. **A stock source** (Unsplash, Pexels and the like) — record the URL, the
   licence and the photographer, and satisfy any attribution the licence asks for.
2. **Generated** — record the tool and the date; nothing further is needed.
3. **Origin unknown** — replace the image. `bun run build:template` regenerates a
   template's bundle and its images, so a replacement is mechanical.

Adding a new image means adding a row. The test will fail otherwise, which is the
point: this is the kind of thing that is only ever noticed years later.
