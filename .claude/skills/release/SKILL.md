---
name: release
description: Cut a crombolo release, push it, and watch CI and the Release pipeline until both are green, bumping the patch version and re-releasing each time a fix is needed. Use when asked to cut, ship or publish a release, or to get a failing release pipeline green.
---

# Releasing crombolo

Pushing a `v*` tag publishes to npm (`.github/workflows/release.yml`). A tag is
a release, not a bookmark: never move, delete or re-push a tag that has been
pushed. A failed release is fixed by a **new** patch version.

## Before starting

1. **Only release finished work.** Run `git status`. Unfinished work in the tree
   (a story still in `docs/stories/04_in_progress/`, or half-built changes) is
   stashed first with `git stash push -u -m "wip before release <version>"` and
   restored after the release with `git stash pop`. Say what was stashed.
2. **Know the starting version:** `git tag --sort=-creatordate | head -3` and
   `grep -n "VERSION = " packages/server/src/config.ts`. The next release is the
   version asked for, or the latest tag's patch + 1.
3. **Migrations:** any migration added since the last tag names this release in
   its `release` field (`AGENTS.md`, "Versioning"). Check with
   `git diff <last-tag> --stat -- packages/data/src/schema`.

## Cut it

1. Check locally first, through docker:
   - `bun run check`
   - `docker compose run --rm cms-test-sqlite bun run test`
   - the integration suite when the CLI changed:
     `docker compose run --rm cms-test-sqlite bun run test:integration`
   - a failing browser test, alone:
     `docker compose run --rm cms-test-browser bun run test:browser <file>`
2. `bun run release:version <version>`, then `bun install` so `bun.lock` agrees.
3. Commit everything the bump touched with the fix:
   `git commit -am "<what changed>; bump version->v<version>"`.
4. `git tag v<version>` and `git push origin main v<version>`.

## Watch it

Both workflows start from the push: **CI** (for `main`) and **Release** (for the
tag, which runs CI again with the browser suite and Postgres, then publishes).

```bash
gh run list --limit 4 --json databaseId,workflowName,headSha,status,conclusion
gh run watch <run-id> --exit-status        # one per workflow; run in the background
gh run view <run-id> --log-failed | grep -E "\(fail\)|✘|Expected|Received|##\[error\]"
```

A browser failure leaves `browser-report` as an artifact. Each failure's
`error-context.md` holds the page snapshot:
`gh run download <run-id> -n browser-report`.

## When either fails

1. Read the failure. A test can be stale rather than the code wrong, so check
   what changed since the last green release before choosing which to fix.
2. Fix it, and verify that fix locally as above.
3. Bump the **patch** version (0.14.1 → 0.14.2), commit, tag and push, as in
   "Cut it". Never reuse the failed version's tag.
4. Watch both workflows again. Repeat until CI and Release are both green.

## Finish

- `gh run list --limit 4` shows both workflows `success` for the last tag.
- `git stash pop` if anything was stashed. Then check
  `git diff --stat`, and resolve any version-line conflicts in favour of the
  released version.
- Report:
  - the version released;
  - each failure, and the fix that cleared it;
  - the runs that went green;
  - anything stashed and restored.
