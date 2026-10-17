# 045 — E-mail delivery

**Epic:** E — Cross-cutting · **Priority:** must · **Size:** M
**Depends on:** —

## Story

As a site administrator, I want the site to send e-mail through a provider I
configure, so that invitations, password resets, form notifications and
content notifications actually reach people.

## Context

The roadmap's ranking listed e-mail first, as "no sender; only the
`sendUserLink` seam". **That is out of date.** Checked against the code on
2026-10-14, most of this has shipped.

- **The port.** `packages/server/src/email.ts` defines an `EmailPort`, with
  plain-`fetch` adapters for Resend, Postmark, SES (signature version 4) and a
  custom HTTP endpoint, plus a log adapter. All are exported from
  `@crombolo/crombolo` (`resendEmail`, `postmarkEmail`, `sesEmail`,
  `customEmail`, `logEmail`).
  - It is configured as `email` in `crombolo.config.ts` or
    `CROMBOLO_EMAIL_PROVIDER`.
  - There is no SMTP, by decision: outbound 25/587 is blocked on most container
    hosts.
  - `send` never throws.
- **What uses it.**
  - User invitations and password resets go through the port.
  - With no provider, they become *unavailable* rather than failing: invite
    answers `CannotInvite` with a message naming what to configure.
  - The Forms "Send email" workflow uses it too
    ([`forms.md`](../../forms.md)).
  - Pinned by `tests/email.test.ts`: adapters, availability, environment, boot
    notice, and what a site with and without e-mail does.
- **Not yet built.** The eleven content notification subscriptions are stored
  and never delivered. `packages/data/src/repositories/notifications.ts` still
  says sending them "needs e-mail, which the site does not have yet".

## Acceptance criteria

- [x] An e-mail port with HTTPS provider adapters, configured in the config file
      or the environment.
- [x] Invitations and password resets are sent through it, and are unavailable,
      with a reason a person can read, when no provider is configured.
- [x] The Forms "Send email" workflow sends through it.
- [x] Content notification subscriptions are delivered: an action on a node
      (publish, delete, move and the rest of the eleven) e-mails the users
      subscribed to it, from a background job, once per cluster.
- [x] With no provider, the notifications option is shown as unavailable rather
      than silently stored.

## The eleven actions

Umbraco's notifications dialog offers exactly these, and `user_notification`
stores them (`packages/data/src/repositories/notifications.ts`). Unpublishing
and sending for approval are not among them; "delete" means moving to the
recycle bin, as in Umbraco.

| Action | Means | Where it happens |
|---|---|---|
| `Umb.Document.Create` | a new page was saved; notified to subscribers above it | `PostDocument`, `PostDocumentCreateAndPublish` |
| `Umb.Document.Update` | an existing page was saved | `PutDocumentById`, update-and-publish |
| `Umb.Document.Publish` | published, by an editor, a branch publish, the schedule or an approval | the publish operations, `jobs.ts` scheduled publishing, `approvals.ts` |
| `Umb.Document.Delete` | moved to the recycle bin | `PutDocumentByIdMoveToRecycleBin` |
| `Umb.Document.Move` | moved | the move operation |
| `Umb.Document.Duplicate` | copied; notified on the original | the copy operation |
| `Umb.Document.Sort` | its children were sorted; notified on the parent | the sort operations |
| `Umb.Document.Rollback` | rolled back | `PostDocumentVersionByIdRollback` |
| `Umb.DocumentRecycleBin.Restore` | restored from the recycle bin | the restore operation |
| `Umb.Document.PublicAccess` | its public access was added, changed or removed | `handlers/public-access.ts` |
| `Umb.Document.Permissions` | a group's permissions on it changed | a user-group save: no page operation |

## Decisions

Taken on 2026-10-17:

1. **Captured by a new hook in the API router**, beside the webhook event it
   already emits after a successful answer, plus explicit calls where a change
   does not come through the router: scheduled publishing, approvals, the CLI,
   and a user-group save that changes a page's permissions.
