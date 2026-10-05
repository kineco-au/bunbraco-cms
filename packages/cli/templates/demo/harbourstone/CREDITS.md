# Harbourstone demo template — image credits

The Harbourstone template ships in `@bunbraco/cli` (its `files` array includes
`templates`), so every binary here is **redistributed** to anyone who runs
`bunbraco init --template demo/harbourstone`. Each one therefore needs a recorded
source and licence, and `tests/packaging.test.ts` asserts that none is missing
from this file.

| File | Source | Licence | Attribution |
| --- | --- | --- | --- |
| `bundle/blobs/180cc8ef/distillery-from-the-cliff-path.jpg` | Generated with Grok (xAI), 5 October 2026 | No third-party rights | — |
| `bundle/blobs/7b4713f8/copper-pot-stills.jpg` | Generated with Grok (xAI), 5 October 2026 | No third-party rights | — |
| `bundle/blobs/fd337567/casks-in-the-sea-facing-warehouse.jpg` | Generated with Grok (xAI), 5 October 2026 | No third-party rights | — |
| `bundle/blobs/6d8d6398/bottle-the-cove.jpg` | Generated with Grok (xAI), 5 October 2026 | No third-party rights | — |
| `bundle/blobs/68c9cfdf/bottle-brine-and-kiln.jpg` | Generated with Grok (xAI), 5 October 2026 | No third-party rights | — |
| `bundle/blobs/6be45535/bottle-oloroso-pier.jpg` | Generated with Grok (xAI), 5 October 2026 | No third-party rights | — |
| `bundle/blobs/c114b7d8/bottle-neap-tide.jpg` | Generated with Grok (xAI), 5 October 2026 | No third-party rights | — |

These are synthetic images of a distillery that does not exist. They depict no
real place, product or person, and no photographer's work is being
redistributed — which is the question this file exists to answer.

## Where the originals live

`assets/templates/harbourstone/` in this repository, at the size they ship at.
That directory is **not** in the `files` list in `packages/cli/package.json`, so
the photographs are published once, in the bundle, rather than twice.
`bun run build:template demo/harbourstone` copies the bytes through untouched:
re-encoding an already-compressed JPEG on every build would churn the committed
bundle and lose a little more of the image each time.

## Adding one

Add a row. The test fails otherwise, which is the point: this is the kind of
thing that is only ever noticed years later. Three ways to fill one in:

1. **A stock source** (Unsplash, Pexels and the like) — record the URL, the
   licence and the photographer, and satisfy any attribution the licence asks
   for.
2. **Generated** — record the tool and the date; nothing further is needed.
3. **Origin unknown** — replace the image rather than ship it.
