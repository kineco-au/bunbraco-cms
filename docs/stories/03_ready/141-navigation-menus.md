# 141 — Navigation menus

**Epic:** O — Building a site · **Priority:** should · **Size:** M
**Depends on:** —

## Story

As an editor, I want to build the site's menus — header, footer, any other —
by picking and ordering pages and links, so that changing navigation does not
need a developer.

## Context

Today navigation is whatever a component derives from the tree, with
`umbracoNaviHide` to leave a page out ([`seo.md`](../../seo.md)). WordPress
editors expect a menu editor, and story `073` needs somewhere to put the menus
it imports. A multi-URL picker property on a settings node is the usual
Umbraco answer; a first-class menu is easier for editors and for importers.

## Acceptance criteria

- [ ] Menus are named, per culture, made of pages, external links and labels,
      nested to any depth, edited by drag and drop in the backoffice.
- [ ] A menu item that names a page follows it when it is renamed or moved, and
      drops out while it is unpublished or trashed.
- [ ] Components read a menu by name (`menu('header')`), cached with the
      published content; the Delivery API serves them.
- [ ] Menus travel in bundles and content transfer.
- [ ] A starter template uses one for its header.
