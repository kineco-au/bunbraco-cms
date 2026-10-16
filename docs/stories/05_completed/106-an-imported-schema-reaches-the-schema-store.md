# 106 — An imported schema reaches the schema store

**Epic:** K — Moving content · **Priority:** must · **Size:** S
**Depends on:** —

## Story

As someone running a site with a schema store configured, I want content
types that arrive in a bundle to stay, so that importing a bundle doesn't
silently lose its types at the next restart.

## Context

A bug. With a schema store configured, the schema directory is the store's
local copy:
- it is materialised at boot, and `config.schemaDir` points at that copy;
- back-office edits, webhooks kept with files, and form changes all call
  `publishSchema`, so the store stays the source of truth.

`content import` (through `applySections`) is the exception:
- **It writes schema files without publishing them.** It writes into
  `config.schemaDir` and syncs the database, but never publishes to the
  store, so the next boot materialises the store's older copy over the
  imported types.
- **It reads a schema it never fetched** when it runs outside the server.
  The CLI's `content import` and `content check` never materialise the
  store, so `schemaDir` is whatever local directory there is, often empty,
  and the import diffs against nothing.

The effect: types from an imported bundle are lost at the next restart, or
are read as removed and refused.

## Acceptance criteria

- [x] `content import` publishes every schema change it applies to the
      schema store, as a back-office edit does.
- [x] Every way of running an import materialises the schema store before
      it reads the schema: the server, and the CLI's `content import` and
      `content check`.
- [x] A test, with a schema store configured:
      - imports a bundle carrying a new content type;
      - restarts the site against the same store;
      - finds the type there.
- [x] A second test runs the CLI's `content import` with a store configured
      and an empty local directory, and checks that the diff is against the
      store's schema.
- [x] **Schema proposals** (`adapters/schema-proposals.ts`), which also write
      into the schema directory without publishing, publish as an edit does.
      Their write is not lost to the next materialise either: `importSchema`
      re-materialises the store over the directory the proposal just wrote.

## Work package (2026-10-16, with `104` and `105`)

The first of three tracks, and small. It lands before the other two merge,
because both write schema through `applySections`.

**Where the fix goes:**
- `bundle-sections.ts`' `applySections`, which already holds
  `config.schemaStore`, publishes after it syncs;
- `operations/commands.ts`' `contentImport` and `contentCheck` materialise
  first when a store is configured;
- schema proposals publish, and their write survives `importSchema`'s
  re-materialise.

**Tests:** `tests/schema-store.test.ts`' restart pattern (a second server on
the same store) for the import, and a CLI case with an empty local directory.

## Out of scope

- Moving schema-store behaviour out of the CMS. The store is the CMS's, and
  so is this fix.

## Implementation (2026-10-16)

- **`useSchemaStore(config)`** (`schema-store.ts`): materialises the store into
  `schemaCacheDir` and points `schemaDir` at it. It is a no-op without a store,
  and the boot path, `importSchema`, and the CLI's `content import` and
  `content check` all use it.
- **`applySections`** publishes to the store after a sync that applied, or
  found the database already matching (`skipped-same`).
- **Schema proposals** materialise first, then write. They import with
  `importSchema(…, { materialise: false })` and publish after a successful
  import.
- **Docs:** `docs/schema-at-runtime.md`.
- **Tests:**
  - `tests/schema-store-import.test.ts`:
    - an import with a store survives a restart on a fresh cache;
    - the CLI's check reads the store, not an empty local directory, and its
      import publishes.
  - `tests/assistant-schema.test.ts`: an approved proposal reaches the store.
