# 073 — Import a WordPress site

**Epic:** H — Importing a site · **Priority:** should · **Size:** L
**Depends on:** 141, 142

## Story

As someone moving a WordPress site, I want to point crombolo at its export and
get a working site — posts, pages, media, categories, tags, authors, menus and
comments, at the addresses they had — so that moving costs a review rather
than a rebuild.

## Context

The Umbraco importer (stories `070`, `071`) is the pattern: a report first,
then a site directory whose first boot is the import through `start --bundle`,
with content and people sealed under a passphrase
([`content-transfer.md`](../../content-transfer.md)).

- **Source.** A WordPress export file (WXR), which every WordPress site can
  produce without a plugin, and optionally the database dump for what WXR
  leaves out (menus' order, some plugin data).
- **Content.** Posts and pages become documents of generated types; Gutenberg
  blocks become rich text, with unknown blocks carried as HTML and reported.
  Categories and tags map to story `142`'s taxonomies, menus to story `141`.
- **Addresses.** Every permalink keeps answering: as the page's own route where
  the shape allows, otherwise as a redirect (story `042`).
- **People.** Authors become users or members as chosen; WordPress's phpass
  hashes (`$P$`, `$H$`) and the bcrypt ones of 6.8+ need a verifier beside
  Umbraco's (`packages/auth/src/umbraco-passwords.ts`), re-hashed on sign-in.
- **Not migrated, and reported:** plugins, themes' PHP, shortcodes the importer
  does not know.

## Acceptance criteria

- [ ] `crombolo import wordpress report|apply`, with the content flags of
      `import umbraco` (`--include-content`, `--with-members`, `--with-users`).
- [ ] Posts, pages, media, categories, tags, menus and comments arrive, with
      authors and dates.
- [ ] Every published URL of the source answers 200 or redirects to its page.
- [ ] Imported people sign in with the password they had.
- [ ] The report lists plugins, shortcodes and blocks that did not come across.
- [ ] Proven on a real export with a few hundred posts.
