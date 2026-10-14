# 042 — Redirects and the URL tracker

**Epic:** E — Cross-cutting · **Priority:** must · **Size:** M
**Depends on:** —

## Story

As a site owner, I want a renamed or moved page's old URL to redirect to where
it is now, and I want to configure redirects of my own, so that a change in the
backoffice never turns a published link into a 404.

## Context

Taken first of the remaining cross-cutting work because it is the only gap that
breaks a site *after* launch, and silently: renaming a published page left its
old URL a 404, with nothing in the backoffice to say so.

## Acceptance criteria

- [x] Publishing a rename or a move records a redirect from every old route in
      the branch to the page.
- [x] Redirects configured in `crombolo.config.ts` are in force, and listed in
      the dashboard with the tracked ones.
- [x] All five `redirect-management` operations are real.
- [x] Proven on both dialects.

## As built

**Storage.** Migration 015's `redirect_url` is Umbraco's `umbracoRedirectUrl`,
widened twice, both times for configured rules rather than tracked ones:

- A rule may match an exact route, a subtree or a regular expression.
- It may point at a document, a path or an external URL.

Umbraco resolves duplicate rows by taking the most recent. Here a rule is
identified by what it matches (kind, pattern, hostname root and culture),
hashed into `match_hash` because a unique index cannot deduplicate over
nullable columns. Re-registering a route therefore replaces where it points
instead of stacking rows behind it: the same observable behaviour, with
bounded growth.

**The tracker** (`packages/server/src/redirects.ts`) captures a branch's routes
before a publish or a move and compares them after. That is the shape Umbraco's
notification pair forces, because a route comes from names and tree position
and cannot be recovered once they have changed.

- It covers the page and every published descendant, per culture.
- Moves into the recycle bin record nothing, as upstream: a trashed page has no
  new URL.
- A reverted rename removes the rule that would point the live URL at itself.
- Tracked rules name the *document*. Two renames therefore leave the oldest URL
  resolving to wherever the page is now, rather than chaining 301s.
- A rule whose page is unpublished stops matching, instead of sending visitors
  nowhere.
- **Sorting is tracked too, which Umbraco does not do.** Under
  `HideTopLevelNodeFromPath` the first root page is `/` and the others are
  `/<segment>`, so re-ordering the roots moves them. The capture is by parent
  there, since the write is on the parent and the URLs that move belong to its
  children.

**Configured redirects** are `redirect()` in `crombolo.config.ts`. Umbraco has
no equivalent; it expects a rewrite rule in front of the site. Three decisions:

- They are **synced into the database at boot**, so the dashboard lists
  everything in force in one place. The API answers 409 rather than deleting
  one, because the next boot would put it back.
- They are matched **only once route resolution has found no page**, so a rule
  can sit in config for years without hiding live content.
- A `{ document }` target is resolved per request, so it survives the page
  being renamed.

**Matching** lives in the published cache, which already holds the route table
and is already dropped on a publish, a cache instruction or a schema change.
The 301 carries the query string and is uncacheable, both as Umbraco sends
them. The second matters because browsers cache 301s hard enough that a
rename-and-revert would otherwise stick.

**The dashboard** is Umbraco's own, in the Content section, plus the per-page
Info tab list. `POST status` is an accepted no-op, which is what Umbraco made
it in v17, when it moved tracking to configuration and deprecated the client's
`setStatus`.

**Tests.** Pinned by `tests/redirects.test.ts` on both dialects:

- a rename, a move with its branch, a root re-order, two renames in a row and a
  reverted rename
- tracking turned off
- a hostname scoping a rule to one of two sites with the same path, and one
  culture redirected without the other
- the three pattern kinds
- a document target following a rename, and going quiet when unpublished
- a live page beating a configured rule
- the boot sync removing a rule dropped from config
- the dashboard's list, filter, per-document read and delete refusal

API coverage reached 426/513.

## Out of scope

- Importing an Umbraco site's redirects, which is 071.
