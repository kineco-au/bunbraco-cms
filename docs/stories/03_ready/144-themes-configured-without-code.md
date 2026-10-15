# 144 — Themes configured without code

**Epic:** O — Building a site · **Priority:** could · **Size:** L
**Depends on:** —

## Story

As someone setting up a site without a developer, I want to pick a theme and
change its colours, fonts, logo and layouts in the backoffice with a live
preview, so that a crombolo site does not need TSX to look like mine.

## Context

A site's look is its components, written in TSX, so changing it needs a
developer; WordPress's themes and its site editor are why non-developers choose
it. Starter templates (`crombolo init --template`) already ship schema,
components, styles and content as a bundle — a theme is a starter template
whose components read their design from settings rather than hard-coding it.

## Acceptance criteria

- [ ] A theme declares its settings — colours, fonts, logo, spacing, header and
      footer layouts — and its components read them as CSS variables and props.
- [ ] A backoffice screen edits them with a live preview of the site, and
      publishes them like content: draft, publish, roll back.
- [ ] Themes are bundles: installed from the marketplace, switched without
      losing content, with a developer free to take one over as code.
- [ ] At least two themes ship, covering a brochure site and a blog.

## Out of scope

- Free-form page building by drag and drop on the page. Block Grid is the
  layout tool; a visual editor over it is a story of its own.
