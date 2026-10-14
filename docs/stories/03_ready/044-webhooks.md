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

- [ ] Webhooks are created, edited and deleted in the backoffice. All 8
      `webhook` operations are real.
- [ ] A webhook names events (content and media published, unpublished,
      deleted, and so on), optional content types, headers and a URL.
- [ ] Delivery runs as a background job, retries with back-off, and never
      blocks the editor's request.
- [ ] Every attempt is kept in a delivery log the backoffice shows.
- [ ] In a cluster, an event is delivered once, not once per node.
- [ ] Tested on both dialects.

## Out of scope

- An in-process event API for bundles; that is its own decision.
- Importing Umbraco's webhooks.
