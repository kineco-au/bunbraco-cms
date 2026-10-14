# 002 — The backoffice boots

**Epic:** A — Foundations · **Priority:** must · **Size:** M
**Depends on:** 001

## Story

As an editor, I want the Umbraco backoffice to load its shell from this server
and send me to sign in, so that there is a real backoffice to build every
other feature into.

## Context

The backoffice is a single-page app that needs a small set of endpoints before
it renders anything: static serving with the cache-bust prefix, an import map,
the SPA shell, the manifests, server status, configuration and information,
cultures and languages, and a `user/current` good enough to draw the chrome.
This story is that minimum, and nothing more.

## Acceptance criteria

- [x] Static serving with the cache-bust prefix, import-map generation and the
      SPA shell.
- [x] `manifest/*`; `server/status`, `server/configuration`,
      `server/information`; `culture`, `language`; a `user/current` shape that
      renders the chrome.
- [x] `<umb-app>` redirects an unauthenticated visitor to the login page.
      Closed in 003: authorize sends an anonymous browser to `/umbraco/login`,
      which signs in and resumes the flow.
- [x] `<umb-app>` renders its shell with no console errors. *Verified only by
      the module-graph crawl below: no real browser was available in the
      session that built this.*

## As built

- `packages/backoffice-host`: cache-busted static serving, import-map
  generation from package manifests, both SPA shells, branding graphics.
- `packages/auth`: definitive token rejection, so the client stops retrying.
- Handlers: `server/status|configuration|information`,
  `manifest/manifest{,/public,/private}`, `culture`, `language`,
  `item/language/default`, `user/current`.
- Contract-driven authorisation, and `bun run dev`.
- 10/513 operations implemented; 104 tests green on both dialects.
- The whole module graph resolves: 6,556 modules crawled from the entry point
  through the served import map, 0 broken, 0 unresolved. The boot probes
  return contract-correct bodies.