2. **The person who made the change is not e-mailed about it.**
3. **A short digest.** Each recipient's notifications wait 60 seconds, so a
   save and a publish arrive as one e-mail; a branch publish is one entry,
   "and 12 pages under it".
4. **With no provider, the toggles are disabled.** The crombolo plugin patches
   Umbraco's notifications dialog to show a plain-words banner and greyed-out
   toggles, and the server refuses a new subscription. Patching a vendored
   dialog is fragile across Umbraco upgrades, so a test pins the patch to the
   vendored chunk it changes and fails when a re-vendor moves it.

Taken as recommended, open to change:

5. **Recipients are worked out when the change happens** — subscriptions on the
   page or anywhere above it, as Umbraco inherits them — and checked again at
   delivery: still active, still approved, still allowed to read the page.
6. **English e-mails**, through a template function keyed by the recipient's
   language, falling back to English, so translations can follow.
7. **The development console counts as able to send**, so developers see the
   e-mails, as invitations already work.
8. **A row left `running` by a node that died is retried after 15 minutes**
   (at-least-once). Form workflows and webhooks have the same gap; they can
   take the same fix later.
9. **Existing subscriptions on a site with no e-mail stay**, dormant, and start
   delivering once e-mail is set up.

## Plan

### Data: migration 043

The release it ships in, after 0.16.0 (`AGENTS.md`, "Versioning").

- `content_notification`: one row per recipient per change — recipient,
  action, page key and name, actor key and name, a detail ("Scheduled", "and 12
  pages under it"), when, and the delivery state (`pending`, `running`, `done`,
  `failed`, `skipped`) with attempts, last error and `run_after`. No foreign
  keys, so deleting a page or a user cannot break it. Indexed on `(state,
  run_after)` and `(recipient, state)`.
- An index on `user_notification (node_id, action)`, which a lookup by page
  needs and the table lacks.
- `ContentNotificationRepository`, on the `FormWorkflowRepository` pattern:
  enqueue, due recipients, an atomic claim per recipient (`UPDATE … WHERE
  state = 'pending' AND run_after <= ? RETURNING`), succeed, skip, fail with a
  retry time, release stale `running` rows, prune. `NotificationRepository`
  gains `subscribersFor(action, pathNodeIds)`.

### Capture

- `packages/server/src/content-notifications.ts`: `enqueueContentNotifications`
  maps an API operation (and its audit description) to actions — create,
  update, publish, create-and-publish as both, trash with the page's path from
  its original parent, sort on the parent — finds the subscribers on the page's
  path, drops the actor, and writes rows due in 60 seconds. It writes nothing
  when the site cannot send, and never fails the change it follows.
- The router gains an `onNotificationEvent` hook beside `onWebhookEvent`.
  Scheduled publishing, approvals (which today write their audit directly) and
  the CLI's content commands call the same function; the user-group adapter
  compares page permissions before and after a save and enqueues `Permissions`
  for each page that changed.

### Delivery

- `createContentNotificationRunner({ db, email, siteName, backOfficeUrl })`,
  run every 15 seconds by `jobs.ts` on the nodes that run jobs (`all` and
  `api`), so once per cluster by claim. Per recipient: claim their rows, skip
  (with the reason) a user who is gone, disabled, unapproved or without access
  to the page, render one e-mail, send it; a failure retries with backoff, and
  after five attempts the rows fail with the error. An hourly prune removes
  delivered rows after 30 days.
- **The e-mail**, plain text like an invitation: subject `[Site] Ann published
  "About us"`, or "3 changes on Site" for a digest; one line per change, who
  and when, a link to edit the page in the back office, and why they get it.
  A shared `backOfficeUrl(config)` builds the link, and approvals get it too:
  their e-mails never had one.

### Unavailable

