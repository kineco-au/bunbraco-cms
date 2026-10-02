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

## Git

- Do not commit to Git and do not push to any remotes unless explicitly requested to

## Boundaries

- You must not bring in any dotnet dependencies
