# 087 — A ready-to-run container image

**Epic:** I — Hardening · **Priority:** should · **Size:** M
**Depends on:** —

## Story

As someone running crombolo on my own cloud account, I want to start it from a
published container image, so that I can stand a site up from my provider's
console without building an image myself.

## Context

Story `080` decided there is no install wizard. A clickops install is a
container started from a cloud console with environment variables filled in,
then the "Set up your new site" screen. That only works if there is an image to
start. The images in `docker/` are for development and testing: they run over a
bind mount of the source and install dependencies at start.

## Acceptance criteria

- [ ] An image published on each release, tagged with the release version, that
      starts `crombolo start` from an empty directory with no source mounted.
- [ ] It runs as a non-root user and keeps state (SQLite file, media, logs) under
      one volume path, documented.
- [ ] A site's own schema, components and bundles can be layered on top in a
      short documented Dockerfile, for the pipeline route.
- [ ] Started with only `CROMBOLO_SETUP_CODE` set, it reaches "Set up your new
      site"; with Postgres variables set, it uses Postgres.
- [ ] `/health` is the container health check.