- `/crombolo/api/email` gains `canSendNotifications`, and "Notifications
  about page changes" joins the features e-mail enables.
- `PutDocumentByIdNotifications` refuses to add a subscription when the site
  cannot send — "This site can't send e-mail yet, so it can't tell you when
  pages change. Ask an administrator to set up e-mail." — and still allows
  clearing them.
- The crombolo plugin patches the vendored notifications dialog: when the site
  cannot send, a banner with the same sentence, and every toggle disabled.

### Tests

`tests/content-notifications.test.ts`, on both dialects: a publish e-mails its
subscribers with who, the page and the link; a subscription above a page covers
it, and create notifies the parent's subscribers; each of the eleven reaches a
subscriber of that action and no other; sort notifies the parent; trashing
notifies where the page was; the actor is not e-mailed; disabled, unapproved and
unauthorised users are skipped with the reason; scheduled and approval publishes
notify; one of two nodes polling sends each e-mail; a provider that is down is
retried and then failed; changes within a minute arrive as one e-mail; a stuck
row is retried; a site with no e-mail queues nothing. In `tests/email.test.ts`:
subscribing is refused with a readable reason and clearing still works; the
status says whether notifications can be sent. A test pins the dialog patch to
the vendored chunk. A browser test: with no e-mail, the dialog shows the banner
and disabled toggles.

### Docs

`docs/configuration.md` § E-mail, `docs/operations.md` (the outbox, the job,
retries), `docs/data-model.md`, `docs/features.md`, and the stale notes in
`notifications.ts`, story 024 and story 028.

## Out of scope

- SMTP.

## What was built

- **Migration 043, `AddContentNotifications`** (release 0.17.0):
  `content_notification` and an index on `user_notification (node_id, action)`.
  `ContentNotificationRepository` enqueues, claims a person's due rows in one
  `UPDATE … RETURNING`, and finishes, skips, fails, releases stale rows and
  prunes; `NotificationRepository.subscribersFor` finds who asked on any node of
  a path.
- **Capture.** `packages/api-management/src/notification-events.ts` maps fifteen
  operations to the eleven actions, pure, like the webhook table; the router
  calls `onContentChange` after a successful one, reading the body only for a
  sort by parent and a publish (a publish that only sets a schedule notifies
  nothing until the job publishes). `createContentNotifier`
  (`packages/server/src/content-notifications.ts`) finds the subscribers on the
  page's path — for a trashed page, where it was — drops the actor, and queues
  rows due in a minute; it queues nothing without e-mail and never fails the
  change. Scheduled publishing ("The schedule"), approvals, `crombolo content
  publish` ("The command line") and the user-group adapter, which compares each
  page's verbs before and after a save, raise their own.
- **Delivery.** `createContentNotificationRunner`, run every 15 seconds by
  `jobs.ts` on the nodes that run jobs, with an hourly prune. One plain-text
  e-mail per person per run, through the site's e-mail port; access is checked
  again with the same start-node and verb rules as the API.
- **Unavailable.** `/crombolo/api/email` gains `canSendNotifications`, the API
  refuses a new subscription with a readable reason, and
  `plugin/notifications-dialog.js` patches Umbraco's dialog: a banner, the
  toggles and Save disabled. `tests/content-notifications.test.ts` pins the
  vendored dialog it patches.
- **Also:** approval e-mails now carry a link to the page (`backOfficeUrl`),
  which they never had; `jobs.ts` says which nodes run jobs.
- **Tests:** `tests/content-notifications.test.ts` (the operation table, a
  publish delivered with its link and not to the actor, inheritance and create,
  a digest, trash and restore and copy, permissions, scheduled publishing, a
  disabled person skipped, two nodes sending once, retries then failure and a
  stale row, a site with no e-mail, the e-mail's wording, the dialog patch);
  `tests/email.test.ts`; a browser test in `document-actions.browser.ts` that
  opens the dialog as a site without e-mail sees it.
