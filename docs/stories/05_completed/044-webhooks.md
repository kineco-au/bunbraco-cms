# 044 — Webhooks

**Epic:** E — Cross-cutting · **Priority:** should · **Size:** M
**Depends on:** —

## Story

As a developer integrating the site with other systems, I want the site to call
a URL when content is published or deleted, so that a search index, a cache or
a build pipeline can react without polling.

## Context

Checked 2026-10-14: 1 of the 8 `webhook` operations answers, and that one is
`GetWebhook`, an honest empty list in
`packages/api-management/src/handlers/settings-stubs.ts`. There are no events
to HTTP and no delivery log. The Umbraco importer counts `umbracoWebhook` rows
and does not import them.

## Acceptance criteria

- [x] Webhooks are created, edited and deleted in the backoffice. All 8
      `webhook` operations are real.
- [x] A webhook names events (content and media published, unpublished,
      deleted, and so on), optional content types, headers and a URL.
- [x] Delivery runs as a background job, retries with back-off, and never
      blocks the editor's request.
- [x] Every attempt is kept in a delivery log the backoffice shows.
- [x] In a cluster, an event is delivered once, not once per node.
- [x] Tested on both dialects.

## Out of scope

- Importing Umbraco's webhooks.

## Decisions (2026-10-15)

- **Each webhook chooses where it lives:**
  - "With the site's files", in `schema/webhooks/<name>.toml`. It is
    versioned and deployed with the site, and edited in the backoffice by
    write-back, as forms are. A header value may only name a secret as
    `env:NAME`; a literal is refused.
  - "In this environment only", in the database. A secret may be typed in,
    and is stored encrypted.
  - Both kinds are listed together. A node whose files are read-only offers
    only the second.
- **Bundles handle events through durable handlers on the same queue.** A
  server bundle declares `events: { 'Umbraco.ContentPublish': handler, … }`.
  Each event is queued once per subscriber, as a webhook delivery is. It runs
  once per cluster, after the editor's request, with the same retry and
  back-off, and appears in the delivery log. A handler gets narrow
  capabilities, never the database. This reverses the story's original "out of
  scope" line.
- **The payload is Umbraco's Minimal shape**: the event and the identifiers of
  what changed, with no unpublished content. Event aliases stay Umbraco's
  (`Umbraco.ContentPublish`), because the backoffice client and imported data
  use them.
- **Headers carry no `Umb-` prefix:** `Webhook-Event`, `Webhook-Retry-Count`,
  `Webhook-Id` and `Webhook-Delivery`.
- **Database storage needs `CROMBOLO_SECRET_KEY`.** Typed-in header values are
  encrypted with it. Without it, "in this environment only" is not offered at
  all. A node with neither a key nor writable files refuses to create a
  webhook, and says which setting to add.
- **The choice appears as a panel on the webhook's screen,** "Where it's kept".
  A new webhook starts in this environment when the key is set, otherwise with
  the site's files. The panel moves it to the other store where that store is
  available. A webhook holding a typed-in secret cannot move into the files.

## What was built

- **Migration 035 `AddWebhooks` (release 0.12.0)** adds three tables:
  `webhook` (kept in the environment, headers sealed), `webhook_delivery` (the
  queue) and `webhook_log`.
- **`packages/api-management/src/webhook-events.ts`:** the event catalogue
  (Umbraco aliases), and `webhookEventFor`, a pure function mapping a
  successful operation to the event it raises. The router's `onWebhookEvent`
  hook calls it.
- **`packages/server/src/webhook-files.ts`**, all pure: `webhookProblems` (the
  rules for either store) and `writeWebhookFile`/`parseWebhookFile` for
  `schema/webhooks/<key>.toml`.
- **`packages/server/src/secrets.ts`:** `sealSecret` and `openSecret`, AES-256-GCM
  with `CROMBOLO_SECRET_KEY`.
- **`packages/server/src/webhooks.ts`:**
  - The service: both stores, create, update (a masked value keeps the
    secret), move, raise, deliver, retry and log.
  - Pure functions `subscribersFor`, `eventHappened`, `bundleEventProblems` and
    `webhookStoreView`.
  - `ServerBundle.events`.
- **`packages/data/src/repositories/webhooks.ts`:** the stored webhooks, and
  the delivery queue with its atomic claim and its log.
- **The nine operations** (`handlers/webhook.ts`), the stub removed. API
  coverage is now 508/513; what remains is the five deliberate divergences.
- **The "Where it's kept" panel:** a workspace view on Umbraco's webhook
  workspace (`plugin/webhook-storage.js`), served by
  `<backoffice>/crombolo/api/webhooks/{id}/store`.
- **Jobs:** `runWebhooks` every 15 seconds. Scheduled publishing raises
  publish and unpublish events.
- **Tests:** `tests/webhooks.test.ts`, on both dialects. They cover the event
  mapping, the rules, files round-tripping, sealing, subscribers, the API with
  secrets masked, delivery and its headers and log, retry semantics,
  content-type filtering, scheduled publishing, both stores and moving between
  them, a bundle's handler with retries, and (on Postgres) two nodes delivering
  each event once.

