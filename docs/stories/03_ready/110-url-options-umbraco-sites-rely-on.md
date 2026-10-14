# 110 — URL options Umbraco sites rely on

**Epic:** L — Routing · **Priority:** could · **Size:** S
**Depends on:** —

## Story

As a developer moving an Umbraco site here, I want the URL options it was built
with — the top-level page in the path, right-to-left segment order — so that
its addresses stay the same.

## Context

URLs follow Umbraco's default `HideTopLevelNodeFromPath = true`; there is no
switch to show the top level, and RTL segment order is not ported
([`../../rendering.md`](../../rendering.md), "URLs"). Changing either
changes every URL, so the redirect tracker has to see it as a rename.

## Acceptance criteria

- [ ] A site setting shows the top-level page in paths; the default is
      unchanged.
- [ ] Segments of a right-to-left culture are ordered as Umbraco orders them.
- [ ] Changing either setting records redirects from the old URLs.
- [ ] The importer carries the source site's setting across.

## Out of scope

- Other `Umbraco:CMS:RequestHandler` options.
