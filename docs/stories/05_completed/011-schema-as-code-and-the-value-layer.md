# 011 — Schema as code and the value layer

**Epic:** B — Packaging and upgrades · **Priority:** must · **Size:** L
**Depends on:** 010

## Story

As a site developer, I want content types to live as files in my site's
repository and content values to be append-only, so that a schema change moves
between environments the way code does and an older node keeps serving while a
newer one moves ahead.

## Context

Two pieces, built in order.

**The append-only value model** ([`../../data-model.md`](../../data-model.md)):
`property_value` with `is_current`, events for save, publish and rollback,
`schema_state` as a history with `prepared`/`current`, publish without copying,
rollback by appending, and write gating on the current state. Two
Umbraco-visible behaviours change on purpose: every save is a recoverable
version (Umbraco versions only on publish), and rollback appends rather than
rewrites.

**Schema as code** ([`../../schema-as-code.md`](../../schema-as-code.md)):
`@crombolo/schema` holds types as TOML, and the database caches them. The sync
is version-gated, so a node with older files runs in compatibility mode rather
than fighting a newer one.

## Acceptance criteria

- [x] The 004 and 005 suites pass with every type defined in `schema/*.toml`
      and no content-type rows created through the API.
- [x] A type created in the backoffice appears as a new file.
- [x] Deleting a file whose type has content refuses to boot.
- [x] Two server instances on one Postgres database, one with newer files, end
      with the database at the newer version, the older instance in
      compatibility mode, and both caches coherent after a publish.
- [x] After `upgrade` advances the state, the older instance still serves every
      page it did before while refusing writes with 409. *The `upgrade` half
      belongs to 014; it is exercised at the repository level in
      `tests/values.test.ts`.*
- [ ] ~~Cleanup that respects pinned events.~~ **Designed, but no job runner
      existed yet.** The version-cleanup job arrived with 024.
- [ ] ~~Media and member types in files; data types and languages written by
      the backoffice.~~ Media and member types followed with 023 and 030. Data
      types and languages were file-defined but not yet written by the
      backoffice.

## As built

**The value model** is migration 003, with the document repository rewritten on
top. `tests/values.test.ts` pins it:

- an unchanged value appends nothing, and a cleared value is a version
- the published read is as-of the publish event
- a conversion appended under a newer state is invisible to a node reading
  as-of the older one
- a prepared state does not gate writes, and the cut-over does

**`@crombolo/schema`:**

- a strict parser: unknown keys are errors, and every problem is reported with
  file and path
- whole-set validation, and a canonical writer that round-trips byte for byte
- a directory loader and an order-independent hash
- `syncSchema`, the version-gated sync under `Locks.Schema`:
  - older files skip into compatibility mode
  - the same version with a different hash applies in development and refuses
    in production
  - production refuses any element without a key
  - removal retires; re-adding revives by key or by alias
  - a type removed while it has content refuses (`--force-retire-types`
    overrides)
  - every apply appends a `schema_state` row and a `cache_instruction`

**The server:**

- boots through the sync
- writes minted keys back in development, and re-hashes the state so the next
  node sees the files as applied
- watches `schema/` for changes
- gives the document-type editor a file writer that refuses with 409 when the
  directory is read-only

**The CLI:** `schema export` walks the database back into canonical files,
including built-ins only when the site changed them. `generate` emits
`schema/content-types.d.ts`.

**Multi-node plumbing:** `server` identity, publish and sync appending
`cache_instruction`, and a poll that drops the published cache on another
node's instruction.

**Tests:**

- `tests/documents.test.ts` boots every 005 case from a TOML type.
- `tests/schema-sync.test.ts` pins the sync rules at the data layer.
- `tests/schema-boot.test.ts` covers the rest:
  - the file a backoffice save produces
  - the 409 in a read-only environment
  - the boot refusal for a removed type with content
  - (Postgres only) two servers on one database: the newer files win, the
    older node reads and renders, answers 409 to writes, and sees the other
    node's publish after one poll; restarted with its old files, it reports
    compatibility mode
