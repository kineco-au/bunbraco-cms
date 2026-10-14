# 013 — Pending elements at runtime

**Epic:** B — Packaging and upgrades · **Priority:** must · **Size:** M
**Depends on:** 012

## Story

As an editor, I want a field that a coming release introduces to be visible
and fillable in the running backoffice before that release goes live, without
affecting validation or the live site, so that content is ready on the day of
the deploy.

## Context

An element is **pending** on a node in either of two cases:

- the state that created it (`since_state_id`) is newer than the node's
  `(version, revision)`
- its file says `since` a version newer than the node's

The sync stores the file's `since` as `since_version` on the row, so the rule
is one comparison in one place: `isPending(row, nodeState)` in
`@crombolo/data`.

The aim is no client change. The editor Umbraco ships has to show, explain and
accept a pending field as it stands.

## Acceptance criteria

- [x] `ContentTypeRepository` takes `nodeState`, as `DocumentRepository` does,
      and marks each property and type `pending: { version, revision } | null`.
- [x] **Editor.** The document-type and document endpoints append
      ` (goes live in 2.1)` to a pending property's name and prepend the same
      to its description, so the field is visible, editable and explained.
      Pending *types* are left out of `allowedAtRoot` and `allowedChildren`,
      which is the create menu.
- [x] **Validation.** Document save and publish validation skips `mandatory`
      and regex for pending properties.
- [x] **Rendering.** `createPublishedContentSource` drops pending properties
      from the published model, so a template on the old version cannot render
      a half-filled field.
- [x] **Prepared states.** `syncSchema` gains
      `status: 'prepared' | 'current'`. `check --fix` (014) syncs under
      `prepared`, so everything it creates is pending on every live node and
      nothing gates writes until `upgrade` cuts over.

## As built

Pinned by `tests/pending.test.ts`. The `since` rule is described in
[`../../schema-as-code.md`](../../schema-as-code.md).
