# 142 — Blogging basics: taxonomies, archives and feeds

**Epic:** O — Building a site · **Priority:** should · **Size:** M
**Depends on:** —

## Story

As a site owner moving from WordPress, I want categories and tags with their
own pages, archives by date and author, and RSS and Atom feeds, so that a blog
works here without each one being built by hand.

## Context

The pieces exist separately: the tags editor, content pickers, the router, and
`/sitemap.xml` (`packages/render/src/sitemap.ts`). What is missing is the
convention that joins them, which WordPress gives every site for free. No feed
is produced today.

## Acceptance criteria

- [ ] A taxonomy (categories, hierarchical; tags, flat) is declared in
      `schema/` and editable in the backoffice, assignable to pages by a property.
- [ ] Each term has a page at a configurable route (`/category/<slug>`,
      `/tag/<slug>`), rendered by a component with the term's pages, paged.
- [ ] Archives by year and month, and by author, at configurable routes.
- [ ] RSS 2.0 and Atom feeds for the site, each taxonomy term and each author,
      listed in the page head, with full text or excerpt as configured.
- [ ] A blog starter template uses all of it.
