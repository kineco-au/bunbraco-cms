# Webhooks

A webhook calls a URL when content changes, so a search index, a cache or a
build pipeline can react without polling (story `044`). A server bundle can
handle the same events in code.

## What a webhook is

A URL, the events it hears, optionally the content types it cares about, and
headers to send. It is edited in Settings → Webhooks, Umbraco's own screens,
through the Management API's webhook operations.

| Event | Raised by |
| --- | --- |
| `Umbraco.ContentSaved` | creating or saving a page |
| `Umbraco.ContentPublish` | publishing, by hand or on schedule |
| `Umbraco.ContentUnpublish` | unpublishing, by hand or on schedule |
| `Umbraco.ContentDelete` | deleting a page, from the bin or directly |
| `Umbraco.ContentMovedToRecycleBin` | moving a page to the bin |
| `Umbraco.ContentMoved` | moving a page |
| `Umbraco.ContentCopied` | copying a page |
| `Umbraco.MediaSave` | creating or saving a media item |
| `Umbraco.MediaDelete` | deleting a media item |

The aliases are Umbraco's, so the backoffice's event picker and an imported
site mean the same thing. An event is raised only when the change really
happened. A publish request that only schedules a publish raises nothing until
the schedule runs, and then raises the same event as a publish by hand.

A webhook limited to some content types still hears about a deleted item whose
type can no longer be read. A missed delete is worse than an extra one.

## Where a webhook is kept

Each webhook chooses, on its screen's **Where it's kept** panel:

- **With the site's files**, as `schema/webhooks/<key>.toml`. It is versioned
  and deployed with the site, and a backoffice edit writes the file back, as a
  form's does. A header that carries a secret names a server setting instead:
  `Authorization = "env:SEARCH_TOKEN"`. A typed-in value is refused, so a
  secret never reaches a repository.
- **In this environment only**, in the database. A secret may be typed in.
  The headers are sealed with AES-256-GCM using `CROMBOLO_SECRET_KEY` (32+
  characters), which lives only in the environment, so a database dump alone
  reveals nothing. Without that key this store is not offered.

A new webhook starts in this environment when the key is set, otherwise with
the files. A node with neither refuses to add one, and says which setting to
add. A webhook holding a typed-in secret cannot move into the files until the
header names a setting instead.

A typed-in secret never comes back from the server: the backoffice sees
`********`, and sending that back keeps what is stored. An `env:` reference is
not a secret, so it is shown as written.

```toml
[webhook]
key = "5d3c1a2b-0044-4c1a-9e7d-3a5b8c2d4e44"
name = "Search index"
url = "https://search.example/hook"
events = ["Umbraco.ContentPublish", "Umbraco.ContentDelete"]
content-types = ["0c1d2e3f-4a5b-4c6d-8e7f-001122334455"]

[webhook.headers]
Authorization = "env:SEARCH_TOKEN"
```

## What is sent

A `POST` of Umbraco's Minimal payload, the item's key: `{ "Id": "<key>" }`.
The receiver fetches what it needs, and nothing unpublished leaves the site.
Every delivery carries:

| Header | Value |
| --- | --- |
| `Webhook-Event` | the event alias |
| `Webhook-Retry-Count` | 0 on the first attempt |
| `Webhook-Id` | the webhook's key |
| `Webhook-Delivery` | this delivery's id, the same on every retry, for de-duplication |

Umbraco's `Umb-` prefix is not used. A webhook may not set these, nor
`Content-Type` or `Host`, itself.

## Delivery

The change queues a delivery for each listening webhook and bundle handler
once the editor's request has answered, so a slow receiver never holds anyone
up. The queue (`webhook_delivery`) is drained every 15 seconds by the
background jobs, on the nodes that run them. Each row is claimed with
`UPDATE … WHERE state = 'pending' … RETURNING`, so on a cluster exactly one
node delivers it.

- **2xx** is delivered.
- **5xx, 408, 429, a timeout (30 s) or a network failure** is retried, at 1,
  5, 15 and 60 minutes, five attempts in all, as form workflows are.
- **Any other status** is not retried: the receiver refused, and will again.
- **An `env:` setting that is not set** fails at once and says which.

Every attempt is in the delivery log (`webhook_log`), which the backoffice
shows per webhook and for all of them. It holds the status, the request body,
the response and the names of the headers sent. Header values are masked.

## A bundle's handlers

A server bundle declares handlers by event alias:

```ts
export const hooks = (): ServerBundle => ({
  id: 'acme-hooks', section: 'settings', capabilities: [], routes: [],
  events: {
    'Umbraco.ContentPublish': async ({ payload, attempt, fetch, log, signal }) => {
      await fetch('https://cdn.example/purge', { method: 'POST', body: payload.Id })
      return { ok: true }        // or { ok: false, error, retry }
    },
  },
})
```

Each event reaches each handler through the same queue as a webhook: once per
cluster, after the change, with the same retries, and in the delivery log
under `bundle:<id>`. A throw counts as a failure worth retrying. A handler is
given the event, the payload, the attempt number, `fetch`, a log named for the
bundle and a signal that aborts after 30 seconds. It never gets the database.
A bundle naming an event this site does not raise refuses the boot, by name.
