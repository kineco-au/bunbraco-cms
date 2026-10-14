# 024 — Content editing completion

**Epic:** C — The backoffice, end to end · **Priority:** must · **Size:** L
**Depends on:** 020

## Story

As an editor, I want every action in a page's menu to work: move, copy, sort,
the recycle bin, publish with descendants, scheduling, preview, hostnames and
blueprints. That way I can run a real site from the backoffice and not just
create pages in it.

## Context

Epic framing and shared decisions are in 020. That story made a page
creatable; this one makes everything else in the document's action menu
work.

It also brings in the first **background jobs**: scheduled publishing, and
the version-cleanup job designed in 011. Version cleanup respects pinned
events. Because values are append-only
([`../../data-model.md`](../../data-model.md)), cleanup cannot simply delete
rows a kept version still reads.

## Acceptance criteria

- [x] Move, copy and sort.
- [x] The recycle bin: restore, delete, empty and original parent.
- [x] Publish with descendants, with the task-result poll.
- [x] Scheduled publishing and the version-cleanup job, which respects pinned
      events.
- [x] Preview:
  - the `preview` cookie
  - draft rendering for a signed-in editor
  - `GetDocumentByIdPreviewUrl`
- [x] The Info panel's audit log and notifications.
- [x] Domains and hostnames with culture routing.
- [x] Blueprints.
- [x] **Exit.** The Phase 4 page journey (005), plus every action in the
      document's action menu, works in the real backoffice.
- [ ] Referenced-by in the Info panel. It arrived with 041.
- [ ] Public access. It landed with 030, once there were members and member
      groups for its rules to name.
- [ ] A page's redirects. The list answers empty until the URL tracker
      exists, which is 042.

## As built

- **Move, copy, sort.**
  - Move re-parents a branch and refuses a target below itself.
  - Copy takes the current draft, unpublished, with or without its branch.
    The copy gets a free name among its new siblings (`Home (1)`).
  - Sort takes an explicit order, or re-sorts every child by name or date.
- **Recycle bin.** Restore returns a branch, unpublished, to where it was
  trashed from or to a chosen target. Deleting from the bin and emptying the
  bin remove branches for good.
- **Publish with descendants** runs inline: its task is complete when it is
  first reported. It publishes the node, then its already-published
  descendants, or all of them when asked, shallowest first. A descendant that
  cannot publish is reported and its branch skipped.
- **Scheduled publishing** (migration 010, `content_schedule`).
  - A future publish time schedules the publish instead of doing it, and an
    unpublish time schedules the expiry. The variant reports both dates.
  - A job runs every minute. Each schedule is claimed with
    `DELETE … RETURNING`, so it runs once even on several nodes.
- **Version cleanup** runs hourly when `CROMBOLO_VERSION_CLEANUP=true`. It is
  off by default, as in Umbraco.
  - It keeps the current draft, the published version, pinned versions, and
    everything newer than keep-all days. Beyond that it keeps each day's
    latest version for keep-latest days. A content type's own policy wins.
  - Values are append-only. A pruned version's value row that a kept version
    still reads is re-pointed at the earliest kept version after it, rather
    than deleted, so every kept version reads exactly what it did before.
- **Preview.**
  - Asking for the preview URL sets `UMB_PREVIEW` and returns Umbraco's
    `preview?id=…`, which the backoffice's own preview app opens.
  - The preview frames `/<document key>`. With the cookie and a signed-in
    editor, the front end renders drafts, for routed URLs too.
  - `/umbraco/PreviewHub` tells an open preview to refresh when its document
    changes, and `DELETE /preview` leaves preview.
- **Culture and hostnames** (`domain`).
  - A hostname, with an optional path prefix, roots the site at its document
    in its culture. The longest match wins, and other hosts route without
    domains.
  - A page under a hostname reports a protocol-relative URL
    (`//example.com/about`).
  - Names are unique site-wide (409), and cultures must exist (400).
- **Notifications** (`user_notification`). Each user's subscriptions to
  Umbraco's eleven actions are kept per page. Senders exist now, but nothing
  delivers these yet: that is the open half of 045.
- **Blueprints.**
  - Create, edit, delete and move, with folders, the tree and items.
  - "Create Document Blueprint" from a page.
  - The create dialog lists a type's blueprints, and a new page starts from
    the chosen blueprint's scaffold.
  - Blueprints are stored as documents of their own object type (the
    repository takes a kind), and are never published or routed.
- **The Info tab.**
  - The audit log is built from the page's versions, which record who made
    them, with user names.
  - A past version can be read as it stood: the rollback preview.
  - Item ancestors work for documents, types, data types and templates.
- **Server events for every change** (see
  [`../../backoffice-hosting.md`](../../backoffice-hosting.md)), which the
  client's entity cache depends on.
- **Tests.**
  - `tests/content-editing.test.ts` pins it on both dialects.
  - In the real backoffice, `tests/browser/document-actions.browser.ts` does
    every action in a page's menu through its dialog, plus save, preview and
    publish with descendants from the workspace.
