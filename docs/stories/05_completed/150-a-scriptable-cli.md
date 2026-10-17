# 150 — A scriptable CLI

**Epic:** P — The command line · **Priority:** should · **Size:** L
**Depends on:** —

## Story

As a developer scripting crombolo — in CI, or through an AI agent — I want every
command to describe itself, emit structured output on request, fail with a
predictable code and never hang waiting for a keyboard, so that I can drive it
without scraping text meant for people.

## Context

[clispec.dev](https://clispec.dev/) (v0.3, a candidate from August 2026) sets a
contract for CLIs that machines drive. It rests on six principles: structured
output, a `schema` command, stdout for data and stderr for everything else,
non-interactive by default, safe retries, and bounded output. Its `clispec score`
tool checks a binary's behaviour at runtime.

`packages/cli/bin/crombolo.ts` was written for people at a terminal. It was
audited against v0.3 on 2026-10-17 at version 0.14.4; the gaps follow. Three
things in it were defects whatever is decided about the spec.

### Defects found during the audit — fixed

Each is now fixed. `packages/cli/src/args.ts` reads the arguments once: it
knows which flags take a value (`upgrade --force` takes a reason; elsewhere
`--force` takes none) and accepts `--flag=value`. `tests/cli-args.test.ts`
checks that every flag the CLI reads is one the parser knows. An unknown flag
exits 2 before anything runs. `--help` or `-h` on a command, or
`crombolo help <command>`, prints that command's part of the help.

1. **`--help` is not handled per command, so it runs the command.**
   `crombolo upgrade --help` applies pending migrations, and it does so
   without an audit entry, because `commandAudit` skips `--help`.
   `crombolo start --help` boots the site. Only an unknown command prints the
   help.
2. **Flag values leak into the positionals.** `positional` is every argument
   that does not start with `--`, so the value of `--env staging` becomes a
   positional. On a site with one remote, `crombolo pull --env staging` treats
   `staging` as the remote's name and exits 2 with "Which remote?". The same
   leak affects every command that reads `positional[n]` after a valued flag.
3. **Unknown flags are ignored silently.** A typo such as
   `crombolo import site.tgz --dyr-run` performs the real import.

What remains for this story: the flags are checked against one list for the
whole CLI, not per command, so a flag that belongs to another command is still
ignored.

### Gaps against the spec

| Principle | clispec v0.3 asks | crombolo today | Gap |
|---|---|---|---|
| Structured output | An explicit format flag (`-o/--output`, `auto` by default) in `global_args`; JSON when piped | `--json` on three commands only: `status`, `import umbraco report` and `maintenance status`. Everything else is text only | Most commands have no structured output. There is no global flag and no `auto` detection. The text default is undeclared. `--json` should stay as a hidden alias |
| Structured output | Collections wrapped as `{"items": [...]}` | `status --json` returns a report object, and there is no JSON list command | Every list (`remote list`, `content runs`, `assets list`, `upgrade ledger`, `domains`, `init --template list`) needs a JSON form in the envelope |
| Structured output | With structured output, the last line of stderr is a one-line error envelope (`kind`, `message`, `hint`, `details`) | Errors are free text on stderr, including `CommandError.problems` | No error kinds and no envelope. `RemoteError` already carries a problem `code`, so the remote commands are closest |
| Structured output | No ANSI codes off a TTY; respect `NO_COLOR` | No colour is used anywhere | Conforms. The box-drawing banner from `start` is plain text |
| Schema | A `schema` command whose output validates against `schema/v0.3.json`; works with no auth, config or network; root `--help` mentions it | `crombolo schema` is schema-as-code (check, sync, export, new, add-property), and on its own it exits 1 | **A name clash: a decision is needed (see below).** There is no machine description of the commands at all |
| Schema | `effects` on every command; `cardinality` and `output_fields` or `stdout_schema` on data commands | Nothing is declared | Every command needs classifying. A first pass is below |
| Schema | Companion `AGENTS.md`/`SKILL.md` | The repo's `AGENTS.md` is for contributors, not CLI users | A short CLI usage note shipped with `@crombolo/cli` |
| Stream separation | Data on stdout; progress, messages and prompts on stderr | Progress goes to stdout: `pull` and `push` job progress (`describeJob`), `media fetch` counts, push-check lines, `wrote …` lines, and the prompts from `prompt()` | Progress and narration move to stderr. Stdout keeps the result alone, such as the printed admin password or the JSON |
| Non-interactive | Never hang without a TTY. A command that would prompt refuses with `confirmation_required` and a hint naming the bypass flag | Most prompts check `process.stdin.isTTY` and refuse. `bundle purge` does not: it calls `prompt()` regardless, so an open but empty stdin pipe hangs it. `push` to a protected environment refuses off a TTY with "Nothing was sent." and does not name `--auto-approve` | Guard `bundle purge`. Name the bypass flag in every refusal. Emit the `confirmation_required` kind once envelopes exist |
| Non-interactive | `requires_tty` for commands that are inherently interactive | `login` polls the device grant and works without a TTY. The passphrase prompts fall back to `CROMBOLO_BUNDLE_PASSPHRASE` | Conforms in behaviour; only the declarations are missing |
| Non-interactive | `--dry-run` for destructive operations | Covered by `content check`, `schema check`, `upgrade --plan`, `import <file>` (prints before asking) and the push check | `bundle purge` prints its plan but has no `--dry-run`. `push` has no flag that runs the check and stops |
| Safe retries | `idempotent` commands exit 0 when already in the requested state; differing config is a `conflict` | `remote add` silently replaces an existing remote with a different URL | `remote add` should refuse a different URL (exit with `conflict`) unless `--force`. A `changed` boolean belongs in JSON results |
| Safe retries | `non_idempotent` commands declare `idempotency_key_arg` | `push`, `pull`, `content import`, `content export` and `export --site` have none. The remote jobs have ids, but a repeat starts a new job | Either an idempotency key on push and pull, passed to the remote, or declare them honestly as non-idempotent without a key. **A decision is needed** |
| Bounded output | `unbounded` lists need cursor or offset pagination, `fields_arg` and in-band truncation | `content runs --limit` (default 20) gives no total, no cursor and no truncation signal. `upgrade ledger` and `assets list` print everything | Pagination and a total on `content runs` and `upgrade ledger`; `--fields` on wide records |
| Exit codes | A declared code per error kind; an unknown command must fail | 87 sites exit 1, 9 exit 2, `remoteExit` uses 1/2/3, and an interrupt exits 130. An unknown command, or no command, prints the help and **exits 0** | Unknown commands exit non-zero. One table of codes, declared in the schema. The existing codes stay as they are: the spec forbids changing them |
| Guidance | `--version` | Not recognised: it prints the help and exits 0 | Add `--version` |
| Guidance | Strict input validation | Unknown flags are refused (defects 2 and 3, fixed) | Validate flags per command, not against one list for the whole CLI |
| Guidance | Secrets never on argv | Passphrases come from `CROMBOLO_BUNDLE_PASSPHRASE` or a prompt, sign-ins from the OS keychain, and the API client from the environment. `admin reset-password [pw]` takes the new password as an argument | Read the password from stdin; keep the argument as a hidden, deprecated form |
| Guidance | `--timeout`; start/status for long jobs | `settle` takes `timeoutMs`, but no flag sets it. On timeout, exit 3 says "the job carries on at the remote", with no command to check on it | `--timeout` on `pull` and `push`, plus `crombolo remote job <id>` to resume watching a job |
| Guidance | Atomic writes, lock files | `remotes.toml`, `.crombolo/remote-media-fetched.json` and `domains.toml` are written in place | Write to a temporary file, then rename |

### A first classification

`start` serves until stopped. It is not a data command; it would be declared
`stream` (its log lines) with `effects: non_idempotent`.

| Effects | Commands |
|---|---|
| `read_only` | `status`, `types check`, `components check`, `assets list`, `content check`, `content runs`, `domains`, `upgrade check`, `upgrade --plan`, `upgrade ledger`, `maintenance status`, `remote list`, `whoami`, `import umbraco report` |
| `idempotent` | `types sync`, `types export`, `generate`, `domains set`, `maintenance pause/resume`, `remote add/remove`, `logout`, `upgrade`, `media fetch` |
| `non_idempotent` | `start`, `init`, `admin reset-password`, `types new`, `types add-property`, `content export/import/publish/unpublish/revert`, `export --site`, `import <file>`, `import umbraco apply`, `bundle purge`, `login`, `pull`, `push` |

## Decisions

Taken on 2026-10-17:

1. **Schema-as-code moves to `crombolo types`** (`types check`, `types sync`,
   `types export`, `types rewrite`, `types new`, `types add-property`,
   `types purge`). That frees `crombolo schema` for clispec. For one release,
   `crombolo schema <one of those>` still works, with a deprecation line on
   stderr. While that alias lasts, `schema export` means `types export`, not
   the clispec schema narrowed to the top-level `export` command. The `schema/`
   directory, `docs/schema-as-code.md` and the concept keep their names; only the
   command changes.
2. **Text stays the piped default.** The schema declares `output.piped: "text"`,
   and JSON comes with `-o json`; `--json` is kept as a hidden alias. Nothing that
   pipes crombolo today changes: CI scripts, `start` into docker logs, or
   `admin reset-password | tail -1`.
3. **The CLI moves onto oclif (`@oclif/core`), with an oclif manifest build.**
   Each command is a class carrying its own description, args and flags, plus
   the clispec properties as extra statics. oclif's manifest builder keeps those
   statics, so the manifest holds everything the clispec schema needs.
4. **Distinct exit codes: a breaking change**, released in a minor version with a
   release note, because scripts that test for `$? -eq 1` or `2` change meaning.
5. **Idempotency keys** for `push` and `pull` are left out: they are declared
   `non_idempotent` without a key, which is an advisory lint, not a conformance
   failure. A key needs a protocol capability (story 107), and that can be its
   own story when someone needs retried pushes.

### Why oclif

A probe under Bun 1.4.2 with `@oclif/core` 5.1.8, on 2026-10-17, found:

- With `topicSeparator: ' '`, `probe content import pkg --env staging` parses
  into `{args: {pkg}, flags: {env}}`.
- An unknown flag fails with `Nonexistent flag: --dyr-run`, exit 2. An unknown
  command exits 2. `--version` works.
- `--help` is generated per command, with usage, flags and description.
- `cacheCommand` copies any extra static property into the manifest, and the
  public `Config.load(dir).commands` returns the same data, so `static effects
  = 'read_only'` reaches both.
- oclif detects Bun and loads `.ts` commands directly, so no build step is
  needed; a command starts in about 50 ms.
- `Command.jsonEnabled()` and the return value of `run()` already split "data"
  from "how it is printed": override `jsonEnabled()` to honour `-o json`, and
  every command returns its result instead of printing it.

The costs:

- `@oclif/core` brings 18 runtime dependencies into `@crombolo/cli`.
- It declares `node >= 22`, which doesn't matter, since the CLI runs on Bun.
- Its help layout replaces the hand-written help text, so that wording moves
  into each command's `description` and `examples`.
- The 104 `process.exit` calls go, replaced by thrown errors that the base
  command maps to a kind and an exit code.

## Plan

Five steps, each shippable and green on its own.

### 1. The move to oclif

- `packages/cli/src/commands/**`: one class per command, laid out as oclif
  topics (`content/import.ts`, `remote/add.ts`, `types/sync.ts`, and so on).
  The handlers move out of `bin/crombolo.ts` without changing what they do; the
  shared helpers (`siteConfig`, passphrases, describing jobs and bytes) go to
  `packages/cli/src/support/`.
- `BaseCommand` (`packages/cli/src/base.ts`):
  - the global flags `-o/--output text|json` and the hidden `--json`;
  - a `jsonEnabled()` override;
  - `catch()`, which maps a thrown `CliError(kind, message, hint)` to its exit
    code and writes the envelope;
  - the audit entry that `commandAudit` writes today, declared per command
    (`static audit = {category, action, entityType}`);
  - `progress()`, which writes to stderr.
- `bin/crombolo.ts` shrinks to `execute({dir: import.meta.url})`. The
  `package.json` `oclif` block holds `bin`, `commands`, `topicSeparator: ' '`
  and the hidden aliases (`bundle install` for `content import`, and the
  `schema <subcommand>` forms).
- `packages/cli/src/args.ts` is deleted: oclif's parser replaces it. The cases
  in `tests/cli-args.test.ts` are kept and run against the real binary.
- `tests/cli-parity.test.ts` spawns every command with `--help`, and checks each
  documented flag against a table copied from today's help text before it is
  deleted, so the move cannot drop a flag.

### 2. The schema command and the manifest

- `crombolo schema [<command path>]` turns `Config.load().commands` into a
  clispec v0.3 document; given a path, it narrows to that command. It touches
  no config, no network and no sign-in.
- `bun run cli:manifest` writes `packages/cli/oclif.manifest.json`, which oclif
  then loads instead of importing every command. `scripts/publish-packages.ts`
  runs it before packing; the file is ignored by git, and a test fails when it
  is stale against the commands.
- The v0.3 schema is vendored as `tests/fixtures/clispec-v0.3.json`.
  `tests/cli-schema.test.ts` validates `crombolo schema` against it with `ajv`
  (a new devDependency), and also checks the rules JSON Schema cannot express:
  unique exit codes between errors and outcomes, and every referenced arg
  declared.
- The rename to `types`: about 40 references across six docs, five package
  sources (the server's messages that say to run `crombolo schema sync`), one
  script and three integration tests.

### 3. Structured output

- Every data command returns a typed result, and declares its `outputFields`
  (or a `stdoutSchema` where the shape depends on the input), its `cardinality`
  and its `effects`.
- Lists return `{items, total?, cursor?}`.
- Narration and progress go through `progress()` to stderr: `pull`/`push` job
  states, `media fetch` counts, the push check, and `wrote …`. Stdout carries the
  result alone.
- In JSON mode, a failure's last stderr line is
  `{"kind","message","hint"?,"details"?}`. `RemoteError` maps its problem code
  onto a kind, and `CommandError.problems` becomes `details`.

### 4. Non-interactive and safe retries

- **Prompts.** One `confirm(question, bypassFlag)` helper. Off a TTY it throws
  `confirmation_required`, with a hint naming the bypass flag, and never reads
  stdin. It covers:

  | Command | Bypass flag |
  |---|---|
  | `bundle purge` | `--yes` |
  | `import --replace-all` | `--yes` |
  | `pull` replacing a site | `--yes` |
  | `push` to a protected environment | `--auto-approve` |

  Each command declares its bypass flag as `confirmationBypassArg`.
- **`--dry-run`** on `bundle purge`, and on `push`, where it runs the push
  check and stops.
- **`remote add`:** a different URL for an existing name is a `conflict`, unless
  `--force`. JSON results from mutating commands include `changed`.
- **`--timeout <seconds>`** on `pull` and `push`, and
  `crombolo remote job <id> [<remote>]`, which resumes watching a job.
- **Pagination.** `content runs` and `upgrade ledger` take `--limit` and
  `--cursor` and report `total`. `--fields` on wide records.
- **The admin password.** `admin reset-password` reads a new password from
  stdin; the argument form stays, hidden and deprecated.
- **Atomic writes** for `remotes.toml`, `domains.toml` and the files under
  `.crombolo/`: write to a temporary file, then rename.

### 5. Checking it in CI

- A CI step installs the checker (`cargo install clispec`, cached) and runs
  `clispec score` against the CLI. It runs in CI only; the Release workflow
  doesn't need it.

### Exit codes (decision 4)

| Code | Kind or outcome | Today |
|---|---|---|
| 0 | success | 0 |
| 1 | `internal`: anything unexpected | 1, nearly everything |
| 2 | `usage`: bad arguments, unknown command or flag | 2 for some refusals, 0 for an unknown command |
| 3 | `timeout`: gave up waiting; the job carries on at the remote | 3 |
| 4 | `auth`: not signed in, or the sign-in has lapsed | 2 |
| 5 | `not_found`: no such remote, environment, page, run or bundle | 1 or 2 |
| 6 | `conflict`: someone else's change, or a different existing value | 1 |
| 7 | `confirmation_required` | 1 or 2 |
| 8 | `refused`: the site or the remote said no (permissions, a protected environment, a blocked upgrade) | 1 or 2 |
| 9 | `unavailable`: the database or the remote could not be reached | 1 |
| 10 | `io`: a file could not be read or written | 1 |
| 20 | outcome `problems_found`: `status`, `types check` and `components check` found something | 1 |
| 21 | outcome `blocked`: `content check` or `import umbraco report` found something a person must resolve first | 1 |
| 130 | `interrupted` | 130 |

Outcomes write no error envelope; their findings are the command's normal
output.


## Acceptance criteria

- [x] `--help` on any command prints that command's help and runs nothing
- [x] Flag values never appear as positionals; an unknown flag exits non-zero
- [x] The CLI runs on oclif, with flags validated per command; `--version` works;
      an unknown command exits 2
- [x] `oclif.manifest.json` is built before publishing, and a test catches it
      going stale
- [x] Schema-as-code is `crombolo types …`, and `crombolo schema <subcommand>`
      still works for one release, with a deprecation notice
- [x] A global `-o/--output text|json`, with text the declared piped default;
      `--json` stays as a hidden alias; lists use `{"items": [...]}`
- [x] Errors carry a declared kind and the exit code from the table above, with a
      one-line JSON envelope as the last line of stderr in JSON mode; the change
      is in the release notes
- [x] Progress, narration and prompts go to stderr on every command
- [x] Every prompt refuses off a TTY with `confirmation_required`, naming its
      bypass flag; `bundle purge` no longer reads stdin off a TTY
- [x] `crombolo schema [<path>]` validates against clispec v0.3, works with no
      config, network or sign-in, and is mentioned in the root help
- [x] `remote add` refuses a different URL for an existing name without `--force`
- [x] `--dry-run` on `bundle purge` and `push`; the admin password read from stdin;
      atomic writes for the files the CLI keeps
- [x] `content runs` and `upgrade ledger` paginate and report a total
- [x] `--timeout` on `pull` and `push`, and a way to resume watching a remote job
- [x] `clispec score crombolo` passes in CI
- [x] An HTML page generated from the CLI manifest's data — every command, its
      arguments, what it changes and the exit codes — is deployed as part of the
      product site, and a test fails when the commands change and the page has
      not been rebuilt

## What was built

Steps 1, 3 and 4 of the plan landed together: each command was written once, in
its final shape, rather than moved and then reworked twice.

- **The commands.** `packages/cli/src/commands/**`, one oclif class per command,
  each declaring its clispec `spec` (effects, cardinality, output fields, error
  kinds, outcomes, confirmation bypass, pagination) and, where it changes
  something, its `audit` entry. `crombolo components`, `domains` and `assets`
  on their own are hidden subclasses of `check`/`list`. The old names —
  `schema check` and the rest, `bundle install|check`, `upgrade schema` — are
  oclif aliases, the renamed ones with `deprecateAliases`.
- **The base.** `packages/cli/src/base.ts`: `-o text|json` and the hidden
  `--json`; `say` (the result, stdout, text mode only), `progress` and `warning`
  (stderr, both modes); `catch` maps any error through `classify.ts` to a kind
  and exits with its code; an outcome (`this.outcome`) exits after the JSON is
  written. `packages/cli/src/main.ts` runs oclif and reports a failure before
  any command — an unknown command — the same way.
- **The envelope** is `{"error": {"kind", "message", "hint"?, "details"?,
  "exit_code", "retryable"?}}`, the shape the spec's checker reads. It is the last
  line of stderr in JSON mode, and also in text mode whenever stderr is not a
  terminal, so a script reading a pipe can branch on it without asking for JSON.
- **The schema.** `packages/cli/src/clispec.ts` builds the document from the
  loaded commands (or the manifest's data); `crombolo schema` prints it.
  `tests/fixtures/clispec-v0.3.json` is the spec's schema, vendored, and
  `tests/cli.test.ts` validates against it with `ajv`, plus the rules JSON
  Schema cannot say.
- **The manifest.** `packages/cli/src/manifest.ts` builds it; `bun run
  cli:manifest` writes it; `scripts/publish-packages.ts` writes it into the CLI
  package for the length of its pack and removes it again, so no working tree
  holds a stale one. With it a command starts in about 40 ms rather than 150.
- **Safety.** `support/prompt.ts` `confirm()` asks on stderr, refuses at once
  with no terminal, and never reads stdin. `writeFileAtomic` in
  `@crombolo/server` writes `remotes.toml`, `domains.toml` and the files under
  `.crombolo/`. `RefusedBeforeSending` carries a kind; `discover` fails with
  typed `RemoteError`s (`unreachable`, `not-a-remote`, `protocol-version`).
  `remote remove` of an absent remote now succeeds, changing nothing.
- **The page.** `packages/cli/src/reference.ts` writes the reference as HTML
  from the manifest's data; `bun run build:template demo/crombolo` puts it in the
  product site's bundle as **Developers › Command line**, a `developerPage` (so
  the content-only bundle imports into the platform's copy of the site as it
  stands), whose view now leaves out a section with no heading.
  `tests/cli-reference.test.ts` fails when the commands change and the page has
  not been rebuilt. Story 157 builds this out into a docs section.
- **CI.** The `clispec` job in `ci.yml` fetches the checker (pinned by version
  and hash) and fails unless every check passes: 24/24 at this release.
