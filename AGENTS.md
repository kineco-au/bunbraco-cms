## Definition of Done

- Run formatting checks and unit tests - all warnings and errors must be fixed
- For new features there must be covering unit tests
- Changes to the repo structure, architecture, or core tool chain should be documented in the README

## Workflow

- Prompt for a decision for all important architectural decisions before starting work
- Push back on any requests which don't make sense or where there's a simpler alternative

## Testing

- Run the bun wrapper scripts don't invoke the test frameworks directly
- Local tests should be run through the docker containers not on the local system
- Run tests in the background and report when complete
- Only run the database dialect tests when the changes impact the data layer
- Don't run the browser playwright tests unless either asked to or explicitly needed to verify changes which can't be verified by the other tests

## Versioning

- A migration's `release` must be a version of this CMS that exists: the release
  it actually ships in, never a number chosen ahead of time. `bun run release:version`
  sets the package version; a migration added before the next release names that
  next version, and nothing later
- `tests/migrations.test.ts` enforces this against the `VERSION` constant, so a
  migration claiming an unreleased version fails the suite rather than landing in
  someone's `migration_history` as a release that was never cut
- These two numbers drifted badly before 0.3.0 — the migrations ran to 0.9.0 while
  the packages sat at 0.2.0 — which is why they are now checked rather than trusted
- `@bunbraco/backoffice-dist` is the one exception to one-version-across-the-set:
  it tracks the Umbraco release it vendors and moves only with
  `release:version --backoffice-dist`

## Git

- Do not commit to Git and do not push to any remotes unless explicitly requested to
- Pushing a `v*` tag publishes to npm (`.github/workflows/release.yml`), so treat
  a tag push as a release, not a bookmark

## Rules

- You must not bring in any dotnet dependencies
- Don't leak implementation details or tech jargon into the user interface - keep the UI user focused.
